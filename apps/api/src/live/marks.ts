import * as Y from 'yjs';
import { Node as PmNode, type Schema } from '@tiptap/pm/model';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror';
import type { Target } from '@polygonlabs/primer-api-types';
import { serverEditor } from './editor.ts';
import { findBlock } from './blocks.ts';
import { normalizeText, similarity, similarityCost } from '../lib/similarity.ts';
import { liveDocName, liveInstance } from './instance.ts';
import type { PlannedEdit } from './pipeline.ts';
import { fragmentName, reachableFragments } from './reach.ts';

/** BlockNote's comment mark: `{ threadId, orphan }`. */
const COMMENT = 'comment';

/** A selection that no longer resolves in the live document. */
export class AnchorMissingError extends Error {
  constructor(message = 'The selection no longer resolves in the document.') {
    super(message);
  }
}

/** A selection sent as base64 `Y.encodeRelativePosition` bytes. */
export type RelativeSelection = { anchor: string; head: string };

/** The ProseMirror doc of one fragment (Primer's schema). */
export function fragmentDoc(fragment: Y.XmlFragment): PmNode {
  const schema = serverEditor().editor.pmSchema;
  if (fragment.length === 0) return schema.topNodeType.createAndFill()!;
  return PmNode.fromJSON(schema, yXmlFragmentToProsemirrorJSON(fragment));
}

/**
 * The `mapping` y-prosemirror's position helpers need (Y type → ProseMirror
 * node size), computed from the Y structure and the schema instead of a live
 * editor binding: an element is 1 when its node type is a leaf, else 2 plus
 * its children; a text run is its length.
 */
function sizeMapping(schema: Schema): Map<Y.AbstractType<any>, { nodeSize: number }> {
  const size = (type: Y.AbstractType<any>): number => {
    if (type instanceof Y.XmlText) return type.length;
    const el = type as Y.XmlElement;
    if (schema.nodes[el.nodeName]?.isLeaf) return 1;
    return 2 + el.toArray().reduce((n, child) => n + size(child as Y.AbstractType<any>), 0);
  };
  return { get: (type: Y.AbstractType<any>) => ({ nodeSize: size(type) }) } as never;
}

/** Encodes ProseMirror position `pos` in `fragment` as a relative position. */
export function toRelative(fragment: Y.XmlFragment, pos: number): string {
  const rel = absolutePositionToRelativePosition(pos, fragment, sizeMapping(serverEditor().editor.pmSchema) as never);
  return Buffer.from(Y.encodeRelativePosition(rel)).toString('base64');
}

/** Position `pos` in `fragment` as relative-position JSON, the form
 *  y-prosemirror's collaboration cursors read from awareness. */
export function toRelativeJSON(fragment: Y.XmlFragment, pos: number): unknown {
  const rel = absolutePositionToRelativePosition(pos, fragment, sizeMapping(serverEditor().editor.pmSchema) as never);
  return Y.relativePositionToJSON(rel);
}

/** The absolute range of a relative selection in `target`'s fragment, or null. */
export function resolveSelection(doc: Y.Doc, target: Target, sel: RelativeSelection): { from: number; to: number } | null {
  const fragment = doc.getXmlFragment(fragmentName(target));
  const mapping = sizeMapping(serverEditor().editor.pmSchema);
  const resolve = (encoded: string): number | null => {
    let rel: Y.RelativePosition;
    try {
      rel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(encoded, 'base64')));
    } catch {
      return null;
    }
    return relativePositionToAbsolutePosition(doc, fragment, rel, mapping as never);
  };
  const a = resolve(sel.anchor);
  const h = resolve(sel.head);
  if (a === null || h === null || a === h) return null;
  return { from: Math.min(a, h), to: Math.max(a, h) };
}

/**
 * Adds the comment mark for `threadId` over a selection, resolved inside the
 * document's queue (so positions match the content the mark lands on). The
 * marked text is reported through `onQuote`. Throws AnchorMissingError when
 * the selection no longer resolves or covers no text.
 */
export function commentMarkEdit(
  documentId: string,
  threadId: string,
  target: Target,
  sel: RelativeSelection,
  onQuote: (quote: string) => void,
): PlannedEdit {
  return {
    target,
    inverse: false,
    build: (tr) => {
      const doc = liveInstance().documents.get(liveDocName(documentId));
      const range = doc ? resolveSelection(doc, target, sel) : null;
      if (!range) throw new AnchorMissingError();
      addComment(tr.doc, range, threadId, onQuote, (from, to, mark) => tr.addMark(from, to, mark));
    },
  };
}

