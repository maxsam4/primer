// Carries open comment threads onto a newly published version.
//
// A thread belongs to its document. When a version is published, every open
// thread gets a placement on it. The thread is placed where its quoted text
// occurs with the same text right before it or right after it (CONTEXT_CHARS
// characters) as on the version it was started on, if that is exactly one
// place. Otherwise the placement has no anchor and the thread shows as
// "context changed". There is no fuzzy matching: a thread is either on the
// exact words it was about or it says that it isn't.
//
// The match runs on the version's <body> text as the companion's text walk sees
// it (every text node in document order, script and style text included), with
// whitespace runs collapsed, so reformatting the HTML never moves a thread.
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AnchorData, TextRangeAnchor } from '@polygonlabs/primer-api-types';
import { isElementPathAnchor, isTextRangeAnchor } from '@polygonlabs/primer-api-types';
import type { db } from '../db/client.ts';
import { threadPlacements, threads, versions } from '../db/schema.ts';
import type { Storage } from '../storage/types.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Characters of surrounding text compared on each side of the quote. */
export const CONTEXT_CHARS = 32;

export interface BodyText {
  /** Body text with every whitespace run collapsed to one space. */
  text: string;
  /** For each character of `text`, its offset in the raw (uncollapsed) text. */
  rawOffset: number[];
}

/** The collapsed text of an HTML document's <body>. */
export function bodyText(html: string): BodyText {
  const doc = parse(html);
  const htmlEl = doc.childNodes.find((n) => (n as Element).tagName === 'html') as Element | undefined;
  const body = htmlEl?.childNodes.find((n) => (n as Element).tagName === 'body') as Element | undefined;
  let raw = '';
  const walk = (node: Node): void => {
    if (node.nodeName === '#text') {
      raw += (node as DefaultTreeAdapterMap['textNode']).value;
      return;
    }
    // <template> content lives in `content`, which a DOM text walk skips too.
    for (const child of (node as Element).childNodes ?? []) walk(child);
  };
  if (body) walk(body);

  let text = '';
  const rawOffset: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (/\s/.test(raw[i])) {
      if (text.endsWith(' ')) continue;
      text += ' ';
    } else {
      text += raw[i];
    }
    rawOffset.push(i);
  }
  return { text, rawOffset };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ');
}

function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** First index in `text` whose raw offset is >= `raw`. */
function collapsedIndex(body: BodyText, raw: number): number {
  let lo = 0;
  let hi = body.rawOffset.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (body.rawOffset[mid] < raw) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The quote with its context on the originating version, or null when the
 *  anchor can't be pinned to one place there. */
function quoteInOrigin(
  anchor: TextRangeAnchor,
  origin: BodyText,
): { prefix: string; quote: string; suffix: string } | null {
  const quote = collapse(anchor.selectorText).trim();
  if (quote.length === 0) return null;

  // Legacy anchors carry their own context.
  if (typeof anchor.prefix === 'string' && typeof anchor.suffix === 'string') {
    return {
      prefix: collapse(anchor.prefix).slice(-CONTEXT_CHARS),
      quote,
      suffix: collapse(anchor.suffix).slice(0, CONTEXT_CHARS),
    };
  }

  // Position anchors: the offsets index the live DOM text, which matches the
  // stored HTML unless the document's scripts changed it. Use the offsets when
  // they point at the quote; else the quote's only occurrence; else give up.
  let at = -1;
  if (typeof anchor.start === 'number' && typeof anchor.end === 'number') {
    const from = collapsedIndex(origin, anchor.start);
    const to = collapsedIndex(origin, anchor.end);
    const slice = origin.text.slice(from, to);
    if (slice.trim() === quote) at = from + (slice.length - slice.trimStart().length);
  }
  if (at === -1) {
    const hits = occurrences(origin.text, quote);
    if (hits.length !== 1) return null;
    at = hits[0];
  }
  return {
    prefix: origin.text.slice(Math.max(0, at - CONTEXT_CHARS), at),
    quote,
    suffix: origin.text.slice(at + quote.length, at + quote.length + CONTEXT_CHARS),
  };
}

/**
 * Places a text-range anchor from its originating version onto a target
 * version. Returns the anchor to store for the target, or null when there
 * isn't exactly one occurrence of the quote with its preceding or following
 * context unchanged ("context changed").
 *
 * The returned anchor uses the context shape (`prefix`/`selectorText`/`suffix`
 * with `containerPath: 'body'`), which the companion resolves by searching the
 * live text, so it can never highlight different words than the ones matched.
 */
export function placeTextRange(
  anchor: TextRangeAnchor,
  origin: BodyText,
  target: BodyText,
): TextRangeAnchor | null {
  const q = quoteInOrigin(anchor, origin);
  if (!q) return null;
  const candidates = new Set([
    ...occurrences(target.text, q.prefix + q.quote).map((i) => i + q.prefix.length),
    ...occurrences(target.text, q.quote + q.suffix),
  ]);
  if (candidates.size !== 1) return null;
  const [at] = candidates;
  return {
    type: 'text-range',
    selectorText: q.quote,
    prefix: target.text.slice(Math.max(0, at - CONTEXT_CHARS), at),
    suffix: target.text.slice(at + q.quote.length, at + q.quote.length + CONTEXT_CHARS),
    containerPath: 'body',
  };
}

/**
 * Adds a placement on `versionId` for every open thread of the document that
 * still has a live comment, matching each from the anchor it was started with.
 * Element anchors carry over unchanged: the companion checks the element's
 * content hash and marks the thread unplaced when it differs.
 */
export async function carryOpenThreads(
  tx: Tx,
  storage: Storage,
  args: { documentId: string; versionId: string; html: string },
): Promise<void> {
  const open = await tx
    .select({
      id: threads.id,
      anchor: threads.anchor,
      originVersionId: threads.versionId,
      originStorageKey: versions.storageKey,
    })
    .from(threads)
    .innerJoin(versions, eq(versions.id, threads.versionId))
    .where(
      and(
        eq(threads.documentId, args.documentId),
        isNull(threads.resolvedAt),
        sql`EXISTS (SELECT 1 FROM comments c WHERE c.thread_id = ${threads.id} AND c.deleted_at IS NULL)`,
      ),
    );
  if (open.length === 0) return;

  const target = bodyText(args.html);
  const originTexts = new Map<string, BodyText>();
  const rows: { threadId: string; versionId: string; anchor: AnchorData | null }[] = [];
  for (const t of open) {
    let anchor: AnchorData | null = null;
    if (isElementPathAnchor(t.anchor)) {
      anchor = t.anchor;
    } else if (isTextRangeAnchor(t.anchor)) {
      let origin = originTexts.get(t.originVersionId);
      if (!origin) {
        origin = bodyText(await new Response(await storage.get(t.originStorageKey)).text());
        originTexts.set(t.originVersionId, origin);
      }
      anchor = placeTextRange(t.anchor, origin, target);
    }
    rows.push({ threadId: t.id, versionId: args.versionId, anchor });
  }
  await tx.insert(threadPlacements).values(rows);
}
