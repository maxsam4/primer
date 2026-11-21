import fastDiff from 'fast-diff';
import type { Mark, Node as PmNode } from '@tiptap/pm/model';
import type { Transform } from '@tiptap/pm/transform';
import { findBlock } from './blocks.ts';
import type { InputKind } from './convert.ts';

/** Props a Markdown or HTML projection can't carry: kept from the block. */
const PRESENTATIONAL = ['textColor', 'backgroundColor', 'textAlignment'];

/** Marks the input format can express, so the input decides them. Every
 *  other mark (colours, comment and suggestion marks, and underline for
 *  Markdown) is the block's and survives the update. */
const EXPRESSIBLE: Record<Exclude<InputKind, 'json'>, Set<string>> = {
  markdown: new Set(['bold', 'italic', 'strike', 'code', 'link']),
  html: new Set(['bold', 'italic', 'strike', 'code', 'link', 'underline']),
};

export type UpdateInput = {
  kind: InputKind;
  /** The new block (a blockContainer). */
  node: PmNode;
  /** JSON input only: the props and top-level keys it set. */
  props?: string[];
  keys?: string[];
};

/**
 * Applies an update to the block at `at` without losing what the input
 * format can't express (the "rebase", plan M4.2): the block keeps its id,
 * its children and the props the input can't carry.
 *
 * Same type and inline content: text leaves (maximal text runs between
 * atoms such as hard breaks) are diffed with fast-diff and only the changed
 * characters are replaced; inserted text takes the marks of what it replaces,
 * so colour, underline and comment marks stay. Then the expressible marks are
 * set from the input, only where they differ (a link changes only when its
 * href does). If the atoms differ, the type changes, or the block is a table,
 * its content is replaced whole and a note says so.
 *
 * Returns a note for the caller, if any.
 */
export function rebaseUpdate(tr: Transform, at: { pos: number; node: PmNode }, input: UpdateInput): string | undefined {
  const oldContent = at.node.firstChild!;
  const newContent = input.node.firstChild!;
  const contentPos = at.pos + 1;
  const attrs = mergedAttrs(oldContent, newContent, input);

  if (input.kind === 'json') {
    if (oldContent.type === newContent.type && !input.keys?.includes('content')) {
      if (!sameAttrs(oldContent.attrs, attrs)) tr.setNodeMarkup(contentPos, undefined, attrs);
      return undefined;
    }
    if (!input.keys?.includes('content')) {
      // A type change that sets no content keeps the text when the new type holds inline text.
      if (oldContent.inlineContent && newContent.type.inlineContent) {
        tr.replaceWith(contentPos, contentPos + oldContent.nodeSize, newContent.type.create(attrs, oldContent.content, newContent.marks));
        return undefined;
      }
      replaceWhole(tr, contentPos, oldContent, newContent, attrs);
      return 'The block changed type to one that cannot keep its content, so its content was replaced.';
    }
    replaceWhole(tr, contentPos, oldContent, newContent, attrs);
    return undefined;
  }

  if (oldContent.type !== newContent.type) {
    replaceWhole(tr, contentPos, oldContent, newContent, attrs);
    return undefined;
  }
  if (oldContent.type.name === 'table' || !oldContent.inlineContent) {
    if (!oldContent.eq(newContent.type.create(attrs, newContent.content, newContent.marks))) {
      replaceWhole(tr, contentPos, oldContent, newContent, attrs);
      return oldContent.type.name === 'table' ? 'Tables are replaced whole: the table was rewritten from your input.' : undefined;
    }
    return undefined;
  }

  const oldSegs = segments(oldContent, contentPos + 1);
  const newSegs = segments(newContent, 0);
  if (oldSegs.atoms.join('|') !== newSegs.atoms.join('|')) {
    replaceWhole(tr, contentPos, oldContent, newContent, attrs);
    return 'Line breaks or inline chips changed, so the block\'s text was replaced whole (its colours and comments on that text were not kept).';
  }

  if (!sameAttrs(oldContent.attrs, attrs)) tr.setNodeMarkup(contentPos, undefined, attrs);
  const schema = tr.doc.type.schema;

  // Pass 1: text. Runs and edits are applied last to first, so every
  // position is still in the block's original coordinates.
  for (let i = oldSegs.runs.length - 1; i >= 0; i--) {
    const run = oldSegs.runs[i]!;
    const edits = textEdits(run.text, newSegs.runs[i]!.text);
    for (let e = edits.length - 1; e >= 0; e--) {
      const { from, to, insert } = edits[e]!;
      const a = run.from + from;
      const b = run.from + to;
      if (insert === '') {
        tr.delete(a, b);
        continue;
      }
      const source = to > from ? tr.doc.nodeAt(a) : from > 0 ? tr.doc.nodeAt(a - 1) : tr.doc.nodeAt(a);
      const marks = source?.isText ? source.marks : [];
      tr.replaceWith(a, b, schema.text(insert, marks));
    }
  }

  // Pass 2: the input's expressible marks, set only where they differ.
  const block = findBlock(tr.doc, at.node.attrs.id as string)!;
  const current = segments(block.node.firstChild!, block.pos + 2);
  const expressible = EXPRESSIBLE[input.kind];
  current.runs.forEach((run, i) => {
    const want = newSegs.runs[i]!;
    for (const name of expressible) {
      const type = schema.marks[name];
      if (!type) continue;
      let j = 0;
      const length = Math.min(run.chars.length, want.chars.length);
      while (j < length) {
        const have = run.chars[j]!.find((m) => m.type === type) ?? null;
        const wanted = want.chars[j]!.find((m) => m.type.name === name) ?? null;
        if (sameMark(have, wanted)) {
          j++;
          continue;
        }
        let k = j + 1;
        while (k < length) {
          const h = run.chars[k]!.find((m) => m.type === type) ?? null;
          const w = want.chars[k]!.find((m) => m.type.name === name) ?? null;
          if (sameMark(h, w) || markKey(w) !== markKey(wanted)) break;
          k++;
        }
        tr.removeMark(run.from + j, run.from + k, type);
        if (wanted) tr.addMark(run.from + j, run.from + k, type.create(wanted.attrs));
        j = k;
      }
    }
  });
  return undefined;
}

