// Places comment-thread anchors on a version's text.
//
// A text-range anchor is placed where its quoted text occurs with the same
// text right before it or right after it (CONTEXT_CHARS characters) as on the
// version it was started on, if that is exactly one place. Otherwise the
// placement has no anchor and the thread shows as "context changed". There is
// no fuzzy matching: a thread is either on the exact words it was about or it
// says that it isn't.
//
// The match runs on the version's <body> text as the companion's text walk sees
// it (every text node in document order, script and style text included) with
// whitespace runs collapsed to one space, so reformatting the HTML doesn't move
// a thread. A browser selection across blocks carries line breaks the DOM text
// doesn't have (`<p>a</p><p>b</p>` is "ab" there, "a\n\nb" in the selection),
// so the text gets a synthetic space at each block boundary that matching may
// use or skip. Anywhere else a space is part of the words: "now here" is not
// "nowhere".
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { desc, eq } from 'drizzle-orm';
import type { AnchorData, TextRangeAnchor, ThreadAnchor } from '@polygonlabs/primer-api-types';
import { isElementPathAnchor, isTextRangeAnchor } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { threadPlacements, threads, versions } from '../db/schema.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Characters of surrounding text compared on each side of the quote. */
export const CONTEXT_CHARS = 32;

export interface BodyText {
  /** Body text with every whitespace run collapsed to one space, plus a space
   *  at each block boundary that has none. */
  text: string;
  /** For each character of `text`, its offset in the raw (uncollapsed) text. */
  rawOffset: number[];
  /** For each character of `text`, whether it is a block-boundary space that
   *  the DOM text doesn't have. */
  synthetic: boolean[];
}

const BLOCKS = new Set(
  'address article aside blockquote body br caption dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul'.split(
    ' ',
  ),
);

/** The collapsed text of an HTML document's <body>. */
export function bodyText(html: string): BodyText {
  const doc = parse(html);
  const htmlEl = doc.childNodes.find((n) => (n as Element).tagName === 'html') as Element | undefined;
  const body = htmlEl?.childNodes.find((n) => (n as Element).tagName === 'body') as Element | undefined;
  let raw = '';
  const breaks = new Set<number>();
  const walk = (node: Node): void => {
    if (node.nodeName === '#text') {
      raw += (node as DefaultTreeAdapterMap['textNode']).value;
      return;
    }
    // <template> content lives in `content`, which a DOM text walk skips too.
    const block = BLOCKS.has(node.nodeName);
    if (block) breaks.add(raw.length);
    for (const child of (node as Element).childNodes ?? []) walk(child);
    if (block) breaks.add(raw.length);
  };
  if (body) walk(body);

  let text = '';
  const rawOffset: number[] = [];
  const synthetic: boolean[] = [];
  const push = (ch: string, at: number, fake: boolean): void => {
    text += ch;
    rawOffset.push(at);
    synthetic.push(fake);
  };
  for (let i = 0; i < raw.length; i++) {
    if (breaks.has(i) && text.length > 0 && !text.endsWith(' ')) push(' ', i, true);
    if (/\s/.test(raw[i])) {
      if (!text.endsWith(' ')) push(' ', i, false);
    } else {
      push(raw[i], i, false);
    }
  }
  return { text, rawOffset, synthetic };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** Where `needle` matches `body.text` at `at`, as the end index, or -1.
 *  Synthetic spaces the needle doesn't have are skipped. */
function matchAt(body: BodyText, needle: string, at: number, from = 0): number {
  let i = at;
  for (let j = from; j < needle.length; ) {
    if (i >= body.text.length) return -1;
    if (body.text[i] === needle[j]) {
      i++;
      j++;
    } else if (body.synthetic[i]) i++;
    else return -1;
  }
  return i;
}

/** The [start, end) of every place `needle` matches. */
function occurrences(body: BodyText, needle: string): [number, number][] {
  const out: [number, number][] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i < body.text.length; i++) {
    if (body.synthetic[i] && needle[0] !== ' ') continue;
    const end = matchAt(body, needle, i);
    if (end !== -1) out.push([i, end]);
  }
  return out;
}

/** The text between two indexes as the DOM has it: without synthetic spaces. */
function domText(body: BodyText, from: number, to: number): string {
  let out = '';
  for (let i = Math.max(0, from); i < to && i < body.text.length; i++) if (!body.synthetic[i]) out += body.text[i];
  return out;
}

