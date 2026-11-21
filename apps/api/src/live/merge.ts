import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import type { Transform } from '@tiptap/pm/transform';
import type { Reconciliation, Refusal } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { similarity, similarityCost } from '../lib/similarity.ts';
import { markdownTokenizer as md } from '../upload/markdown.ts';
import { blockIndex, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';
import type { ImportResult } from './import.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { originFor, SYSTEM_ORIGIN } from './origin.ts';
import { applyPlan, longestIncreasing, type PlannedEdit } from './pipeline.ts';
import { MAIN_TAB, tabFragmentName } from './reach.ts';
import { groupVersion, pmDocOf, rewriteSources, trustedMeta, trustedSources, type SourceEntry } from './sources.ts';

/** Pairs below this similarity are not the same group reworded. */
const MIN_SIMILARITY = 0.5;
/** Slices longer than this align by identical text only. */
const MAX_FUZZY_SLICE = 4096;
/** Character pairs one republish may compare for fuzzy alignment; past it,
 *  what is left aligns by identical text only. */
export const FUZZY_BUDGET = 20_000_000;

const IDENTITY_ONLY_NOTE =
  'Matched by identical text only (the file was too large to compare reworded paragraphs), so a changed group shows as removed and added.';

type BaseGroup = { key: string; entry: SourceEntry; lead: string };
type TheirGroup = { entry: SourceEntry; lead: string; nodes: PmNode[] };

/**
 * A three-way Markdown (or text) republish onto a live document (plan M5.3).
 * Base is the stored, server-signed `sources` groups; mine is the live blocks
 * of each group; theirs is the new file's groups. Groups align by identical
 * slice first, then by similarity (same leading token type, relative order
 * kept, ≥ 0.5, best pairs first). Per base group:
 *
 * | case                                  | result                              |
 * |---------------------------------------|-------------------------------------|
 * | aligned, unchanged                    | keep mine                           |
 * | changed, mine untouched               | theirs, reusing the first block id  |
 * | changed, mine edited                  | keep mine, suggest theirs           |
 * | removed, mine untouched               | delete                              |
 * | removed, mine edited                  | keep                                |
 * | new                                   | insert after the preceding group    |
 * | live blocks with no source entry      | keep in place                       |
 *
 * "Untouched" is decided inside the pipeline against the live document, so a
 * person typing meanwhile is never overwritten. One plan, one Reconciliation;
 * `sources` and `meta` are rewritten in the same transaction for the groups
 * that took theirs. An agent in suggest mode gets every change as a suggestion.
 */
export async function mergeRepublish(documentId: string, actor: AuthUser, theirs: ImportResult): Promise<Reconciliation> {
  const base = await readBase(documentId);
  const their = theirGroups(theirs);
  const { pairs, identityOnly } = align(base, their);

  const edits: PlannedEdit[] = [];
  const kinds: ({ kind: 'changed'; j: number; i: number } | { kind: 'moved'; j: number; i: number } | { kind: 'new'; j: number } | { kind: 'removed'; i: number })[] = [];
  const alignedBase = new Set(pairs.keys());

  const theirToBase = new Map([...pairs].map(([i, p]) => [p.j, { i, same: p.same }]));
  // Identical groups are matched without regard to order: the ones outside
  // the longest run that kept its order were moved in the new file.
  const ordered = [...pairs].sort(([x], [y]) => x - y);
  const keep = longestIncreasing(ordered.map(([, p]) => p.j));
  const reordered = new Set(ordered.filter(([, p], k) => p.same && !keep.has(k)).map(([i]) => i));
  their.forEach((group, j) => {
    const aligned = theirToBase.get(j);
    if (aligned?.same) {
      if (reordered.has(aligned.i)) {
        kinds.push({ kind: 'moved', j, i: aligned.i });
        edits.push(moveEdit(base[aligned.i]!, anchorsBefore(j, their, theirToBase, base)));
      }
      return;
    }
    if (aligned) {
      kinds.push({ kind: 'changed', j, i: aligned.i });
      edits.push(replaceEdit(base[aligned.i]!, group));
      return;
    }
    kinds.push({ kind: 'new', j });
    edits.push(insertEdit(group, anchorsBefore(j, their, theirToBase, base)));
  });
  // Removed groups last, so the document never empties on the way (new
  // groups anchor on aligned or new groups only).
  base.forEach((group, i) => {
    if (alignedBase.has(i)) return;
    kinds.push({ kind: 'removed', i });
    edits.push(removeEdit(group));
  });

  const result = await applyPlan(documentId, originFor(actor), {
    edits,
    onConflict: 'suggest',
    // An agent in suggest mode gets suggestions only (decided by the
    // pipeline); then `sources` and `meta` stay as they were.
    alsoWrite: (doc, outcomes, suggesting) => {
      if (suggesting) return;
      const applied = new Set(outcomes.filter((o) => o.status === 'applied').map((o) => o.index));
      const final = blockIndex(pmDocOf(doc.getXmlFragment(tabFragmentName(MAIN_TAB))));
      const entries = new Map<string, SourceEntry>();
      const removed = new Set<number>();
      const replaced = new Set<number>();
      kinds.forEach((k, index) => {
        if (!applied.has(index)) return;
        if (k.kind === 'removed') removed.add(k.i);
        else if (k.kind === 'moved') return;
        else {
          if (k.kind === 'changed') replaced.add(k.i);
          put(entries, final, their[k.j]!.entry);
        }
      });
      base.forEach((group, i) => {
        if (removed.has(i) || replaced.has(i)) return;
        const pair = pairs.get(i);
        // An identical group still as imported takes theirs' gap and refs.
        if (pair?.same && groupVersion(final, group.entry.groupIds) === group.entry.version) {
          put(entries, final, { ...their[pair.j]!.entry, groupIds: group.entry.groupIds });
        } else entries.set(group.key, group.entry);
      });
      const meta = { format: trustedMeta(doc, documentId).format, frontMatter: theirs.frontMatter, lead: theirs.lead };
      // An identical republish rewrites nothing (and so stores no update).
      const now = trustedSources(doc, documentId);
      const was = trustedMeta(doc, documentId);
      const unchanged =
        entries.size === now.size &&
        [...entries].every(([key, entry]) => now.has(key) && sameEntry(now.get(key)!, entry)) &&
        was.frontMatter === meta.frontMatter &&
        was.lead === meta.lead;
      if (!unchanged) rewriteSources(doc, documentId, entries, meta);
    },
  });
  if (!identityOnly) return result;
  // Removed and new groups may be rewordings fuzzy alignment didn't compare.
  const outcomes = result.outcomes.map((o) =>
    kinds[o.index]!.kind === 'changed' ? o : { ...o, note: [o.note, IDENTITY_ONLY_NOTE].filter(Boolean).join('\n') },
  );
  return { ...result, outcomes };
}

function sameEntry(a: SourceEntry, b: SourceEntry): boolean {
  return (
    a.slice === b.slice &&
    a.gap === b.gap &&
    a.version === b.version &&
    a.groupIds.join() === b.groupIds.join() &&
    a.refs.join() === b.refs.join() &&
    a.defines.join() === b.defines.join()
  );
}

/** Adds `entry` keyed by its first block, with the version of the blocks as
 *  they are now (skipped when one is gone). */
function put(entries: Map<string, SourceEntry>, final: Map<string, PmNode>, entry: SourceEntry) {
  const version = groupVersion(final, entry.groupIds);
  if (version !== null) entries.set(entry.groupIds[0]!, { ...entry, version });
}

/** The signed source groups, in the order their blocks appear now (groups
 *  whose blocks are all gone last). */
async function readBase(documentId: string): Promise<BaseGroup[]> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), SYSTEM_ORIGIN);
  try {
    const doc = connection.document!;
    const sources = trustedSources(doc, documentId);
    const pm = pmDocOf(doc.getXmlFragment(tabFragmentName(MAIN_TAB)));
    const position = new Map<string, number>();
    pm.descendants((node, pos) => {
      if (node.type.name === 'blockContainer') position.set(node.attrs.id as string, pos);
      return true;
    });
    const at = (e: SourceEntry) => Math.min(...e.groupIds.map((id) => position.get(id) ?? Infinity));
    return [...sources]
      .map(([key, entry]) => ({ key, entry, lead: leadingType(entry.slice) }))
      .sort((a, b) => at(a.entry) - at(b.entry));
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}