/** Adds the comment mark for `threadId` over the first exact occurrence of
 *  `quote` in the target (its block, or the whole fragment). With `fuzzy`
 *  (re-anchoring only), a reworded quote matches too (`findQuote`), and
 *  `onPlaced` gets the text actually marked and the block it is in. */
export function quoteMarkEdit(
  threadId: string,
  target: Target,
  quote: string,
  opts: { fuzzy?: boolean; onPlaced?: (quote: string, blockId: string | null) => void } = {},
): PlannedEdit {
  return {
    target,
    inverse: false,
    build: (tr) => {
      const range = findQuote(tr.doc, blockScope(target), quote, { fuzzy: opts.fuzzy });
      if (!range) throw new AnchorMissingError(`"${quote}" was not found in the target.`);
      addComment(tr.doc, range, threadId, (q) => opts.onPlaced?.(q, range.blockId), (from, to, mark) => tr.addMark(from, to, mark));
    },
  };
}

/** Removes the comment mark of `threadId` from a whole tab: the undo of a mark
 *  placed for a thread whose rows could not be written. */
export function removeMarkEdit(threadId: string, tabId: string): PlannedEdit {
  return {
    target: { tabId, blockId: '' },
    inverse: false,
    build: (tr) => {
      const marks: { from: number; to: number; mark: ReturnType<Schema['mark']> }[] = [];
      tr.doc.descendants((node, pos) => {
        for (const mark of node.marks) {
          if (mark.type.name === COMMENT && mark.attrs.threadId === threadId) marks.push({ from: pos, to: pos + node.nodeSize, mark });
        }
        return true;
      });
      for (const m of marks) tr.removeMark(m.from, m.to, m.mark);
    },
  };
}

function addComment(
  doc: PmNode,
  range: { from: number; to: number },
  threadId: string,
  onQuote: (quote: string) => void,
  add: (from: number, to: number, mark: ReturnType<Schema['mark']>) => void,
) {
  const quote = doc.textBetween(range.from, range.to, '\n');
  if (quote.trim() === '') throw new AnchorMissingError('The selection covers no text.');
  add(range.from, range.to, doc.type.schema.marks[COMMENT]!.create({ threadId, orphan: false }));
  onQuote(quote);
}

type QuoteRange = { from: number; to: number; blockId: string | null };

/**
 * The range of the first exact occurrence of `quote` inside one textblock of
 * the block `blockId` (or anywhere in the fragment when `blockId` is empty).
 *
 * With `fuzzy` (re-anchoring, M10b.3), when there is no exact occurrence the
 * best window of whole words with `similarity ≥ 0.8` is taken instead, and a
 * block that is gone widens the search to the whole fragment. A second,
 * separate window scoring within 0.05 of the best makes the match ambiguous:
 * none is returned, never a guess. The work is bounded like the republish
 * merge's: quotes over `MAX_FUZZY_QUOTE` characters match exactly only, and
 * once `FUZZY_BUDGET` character pairs are spent the search gives up.
 */
export function findQuote(doc: PmNode, blockId: string, quote: string, opts: { fuzzy?: boolean } = {}): QuoteRange | null {
  if (quote === '') return null;
  let scope = blockId ? findBlock(doc, blockId) : { pos: -1, node: doc };
  // The block is gone: the search widens to the whole fragment, where the
  // exact match must be the only one.
  const widened = !scope && !!opts.fuzzy;
  if (widened) scope = { pos: -1, node: doc };
  if (!scope) return null;
  const textblocks: { node: PmNode; start: number; blockId: string | null }[] = [];
  scope.node.descendants((node, offset) => {
    if (!node.isTextblock) return true;
    const start = scope.pos + 1 + offset + 1;
    textblocks.push({ node, start, blockId: blockIdAt(doc, start) });
    return false;
  });
  let exact: QuoteRange | null = null;
  for (const tb of textblocks) {
    const index = tb.node.textContent.indexOf(quote);
    if (index < 0) continue;
    const range = { ...textRange(tb.node, tb.start, index, quote.length), blockId: tb.blockId };
    if (!widened) return range;
    if (exact || tb.node.textContent.indexOf(quote, index + 1) >= 0) return null;
    exact = range;
  }
  if (exact) return exact;
  return opts.fuzzy ? fuzzyQuote(textblocks, quote) : null;
}

/** Re-anchoring: the minimum similarity, the tie margin, and the bounds. */
const FUZZY_MIN = 0.8;
const FUZZY_TIE = 0.05;
const MAX_FUZZY_QUOTE = 2000;
const FUZZY_BUDGET = 20_000_000;