/** First index in `list` whose value is >= `value` (list is ascending). */
function lowerBound(list: number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < value) lo = mid + 1;
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
  // their text is the quote; else the quote's only occurrence; else give up.
  let at: [number, number] | undefined;
  if (typeof anchor.start === 'number' && typeof anchor.end === 'number') {
    let from = lowerBound(origin.rawOffset, anchor.start);
    let to = lowerBound(origin.rawOffset, anchor.end);
    while (from < to && origin.text[from] === ' ') from++;
    while (to > from && origin.text[to - 1] === ' ') to--;
    if (matchAt(origin, quote, from) === to) at = [from, to];
  }
  if (!at) {
    const hits = occurrences(origin, quote);
    if (hits.length !== 1) return null;
    at = hits[0];
  }
  return {
    prefix: origin.text.slice(Math.max(0, at[0] - CONTEXT_CHARS), at[0]),
    quote,
    suffix: origin.text.slice(at[1], at[1] + CONTEXT_CHARS),
  };
}

/**
 * Places a text-range anchor from its originating version onto a target
 * version. Returns the anchor to store for the target, or null when there
 * isn't exactly one occurrence of the quote with its preceding or following
 * context unchanged ("context changed"). Whitespace runs are equal and block
 * boundaries may or may not show as a space; no other word boundary moves.
 *
 * The returned anchor uses the context shape (`prefix`/`selectorText`/`suffix`
 * with `containerPath: 'body'`) built from the target's own DOM text, which the
 * companion resolves by searching the live text, so it can never highlight
 * different words than the ones matched.
 */
export function placeTextRange(
  anchor: TextRangeAnchor,
  origin: BodyText,
  target: BodyText,
): TextRangeAnchor | null {
  const q = quoteInOrigin(anchor, origin);
  if (!q) return null;
  const found = new Map<number, number>();
  for (const [from] of occurrences(target, q.prefix + q.quote)) {
    const start = matchAt(target, q.prefix, from);
    if (start === -1) continue;
    // The synthetic space between the context and the quote belongs to neither.
    let qs = start;
    while (target.synthetic[qs] && q.quote[0] !== ' ') qs++;
    found.set(qs, matchAt(target, q.quote, qs));
  }
  for (const [from] of occurrences(target, q.quote + q.suffix)) found.set(from, matchAt(target, q.quote, from));
  if (found.size !== 1) return null;
  const [[from, to]] = found;
  return {
    type: 'text-range',
    selectorText: domText(target, from, to),
    prefix: domText(target, from - CONTEXT_CHARS, from),
    suffix: domText(target, to, to + CONTEXT_CHARS),
    containerPath: 'body',
  };
}

/**
 * A thread's stored anchor, kept for a live version's static rendering only
 * where it still points at its words. Position anchors index the text they
 * were made on, so on text whose offsets moved they are re-found by their
 * quote (exactly one place, else null: "context changed"). Element and live
 * anchors carry over, as in `carryOpenThreads`.
 */
export function anchorOnRender(anchor: ThreadAnchor, render: BodyText): ThreadAnchor | null {
  if (!isTextRangeAnchor(anchor)) return anchor;
  return placeTextRange(anchor, render, render);
}

/**
 * Gives a reopened thread a placement on the document's latest version. Resolved
 * threads stay behind at publish, so one reopened later has none there and would
 * be invisible until the next publish. Element anchors carry over unchanged; a
 * text range cannot be matched without the version text, so it shows as "context
 * changed" until the next publish matches it. No-op when it is already placed.
 */
export async function placeReopened(tx: Tx, threadId: string): Promise<void> {
  const [t] = await tx
    .select({ documentId: threads.documentId, anchor: threads.anchor })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!t) return;
  const [latest] = await tx
    .select({ id: versions.id })
    .from(versions)
    .where(eq(versions.documentId, t.documentId))
    .orderBy(desc(versions.versionNumber))
    .limit(1);
  if (!latest) return;
  await tx
    .insert(threadPlacements)
    .values({ threadId, versionId: latest.id, anchor: isElementPathAnchor(t.anchor) ? t.anchor : null })
    .onConflictDoNothing();
}