/** The new file's groups, in order, each with its blocks as nodes (ids kept). */
function theirGroups(theirs: ImportResult): TheirGroup[] {
  const doc = serverEditor()._blocksToProsemirrorNode(theirs.blocks as never);
  const byId = new Map<string, PmNode>();
  doc.firstChild!.forEach((child) => byId.set(child.attrs.id as string, child));
  return [...theirs.sources.values()].map((entry) => ({
    entry,
    lead: leadingType(entry.slice),
    nodes: entry.groupIds.map((id) => byId.get(id)!),
  }));
}

function leadingType(slice: string): string {
  return md.parse(slice, {})[0]?.type ?? 'raw';
}

type Pair = { j: number; same: boolean };

/**
 * Base group index → theirs group index. Identical slices first (first unused
 * match, in order); then, among the rest, pairs with the same leading token
 * type and similarity ≥ 0.5, best first, kept only if they don't cross a pair
 * already taken (relative order).
 *
 * The file is untrusted and edit distance is quadratic, so fuzzy alignment is
 * bounded: similarity stops once a pair can't reach 0.5, slices over 4 KB
 * align by identity only, and once `budget` character pairs are spent the
 * rest does too. `identityOnly` says some groups weren't compared.
 */
export function align(
  base: { entry: SourceEntry; lead: string }[],
  their: { entry: SourceEntry; lead: string }[],
  budget = FUZZY_BUDGET,
): { pairs: Map<number, Pair>; identityOnly: boolean } {
  const pairs = new Map<number, Pair>();
  const usedBase = new Set<number>();
  const usedTheirs = new Set<number>();
  their.forEach((t, j) => {
    const i = base.findIndex((b, k) => !usedBase.has(k) && b.entry.slice === t.entry.slice);
    if (i < 0) return;
    pairs.set(i, { j, same: true });
    usedBase.add(i);
    usedTheirs.add(j);
  });

  const candidates: { i: number; j: number; score: number }[] = [];
  let identityOnly = false;
  let spent = 0;
  const fuzzy = (slice: string) => {
    if (slice.length <= MAX_FUZZY_SLICE) return true;
    identityOnly = true;
    return false;
  };
  base.forEach((b, i) => {
    if (usedBase.has(i) || !fuzzy(b.entry.slice)) return;
    their.forEach((t, j) => {
      if (spent >= budget) return;
      if (usedTheirs.has(j) || b.lead !== t.lead || !fuzzy(t.entry.slice)) return;
      const [x, y] = [b.entry.slice.trim().length, t.entry.slice.trim().length];
      // Edit distance is at least the length difference: skip hopeless pairs.
      if (Math.min(x, y) < MIN_SIMILARITY * Math.max(x, y)) return;
      const cost = similarityCost(b.entry.slice, t.entry.slice, MIN_SIMILARITY);
      if (spent + cost > budget) {
        spent = budget;
        identityOnly = true;
        return;
      }
      spent += cost;
      const score = similarity(b.entry.slice, t.entry.slice, MIN_SIMILARITY);
      if (score >= MIN_SIMILARITY) candidates.push({ i, j, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  for (const c of candidates) {
    if (usedBase.has(c.i) || usedTheirs.has(c.j)) continue;
    const crosses = [...pairs].some(([i, p]) => i < c.i !== p.j < c.j);
    if (crosses) continue;
    pairs.set(c.i, { j: c.j, same: false });
    usedBase.add(c.i);
    usedTheirs.add(c.j);
  }
  // A reference-style link reads its target from a definition elsewhere: with
  // the same slice but a changed definition, the group is not unchanged.
  const definition = (groups: { entry: SourceEntry }[], label: string) => groups.find((g) => g.entry.defines.includes(label))?.entry.slice;
  for (const [i, pair] of pairs) {
    if (pair.same && base[i]!.entry.refs.some((label) => definition(base, label) !== definition(their, label))) pair.same = false;
  }
  return { pairs, identityOnly };
}

/** The group's blocks are all there, siblings in order, and unchanged since
 *  import. */
function untouched(doc: PmNode, entry: SourceEntry): boolean {
  if (groupVersion(blockIndex(doc), entry.groupIds) !== entry.version) return false;
  const first = findBlock(doc, entry.groupIds[0]!)!;
  const $first = doc.resolve(first.pos);
  const index = $first.index();
  return entry.groupIds.every((id, k) => $first.parent.maybeChild(index + k)?.attrs.id === id);
}

function changed(entry: SourceEntry): Refusal {
  return {
    code: 'target_changed',
    message: `Block ${entry.groupIds[0]} was edited since it was published; the new text was suggested instead.`,
    fix: 'Decide the suggestion.',
    details: { blockId: entry.groupIds[0] },
  };
}

/** Any of the blocks carries a comment mark. */
function commented(doc: PmNode, ids: string[]): boolean {
  return ids.some((id) => {
    let found = false;
    findBlock(doc, id)?.node.descendants((node) => {
      if (node.marks.some((m) => m.type.name === 'comment')) found = true;
      return !found;
    });
    return found;
  });
}

function commentedRefusal(entry: SourceEntry): Refusal {
  return {
    code: 'target_changed',
    message: `Block ${entry.groupIds[0]} has comments on it; the new text was suggested instead so they are not lost.`,
    fix: 'Decide the suggestion.',
    details: { blockId: entry.groupIds[0] },
  };
}

/** Removes every block of the group that is still there. */
function removeGroup(tr: Transform, ids: string[]) {
  for (const id of [...ids].reverse()) {
    const at = findBlock(tr.doc, id);
    if (at) tr.delete(at.pos, at.pos + at.node.nodeSize);
  }
}

function removeEdit(group: BaseGroup): PlannedEdit {
  return {
    target: { tabId: MAIN_TAB, blockId: group.entry.groupIds[0]! },
    inverse: false,
    source: { drop: group.key },
    // An edited group the new file dropped stays as it is.
    build: (tr) => {
      if (!untouched(tr.doc, group.entry)) return;
      removeGroup(tr, group.entry.groupIds);
    },
  };
}

function replaceEdit(group: BaseGroup, their: TheirGroup): PlannedEdit {
  const firstId = group.entry.groupIds[0]!;
  const nodes = their.nodes.map((n, k) => (k === 0 ? n.type.create({ ...n.attrs, id: firstId }, n.content, n.marks) : n));
  // From now on the group's blocks are theirs, under the reused first id.
  their.entry = { ...their.entry, groupIds: [firstId, ...their.entry.groupIds.slice(1)] };
  return {
    target: { tabId: MAIN_TAB, blockId: firstId },
    inverse: false,
    source: { entry: their.entry },
    build: (tr, _at, ctx) => {
      if (!untouched(tr.doc, group.entry) && !ctx.suggesting) return changed(group.entry);
      if (!findBlock(tr.doc, firstId)) return changed(group.entry);
      // Replacing swaps in fresh blocks, which would drop comments on the old ones.
      if (!ctx.suggesting && commented(tr.doc, group.entry.groupIds)) return commentedRefusal(group.entry);
      removeGroup(tr, group.entry.groupIds.slice(1));
      const first = findBlock(tr.doc, firstId)!;
      tr.replaceWith(first.pos, first.pos + first.node.nodeSize, Fragment.fromArray(nodes));
    },
  };
}

/** Block ids a new group may follow, nearest first: the last block of each
 *  preceding theirs group, as theirs or as mine. */
function anchorsBefore(j: number, their: TheirGroup[], theirToBase: Map<number, { i: number }>, base: BaseGroup[]): string[] {
  const out: string[] = [];
  for (let k = j - 1; k >= 0; k--) {
    out.push(their[k]!.entry.groupIds.at(-1)!);
    const aligned = theirToBase.get(k);
    if (aligned) out.push(base[aligned.i]!.entry.groupIds.at(-1)!);
  }
  return out;
}

/** The first anchor that is a top-level block (other than `skip`), or null. */
function topLevelAnchor(doc: PmNode, anchors: string[], skip: string[] = []): { pos: number; node: PmNode } | null {
  for (const id of anchors) {
    if (skip.includes(id)) continue;
    const found = findBlock(doc, id);
    if (found && doc.resolve(found.pos).depth === 1) return found;
  }
  return null;
}

function insertEdit(group: TheirGroup, anchors: string[]): PlannedEdit {
  return {
    target: { tabId: MAIN_TAB, blockId: group.entry.groupIds[0]! },
    inverse: false,
    source: { entry: group.entry },
    build: (tr) => {
      // New groups go between top-level blocks: after the nearest top-level
      // anchor, else first.
      const anchor = topLevelAnchor(tr.doc, anchors);
      const pos = anchor ? anchor.pos + anchor.node.nodeSize : 1;
      tr.insert(pos, Fragment.fromArray(group.nodes));
    },
  };
}

/** An unchanged group the new file placed elsewhere: moved after the group
 *  that now precedes it (an edited one stays where it is). */
function moveEdit(group: BaseGroup, anchors: string[]): PlannedEdit {
  const ids = group.entry.groupIds;
  return {
    target: { tabId: MAIN_TAB, blockId: ids[0]! },
    inverse: false,
    build: (tr, _at, ctx) => {
      if (!untouched(tr.doc, group.entry)) return;
      const first = findBlock(tr.doc, ids[0]!)!;
      const anchor = topLevelAnchor(tr.doc, anchors, ids);
      if (anchor ? anchor.pos + anchor.node.nodeSize === first.pos : first.pos === 1) return;
      const nodes = ids.map((id) => findBlock(tr.doc, id)!.node);
      removeGroup(tr, ids);
      const now = topLevelAnchor(tr.doc, anchors, ids);
      tr.insert(now ? now.pos + now.node.nodeSize : 1, Fragment.fromArray(nodes));
      for (const id of ids) ctx.moved(id);
    },
  };
}