function fuzzyQuote(textblocks: { node: PmNode; start: number; blockId: string | null }[], quote: string): QuoteRange | null {
  if (quote.length > MAX_FUZZY_QUOTE) return null;
  const wanted = normalizeText(quote);
  if (wanted.length === 0) return null;
  // A window within reach of 0.8 has a length within 20% of the quote's.
  const minLen = Math.floor(wanted.length * FUZZY_MIN);
  const maxLen = Math.ceil(wanted.length / FUZZY_MIN);
  let spent = 0;
  type Hit = { score: number; tb: number; from: number; to: number };
  const hits: Hit[] = [];
  for (let k = 0; k < textblocks.length; k++) {
    const text = textblocks[k]!.node.textContent;
    if (text.length < minLen) continue;
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i <= text.length; i++) {
      const before = i > 0 && !/\s/.test(text[i - 1]!);
      const after = i < text.length && !/\s/.test(text[i]!);
      if (after && !before) starts.push(i);
      if (before && !after) ends.push(i);
    }
    let first = 0;
    for (const from of starts) {
      while (first < ends.length && ends[first]! <= from) first++;
      for (let e = first; e < ends.length; e++) {
        const to = ends[e]!;
        // Normalizing is work too: windows too short to matter are skipped
        // unread, the rest are charged before they are normalized.
        if (to - from < minLen) continue;
        spent += to - from;
        if (spent > FUZZY_BUDGET) return null;
        const window = text.slice(from, to);
        const len = normalizeText(window).length;
        if (len < minLen) continue;
        if (len > maxLen) break;
        const cost = similarityCost(window, quote, FUZZY_MIN);
        if (spent + cost > FUZZY_BUDGET) return null;
        spent += cost;
        const score = similarity(window, quote, FUZZY_MIN);
        if (score > 0) hits.push({ score, tb: k, from, to });
      }
    }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.score - a.score || b.to - b.from - (a.to - a.from));
  const best = hits[0]!;
  const rival = hits.find((h) => h.tb !== best.tb || h.to <= best.from || h.from >= best.to);
  if (rival && rival.score >= best.score - FUZZY_TIE) return null;
  const tb = textblocks[best.tb]!;
  return { ...textRange(tb.node, tb.start, best.from, best.to - best.from), blockId: tb.blockId };
}

/** The id of the innermost block containing `pos`. */
function blockIdAt(doc: PmNode, pos: number): string | null {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.isInGroup('bnBlock') && typeof node.attrs.id === 'string') return node.attrs.id;
  }
  return null;
}

/** Positions of `[index, index + length)` of a textblock's text content. */
function textRange(node: PmNode, start: number, index: number, length: number): { from: number; to: number } {
  let from = -1;
  let to = -1;
  let seen = 0;
  node.forEach((child, offset) => {
    const text = child.isText ? child.text!.length : 0;
    if (from < 0 && index < seen + text) from = start + offset + (index - seen);
    if (to < 0 && index + length <= seen + text) to = start + offset + (index + length - seen);
    seen += text;
  });
  return { from, to };
}

/** The block to search for a target's quote: a sub-fragment (page text,
 *  embed, widget label) is searched whole. */
function blockScope(target: Target): string {
  return target.pid || target.textId || target.embedId ? '' : target.blockId;
}

/** `findQuote` against the live content of the target's fragment. */
export function findMarkedQuote(doc: Y.Doc, target: Target, quote: string, opts: { fuzzy?: boolean } = {}): QuoteRange | null {
  return findQuote(fragmentDoc(doc.getXmlFragment(fragmentName(target))), blockScope(target), quote, opts);
}

/** Thread ids of every comment mark in `node`. */
export function commentedThreadIds(node: PmNode): string[] {
  const ids = new Set<string>();
  node.descendants((child) => {
    for (const mark of child.marks) {
      if (mark.type.name === COMMENT && typeof mark.attrs.threadId === 'string') ids.add(mark.attrs.threadId);
    }
    return true;
  });
  return [...ids];
}

/** Threads whose comment mark is in reachable content. Fragments a republish
 *  left behind still hold marks, but those don't count. */
export function presentThreadIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  for (const name of reachableFragments(doc)) {
    const fragment = doc.getXmlFragment(name);
    if (fragment.length === 0) continue;
    for (const id of commentedThreadIds(fragmentDoc(fragment))) ids.add(id);
  }
  return ids;
}
