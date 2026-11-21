// Embed blocks, resolved on the server for the viewer who asks.
//
// - The document is client-writable, so an embed's props are only ever read
//   here, from the document the route names (the host), after the viewer's
//   access to it is checked. Nothing a client sends picks the URL or the
//   target document.
// - A link card is fetched here (`safeGet`: public addresses only, 5 s, small)
//   and cached; the browser is handed text and one inlined image and never
//   fetches the linked page.
// - Another Primer document is read with the viewer's own permissions: no read
//   access, a missing document and a deleted one all answer `none`, so an embed
//   can't be used to probe which documents exist.
import { parse } from 'parse5';
import { eq } from 'drizzle-orm';
import type { EmbedResponse } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { safeGet, type SafeResponse } from '../lib/safeFetch.ts';
import { findLiveBlock, liveDocAccess, refuse, validBlockId, type Result } from './blockTools.ts';
import { readBlocks } from './editor.ts';
import { plainText } from './export.ts';
import { withLiveDocument } from './instance.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_TIMEOUT_MS = 5_000;
const PAGE_BYTES = 512 * 1024;
const IMAGE_BYTES = 256 * 1024;
const EXCERPT_CHARS = 400;
const CACHE_TTL_MS = 60 * 60_000;
const FAILED_TTL_MS = 5 * 60_000;
const CACHE_MAX = 500;
/** Inlined images dominate an entry; the cache holds at most this many bytes of them. */
const CACHE_BYTES = 16 * 1024 * 1024;

export type Page = (url: string, opts: { timeoutMs: number; maxBytes: number; accept: string }) => Promise<SafeResponse>;
type CardBody = Omit<Extract<EmbedResponse, { kind: 'link' }>, 'echo'>;

const cache = new Map<string, { at: number; ttl: number; size: number; card: Promise<CardBody> }>();

/** What embed `blockId` of `documentId` shows `actor`. */
export async function resolveEmbed(
  actor: AuthUser,
  documentId: string,
  blockId: string,
  page: Page = safeGet,
): Promise<Result<EmbedResponse>> {
  const access = await liveDocAccess(documentId, actor);
  if (!access.ok) return access;
  if (!validBlockId(blockId)) return refuse('bad_request', 'blockId is not a block id.');
  const props = await withLiveDocument(documentId, (doc) => findLiveBlock(doc, blockId, 'embed')?.block.props as Record<string, unknown> | undefined);
  if (!props) return refuse('not_found', 'Embed block not found.');
  const url = typeof props.url === 'string' ? props.url : '';
  const target = typeof props.documentId === 'string' ? props.documentId.toLowerCase() : '';
  const echo = { url, documentId: target };

  if (target) {
    // An embed of the document it is in would only repeat it.
    const shown = UUID.test(target) && target !== documentId ? await embeddedDocument(actor, target) : null;
    return { ok: true, value: shown ? { echo, kind: 'document', ...shown } : { echo, kind: 'none' } };
  }
  if (!url) return { ok: true, value: { echo, kind: 'none' } };
  const card = await linkCard(url, page);
  return { ok: true, value: card ? { echo, ...card } : { echo, kind: 'none' } };
}

/** Title and a short plain-text excerpt of a document the actor can read, or null. */
async function embeddedDocument(actor: AuthUser, targetId: string): Promise<{ documentId: string; title: string; excerpt: string } | null> {
  // Scoped by the viewer's access to the target, not by anything in the host.
  const [doc] = await db
    .select({ title: documents.title, uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt, format: documents.format })
    .from(documents)
    .where(eq(documents.id, targetId));
  if (!doc || doc.deletedAt !== null) return null;
  const role = await loadEffectiveRole({ id: targetId, uploaderId: doc.uploaderId, visibility: doc.visibility as Visibility }, actor);
  if (!canRead(doc.visibility as Visibility, role)) return null;
  const excerpt = doc.format
    ? await withLiveDocument(targetId, (live) =>
        readBlocks(live, 'main')
          .map(plainText)
          .filter((t) => t.length > 0)
          .join('\n')
          .slice(0, EXCERPT_CHARS),
      )
    : '';
  return { documentId: targetId, title: doc.title, excerpt };
}

