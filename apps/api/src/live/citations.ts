import { sql } from 'drizzle-orm';
import type { CitationDTO, CitationsResponse, Target } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { fenceUntrusted } from '../lib/untrusted.ts';
import { liveBlocks, liveDocAccess, type Result } from './blockTools.ts';
import { withLiveDocument } from './instance.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[1-9]\d{0,8}$/;
const MAX_QUOTE = 2000;

type CitedDoc = { title: string; versions: Map<number, string>; latest: number | null };

/** A Primer document the actor can read, with its versions; null otherwise. */
async function citedDoc(actor: AuthUser, docId: string): Promise<CitedDoc | null> {
  if (!UUID.test(docId)) return null;
  const [doc] = (await db.execute(sql`
    SELECT id, title, uploader_id AS "uploaderId", visibility, deleted_at AS "deletedAt" FROM documents WHERE id = ${docId}
  `)) as unknown as { id: string; title: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null }[];
  if (!doc || doc.deletedAt !== null) return null;
  const role = await loadEffectiveRole({ id: doc.id, uploaderId: doc.uploaderId, visibility: doc.visibility }, actor);
  if (!canRead(doc.visibility, role)) return null;
  const rows = (await db.execute(sql`
    SELECT id, version_number AS n FROM versions WHERE document_id = ${docId} ORDER BY version_number
  `)) as unknown as { id: string; n: number }[];
  return { title: doc.title, versions: new Map(rows.map((r) => [Number(r.n), r.id])), latest: rows.length ? Number(rows.at(-1)!.n) : null };
}

/**
 * Pins the citations in an agent's block input (M10b.4): a citation of a
 * Primer document without a version gets the document's latest version, so
 * the claim stays tied to what was cited even after the document changes. A
 * citation must name a document the agent can read (and a version it has),
 * or an http(s) URL. Mutates `input`; returns what is wrong, or null.
 */
export async function pinCitations(actor: AuthUser, input: unknown): Promise<string | null> {
  const found: Record<string, unknown>[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) for (const v of value) walk(v);
    else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (obj.type === 'citation') found.push(obj);
      for (const v of Object.values(obj)) walk(v);
    }
  };
  walk(input);
  for (const citation of found) {
    const props = (citation.props && typeof citation.props === 'object' ? citation.props : {}) as Record<string, unknown>;
    citation.props = props;
    if (typeof props.quote === 'string' && props.quote.length > MAX_QUOTE) return `A citation's quote is over ${MAX_QUOTE} characters.`;
    if (typeof props.docId === 'string' && props.docId !== '') {
      const doc = await citedDoc(actor, props.docId);
      if (!doc) return `Cited document ${props.docId} was not found.`;
      const version = props.versionNumber === undefined || props.versionNumber === '' ? doc.latest : Number(props.versionNumber);
      if (version === null || !VERSION.test(String(version)) || !doc.versions.has(version)) {
        return `Cited document ${props.docId} has no version ${String(props.versionNumber ?? '')}.`;
      }
      props.versionNumber = String(version);
      continue;
    }
    try {
      const url = new URL(String(props.url ?? ''));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
    } catch {
      return 'A citation needs docId (a Primer document) or an http(s) url.';
    }
  }
  return null;
}

/**
 * The citations of a live document in reading order, with what each cites.
 * Props come from the client-writable document: a cited document is named
 * (title, version id) only after a read check for the caller.
 */
export async function listCitations(actor: AuthUser, documentId: string): Promise<Result<CitationsResponse>> {
  const access = await liveDocAccess(documentId, actor);
  if (!access.ok) return access;
  const found = await withLiveDocument(documentId, (doc) => {
    const out: { target: Target; props: Record<string, string> }[] = [];
    const inline = (content: unknown, target: Target) => {
      if (!Array.isArray(content)) {
        const rows = (content as { rows?: { cells: unknown[] }[] } | undefined)?.rows;
        for (const row of rows ?? []) for (const cell of row.cells) inline((cell as { content?: unknown })?.content ?? cell, target);
        return;
      }
      for (const node of content as { type: string; props?: Record<string, string>; content?: unknown }[]) {
        if (node.type === 'citation') out.push({ target, props: node.props ?? {} });
        else if (node.type === 'link') inline(node.content, target);
      }
    };
    for (const { tabId, block } of liveBlocks(doc)) inline(block.content, { tabId, blockId: block.id });
    return out;
  });
  const docs = new Map<string, CitedDoc | null>();
  const citations: CitationDTO[] = [];
  for (const [i, { target, props }] of found.entries()) {
    const quote = String(props.quote ?? '');
    const entry: CitationDTO = { number: i + 1, target, quote: actor.kind === 'agent' ? fenceUntrusted(quote, 'content') : quote };
    if (UUID.test(props.docId ?? '')) {
      entry.docId = props.docId!;
      if (VERSION.test(props.versionNumber ?? '')) entry.versionNumber = Number(props.versionNumber);
      if (!docs.has(entry.docId)) docs.set(entry.docId, await citedDoc(actor, entry.docId));
      const cited = docs.get(entry.docId);
      if (cited) entry.source = { title: cited.title, versionId: entry.versionNumber ? (cited.versions.get(entry.versionNumber) ?? null) : null };
    } else if (props.url && /^https?:$/.test(safeProtocol(props.url))) {
      // The Y.Doc is client-writable: only http(s) links go out, as on the write path.
      entry.url = props.url;
    }
    if (actor.kind === 'agent') entry.untrusted = true;
    citations.push(entry);
  }
  return { ok: true, value: { citations } };
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return '';
  }
}