function replaceWhole(tr: Transform, contentPos: number, oldContent: PmNode, newContent: PmNode, attrs: Record<string, unknown>) {
  tr.replaceWith(contentPos, contentPos + oldContent.nodeSize, newContent.type.create(attrs, newContent.content, newContent.marks));
}

function mergedAttrs(oldContent: PmNode, newContent: PmNode, input: UpdateInput): Record<string, unknown> {
  const has = (name: string) => name in newContent.attrs;
  if (input.kind === 'json') {
    const base = oldContent.type === newContent.type ? { ...oldContent.attrs } : { ...newContent.attrs };
    if (oldContent.type !== newContent.type) {
      for (const name of PRESENTATIONAL) if (has(name) && name in oldContent.attrs) base[name] = oldContent.attrs[name];
    }
    for (const name of input.props ?? []) if (has(name)) base[name] = newContent.attrs[name];
    return base;
  }
  const out = { ...newContent.attrs };
  for (const name of PRESENTATIONAL) if (has(name) && name in oldContent.attrs) out[name] = oldContent.attrs[name];
  return out;
}

function sameAttrs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)));
}

/** Links compare by href; other expressible marks by presence. */
function sameMark(a: Mark | null, b: Mark | null): boolean {
  return markKey(a) === markKey(b);
}

function markKey(m: Mark | null): string | null {
  if (!m) return null;
  return m.type.name === 'link' ? `link:${String(m.attrs.href)}` : m.type.name;
}

type Run = { from: number; text: string; chars: readonly Mark[][] };

/**
 * A textblock's inline content as text runs separated by atoms (every
 * non-text inline node: hard breaks, chips). `atoms` are their signatures;
 * there is always one more run than atoms. `from` is absolute when `start`
 * is the content's first position.
 */
function segments(content: PmNode, start: number): { runs: Run[]; atoms: string[] } {
  const runs: Run[] = [{ from: start, text: '', chars: [] }];
  const atoms: string[] = [];
  content.forEach((child, offset) => {
    if (child.isText) {
      const run = runs[runs.length - 1]!;
      run.text += child.text!;
      (run.chars as Mark[][]).push(...Array.from({ length: child.text!.length }, () => [...child.marks]));
      return;
    }
    atoms.push(`${child.type.name}:${JSON.stringify(child.attrs)}`);
    runs.push({ from: start + offset + child.nodeSize, text: '', chars: [] });
  });
  return { runs, atoms };
}

/** fast-diff as replacements `[from, to) → insert` in old-text offsets. */
function textEdits(oldText: string, newText: string): { from: number; to: number; insert: string }[] {
  const edits: { from: number; to: number; insert: string }[] = [];
  let pos = 0;
  for (const [op, text] of fastDiff(oldText, newText)) {
    if (op === fastDiff.EQUAL) {
      pos += text.length;
      continue;
    }
    const last = edits[edits.length - 1];
    const open = last && last.to === pos ? last : null;
    if (op === fastDiff.DELETE) {
      if (open) open.to += text.length;
      else edits.push({ from: pos, to: pos + text.length, insert: '' });
      pos += text.length;
    } else {
      if (open) open.insert += text;
      else edits.push({ from: pos, to: pos, insert: text });
    }
  }
  return edits;
}