/** The card for a link: cached, one fetch at a time per link, never throws. */
async function linkCard(url: string, page: Page): Promise<CardBody | null> {
  if (url.length > 2000) return null;
  const now = Date.now();
  let entry = cache.get(url);
  if (!entry || now - entry.at > entry.ttl) {
    const card = fetchCard(url, page);
    entry = { at: now, ttl: CACHE_TTL_MS, size: 0, card };
    cache.set(url, entry);
    const added = entry;
    void card.then((c) => {
      // A failed fetch is retried sooner than a good card.
      if (!c.title && !c.description && !c.image) added.ttl = FAILED_TTL_MS;
      added.size = (c.image?.length ?? 0) + 2_000;
      trimCache();
    });
    trimCache();
  }
  return entry.card;
}

/** Drops the oldest entries past the count and the byte budget. */
function trimCache(): void {
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.size;
  for (const [key, entry] of cache) {
    if (cache.size <= CACHE_MAX && bytes <= CACHE_BYTES) break;
    cache.delete(key);
    bytes -= entry.size;
  }
}

async function fetchCard(url: string, page: Page): Promise<CardBody> {
  const bare: CardBody = { kind: 'link', url, title: '', description: '', siteName: '', image: null };
  try {
    // One deadline for the page and its image together.
    const deadline = Date.now() + FETCH_TIMEOUT_MS;
    const res = await page(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: PAGE_BYTES, accept: 'text/html,application/xhtml+xml' });
    if (res.status < 200 || res.status >= 300 || !/html/.test(res.contentType)) return bare;
    const meta = readMeta(res.body.toString('utf8'));
    const left = deadline - Date.now();
    const image = meta.image && left > 0 ? await fetchImage(meta.image, res.url, left, page) : null;
    return { kind: 'link', url, title: meta.title, description: meta.description, siteName: meta.siteName, image };
  } catch {
    return bare;
  }
}

/** The page's own words about itself: Open Graph, then Twitter and plain tags. Short, plain text. */
export function readMeta(html: string): { title: string; description: string; siteName: string; image: string } {
  const meta = new Map<string, string>();
  let title = '';
  const visit = (node: Node): void => {
    if (node.nodeName === 'meta') {
      const attrs = Object.fromEntries(node.attrs.map((a) => [a.name, a.value]));
      const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
      if (key && attrs.content !== undefined && !meta.has(key)) meta.set(key, attrs.content);
    } else if (node.nodeName === 'title' && !title) {
      title = node.childNodes.map((c) => ('value' in c ? String(c.value) : '')).join('');
    }
    if (node.nodeName !== 'body') for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html) as unknown as Node);
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v !== undefined && v.trim() !== '') ?? '';
  return {
    title: clean(first('og:title', 'twitter:title') || title, 200),
    description: clean(first('og:description', 'twitter:description', 'description'), 400),
    siteName: clean(first('og:site_name'), 100),
    image: first('og:image', 'og:image:url', 'twitter:image').trim().slice(0, 2000),
  };
}

type Node = { nodeName: string; attrs: { name: string; value: string }[]; childNodes: Node[]; value?: string };

function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufffd]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The card image as a `data:` URI, or null. Raster formats only, by content: a page can't send SVG or script through here. */
async function fetchImage(src: string, base: string, timeoutMs: number, page: Page): Promise<string | null> {
  try {
    const url = new URL(src, base).href;
    const res = await page(url, { timeoutMs, maxBytes: IMAGE_BYTES, accept: 'image/png,image/jpeg,image/webp,image/gif' });
    if (res.status < 200 || res.status >= 300) return null;
    const type = sniffImage(res.body);
    return type ? `data:${type};base64,${res.body.toString('base64')}` : null;
  } catch {
    return null;
  }
}

function sniffImage(b: Buffer): string | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
