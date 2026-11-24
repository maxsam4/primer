import * as Y from 'yjs';
import { Node as PmNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { v7 as uuidv7 } from 'uuid';
import type { BlockPlace, EditOutcome, Reconciliation, Refusal, Target } from '@polygonlabs/primer-api-types';
import { blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';
import { liveDocName, liveInstance } from './instance.ts';
import type { LiveOrigin } from './origin.ts';
import { persistedUpTo } from './persist.ts';
import { docQueue } from './queue.ts';
import { effectiveAgentMode } from '../lib/permissions.ts';
import { fragmentName } from './reach.ts';
import { storeProposals, type Proposal, type SuggestedEdit } from './proposals.ts';
import type { SourceEntry } from './sources.ts';

export type { LiveOrigin } from './origin.ts';
export type { BlockPlace } from '@polygonlabs/primer-api-types';

/** The target block (a `blockContainer`) in the transform's current doc, or
 *  null when the fragment has no block with that id (a whole-fragment edit). */
export type Located = { pos: number; node: PmNode } | null;

/** What a build may tell the pipeline beyond its steps. */
export type BuildContext = {
  /** `blockId` moved: undo puts it back at its prior place. */
  moved(blockId: string): void;
  /**
   * True when the build runs to make a suggestion of an edit that conflicted
   * (`target_changed`): it should build what it would change against the
   * document as it is now, skipping its own staleness checks. Its steps are
   * never written; they become a stored suggestion.
   */
  suggesting: boolean;
};

export type PlannedEdit = {
  target: Target;
  /** The `block.version` the caller read; a mismatch makes this edit a conflict. */
  expectVersion?: string;
  /**
   * Adds steps to `tr`. Synchronous: it runs inside the document's queue, on a
   * transform of its own, so returning a Refusal (or throwing) drops every
   * step it added. A Refusal makes this edit a `conflict` (or, for
   * `target_changed` with `onConflict: 'suggest'`, a suggestion) and leaves
   * the other edits of the plan alone; a throw aborts the whole plan.
   */
  build: (tr: Transform, at: Located, ctx: BuildContext) => Refusal | void;
  /** Capture per-block inverses for undo (`BlockInverse`). */
  inverse: boolean;
  /** Called with the blocks the edit created or changed (as stored), once it applied. */
  applied?: (blocks: AppliedBlock[]) => void;
  /** The import provenance this edit gives its blocks (`entry`) or takes from
   *  a group it removes (`drop`, the entry's key). A suggestion of the edit
   *  carries it, so accepting it writes the same `sources`. */
  source?: { entry?: SourceEntry; drop?: string };
};

/**
 * One block an applied `inverse: true` edit created, removed, changed or
 * moved, enough to put it back:
 * - `prior`: the block's whole subtree (blockContainer JSON) before the edit,
 *   null when the edit created it;
 * - `afterVersion`: right after the edit, null when the edit removed it;
 *   undo's precondition. For a block the edit created it is the whole
 *   subtree's `blockVersion` (undo removes the subtree, so a person's later
 *   edit anywhere in it must stop that); otherwise the block's own content
 *   (`contentVersion`), so undoing a child never makes its parent stale;
 * - `place`: where the block was (parent, previous and next sibling ids),
 *   set when the edit removed or moved it.
 * Only the topmost block of a created or removed subtree is recorded.
 */
export type BlockInverse = {
  index: number;
  target: Target;
  prior: Record<string, unknown> | null;
  afterVersion: string | null;
  place: BlockPlace | null;
  /** Where a moved block stands after the edit (undo moves it back only from there). */
  afterPlace?: BlockPlace;
};

/** A block an edit created or changed, as stored, with its place in the tree. */
export type AppliedBlock = { node: PmNode; parentId: string | null; depth: number };

export type Plan = {
  edits: PlannedEdit[];
  /** `suggest` turns an edit whose target changed (`target_changed`) into a
   *  stored suggestion (status `suggested`) instead of a conflict. */
  onConflict: 'refuse' | 'suggest';
  /**
   * `suggest` forces every edit to become a stored suggestion (e.g. a run
   * whose requester can't edit). Without it the pipeline decides from the
   * origin: an agent whose effective mode on the document is `suggest`
   * (`effectiveAgentMode`) only ever suggests, whichever caller wrote the
   * plan (ops, undo, republish merges…).
   */
  mode?: 'suggest';
  /** Comment marks and other annotations: written as they are, never
   *  suggested. */
  annotation?: true;
  /** Groups the suggestions this plan makes (default: one per plan). */
  changeSetId?: string;
  /** Runs on the document's queue just before the mutation, with the live
   *  Y.Doc (e.g. to `dryRun` the plan); a refusal turns every edit into a
   *  conflict carrying it (e.g. a cancelled run). `suggesting`: every edit
   *  will become a suggestion, so the plan writes nothing. */
  guard?: (doc: Y.Doc, ctx: { suggesting: boolean }) => Promise<Refusal | null>;
  /** Runs on the queue after the edits are built and before the update
   *  commits (e.g. to write the run's inverses, so a crash can't leave an
   *  edit without them; if the write then fails the rows are inert: their
   *  `after_version` never matches). */
  beforeWrite?: (result: { inverses: BlockInverse[] }) => Promise<void>;
  /** Runs once the update is stored, with its docVersion. */
  afterPersist?: (result: { docVersion: number; inverses: BlockInverse[]; outcomes: EditOutcome[] }) => Promise<void>;
  /** Runs inside the write's Yjs transaction, after the fragments were
   *  written (e.g. to rewrite `sources`). Synchronous. */
  alsoWrite?: (doc: Y.Doc, outcomes: EditOutcome[], suggesting: boolean) => void;
  /** Runs on the document's queue right after the write, before anything
   *  else can change the document (DB work only; never awaits the pipeline). */
  afterWrite?: (outcomes: EditOutcome[]) => Promise<void>;
};

/**
 * The one way the server writes a live document (C4). Callers convert and
 * validate their input first. Then, on the document's queue, every
 * precondition is rechecked against the live fragments and every change is
 * built as a ProseMirror transform before anything is written; the result is
 * written with `updateYFragment` in one transaction whose origin is `origin`.
 * Untouched nodes keep their marks (comments, suggestions) and their Y items.
 * Yjs has no rollback, so an exception before the write leaves the document
 * untouched. Resolves once the update is stored.
 */
export async function applyPlan(documentId: string, origin: LiveOrigin, plan: Plan): Promise<Reconciliation> {
  const suggesting =
    plan.mode === 'suggest' ||
    (!plan.annotation && origin.kind === 'agent' && (await effectiveAgentMode(documentId, origin.actorId)) === 'suggest');
  const changeSetId = suggesting ? (plan.changeSetId ?? uuidv7()) : (plan.changeSetId ?? null);
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), origin);
  try {
    const doc = connection.document!;
    const step = await docQueue(documentId)(async () => {
      const refusal = plan.guard ? await plan.guard(doc, { suggesting }) : null;
      if (refusal) {
        const outcomes: EditOutcome[] = plan.edits.map((edit, index) => ({
          index,
          target: edit.target,
          status: 'conflict',
          refusal,
        }));
        return { outcomes, inverses: [] as BlockInverse[] };
      }
      const prepared = prepare(doc, plan, suggesting);
      if (plan.beforeWrite && prepared.inverses.length > 0) await plan.beforeWrite({ inverses: prepared.inverses });
      if (prepared.writes.length > 0 || plan.alsoWrite) {
        await connection.transact(() => {
          for (const write of prepared.writes) {
            updateYFragment(doc, write.fragment, write.doc, { mapping: new Map(), isOMark: new Map() });
          }
          plan.alsoWrite?.(doc, prepared.outcomes, suggesting);
        });
      }
      if (prepared.proposals.length > 0) await storeProposals(documentId, origin, changeSetId, prepared.proposals);
      if (plan.afterWrite) await plan.afterWrite(prepared.outcomes);
      return { outcomes: prepared.outcomes, inverses: prepared.inverses };
    });
    const docVersion = await persistedUpTo(doc);
    if (plan.afterPersist) await plan.afterPersist({ docVersion, inverses: step.inverses, outcomes: step.outcomes });
    return { docVersion, outcomes: step.outcomes };
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}

/** What a plan would do to the live document, block by block. */
export type DryRun = {
  /** Blocks added (nested ones included), changed or moved. */
  edits: number;
  /** Blocks gone afterwards, whole subtrees included. */
  removals: number;
  /** Some edit would not apply (a conflict, or a throw) while the others
   *  remove or move blocks. */
  unresolved: boolean;
};

/**
 * Runs the plan's own builds, exactly as `applyPlan` would, on scratch copies
 * of the live fragments, and counts by block id what the whole plan does:
 * whatever the order of its edits, a block present before and absent after
 * is a removal. Writes nothing. The edits should be side-effect free (no
 * cursor, notes or `applied`): they run again for real.
 */
export function dryRun(doc: Y.Doc, edits: PlannedEdit[]): DryRun {
  let out: ReturnType<typeof prepare>;
  try {
    out = prepare(doc, { edits, onConflict: 'refuse' }, false);
  } catch {
    return { edits: 0, removals: 0, unresolved: true };
  }
  let changed = 0;
  let removals = 0;
  for (const { before, after } of out.fragments) {
    const b = indexBlocks(before);
    const a = indexBlocks(after);
    for (const [id, old] of b) {
      const now = a.get(id);
      if (!now) removals++;
      else if (out.moved.has(id) || contentVersion(old.node) !== contentVersion(now.node)) changed++;
    }
    for (const id of a.keys()) if (!b.has(id)) changed++;
  }
  const conflicted = out.outcomes.some((o) => o.status === 'conflict');
  return { edits: changed, removals, unresolved: conflicted && (removals > 0 || out.moved.size > 0) };
}

/** Synchronous: locate, check, build and capture inverses for every edit;
 *  edits that become suggestions are diffed into proposals, never written. */
function prepare(doc: Y.Doc, plan: Plan, suggestMode: boolean) {
  const fragments = new Map<string, { fragment: Y.XmlFragment; tr: Transform; virtual?: Transform }>();
  const outcomes: EditOutcome[] = [];
  const inverses: BlockInverse[] = [];
  const movedAll = new Set<string>();
  const proposals: Proposal[] = [];

  /** Diffs a scratch transform into a stored suggestion; false when it
   *  changes no block. */
  const propose = (index: number, edit: PlannedEdit, scratch: Transform, moved: Set<string>, conflict: boolean): boolean => {
    const edits = forwardDiff(scratch.before, scratch.doc, moved, edit.target);
    if (edits.length === 0) return false;
    if (edit.source) {
      const carrier = edits.find((e) => e.target.blockId === (edit.source!.entry?.groupIds[0] ?? edit.target.blockId)) ?? edits[0]!;
      carrier.source = edit.source;
    }
    const id = uuidv7();
    proposals.push({ id, tabId: edit.target.tabId, edits, conflict });
    outcomes.push({
      index,
      target: edit.target,
      status: 'suggested',
      suggestionId: id,
      ...(conflict ? { note: 'The block changed since you read it; your edit was stored as a suggestion for a person to decide.' } : {}),
    });
    return true;
  };

  /** A conflicting edit, built again against the document as it is now. */
  const suggestInstead = (index: number, edit: PlannedEdit, base: PmNode, at: Located): boolean => {
    if (edit.expectVersion !== undefined && at === null) return false;
    const scratch = new Transform(base);
    const moved = new Set<string>();
    try {
      if (edit.build(scratch, at, { moved: (id) => moved.add(id), suggesting: true })) return false;
      if (scratch.steps.length === 0) return false;
      scratch.doc.check();
    } catch {
      return false;
    }
    return propose(index, edit, scratch, moved, true);
  };

  plan.edits.forEach((edit, index) => {
    const name = fragmentName(edit.target);
    let entry = fragments.get(name);
    if (!entry) {
      const fragment = doc.getXmlFragment(name);
      entry = { fragment, tr: new Transform(toPmDoc(fragment)) };
      fragments.set(name, entry);
    }
    // Suggestions are never written, but each is built on the document as the
    // earlier ones would leave it, so two new neighbours anchor in order.
    if (suggestMode && !entry.virtual) entry.virtual = new Transform(entry.tr.doc);
    const base = suggestMode ? entry.virtual!.doc : entry.tr.doc;
    const at = findBlock(base, edit.target.blockId);
    const conflict = (refusal: Refusal) => {
      if (refusal.code === 'target_changed' && plan.onConflict === 'suggest' && suggestInstead(index, edit, base, at)) return;
      outcomes.push({ index, target: edit.target, status: 'conflict', refusal });
    };
    if (edit.expectVersion !== undefined) {
      const current = at ? blockVersion(at.node) : null;
      if (current !== edit.expectVersion) return conflict(targetChanged(edit.target, current));
    }
    const scratch = new Transform(base);
    const moved = new Set<string>();
    const refusal = edit.build(scratch, at, { moved: (id) => moved.add(id), suggesting: false });
    if (refusal) return conflict(refusal);
    if (scratch.steps.length === 0) {
      outcomes.push({ index, target: edit.target, status: 'unchanged' });
      return;
    }
    try {
      scratch.doc.check();
    } catch (err) {
      outcomes.push({ index, target: edit.target, status: 'conflict', refusal: invalidStructure(err) });
      return;
    }
    if (suggestMode) {
      if (!propose(index, edit, scratch, moved, false)) outcomes.push({ index, target: edit.target, status: 'unchanged' });
      else for (const step of scratch.steps) entry.virtual!.step(step);
      return;
    }
    for (const step of scratch.steps) entry.tr.step(step);
    for (const id of moved) movedAll.add(id);
    outcomes.push({ index, target: edit.target, status: 'applied' });
    if (edit.inverse || edit.applied) {
      const diff = blockDiff(scratch.before, scratch.doc, moved);
      if (edit.inverse) {
        for (const { blockId, ...inv } of diff.inverses) inverses.push({ ...inv, index, target: { ...edit.target, blockId } });
      }
      edit.applied?.(diff.touched);
    }
  });

  const writes = [...fragments.values()]
    .filter((entry) => entry.tr.docChanged)
    .map((entry) => ({ fragment: entry.fragment, doc: entry.tr.doc }));
  const docs = [...fragments.values()].map((entry) => ({ before: entry.tr.before, after: entry.tr.doc }));
  return { outcomes, inverses, writes, fragments: docs, moved: movedAll, proposals };
}

/** A block's own content (type, props, inline content), without its
 *  children: what undo restores and checks, so undoing a child never makes
 *  its parent's undo stale. */
export function contentVersion(blockContainer: PmNode): string {
  return blockVersion(blockContainer.firstChild!);
}

type Indexed = { node: PmNode; place: BlockPlace; depth: number };

/** Every block of a fragment doc by id, with its place. */
export function indexBlocks(root: PmNode): Map<string, Indexed> {
  const out = new Map<string, Indexed>();
  const walk = (group: PmNode, parentId: string | null, depth: number) => {
    const children: PmNode[] = [];
    group.forEach((child) => {
      if (child.type.name === 'blockContainer') children.push(child);
    });
    children.forEach((child, i) => {
      const id = child.attrs.id as string;
      out.set(id, {
        node: child,
        place: {
          parentId,
          prevId: i > 0 ? (children[i - 1]!.attrs.id as string) : null,
          nextId: i < children.length - 1 ? (children[i + 1]!.attrs.id as string) : null,
        },
        depth,
      });
      child.forEach((grand) => {
        if (grand.type.name === 'blockGroup') walk(grand, id, depth + 1);
      });
    });
  };
  root.forEach((child) => {
    if (child.type.name === 'blockGroup') walk(child, null, 0);
  });
  return out;
}

/** Indexes of `seq` (distinct numbers) that make a longest increasing subsequence. */
export function longestIncreasing(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  seq.forEach((value, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let i = tails.length > 0 ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) keep.add(i);
  return keep;
}

/** Blocks present in both docs that changed parent or, within their parent,
 *  left the longest run of siblings that kept their relative order. */
export function movedBlocks(before: PmNode, after: PmNode): Set<string> {
  const b = indexBlocks(before);
  const a = indexBlocks(after);
  const moved = new Set<string>();
  const order = new Map<string, number>();
  for (const id of a.keys()) order.set(id, order.size);
  const byParent = new Map<string | null, string[]>();
  for (const [id, old] of b) {
    const now = a.get(id);
    if (!now) continue;
    if (now.place.parentId !== old.place.parentId) {
      moved.add(id);
      continue;
    }
    const siblings = byParent.get(old.place.parentId) ?? [];
    siblings.push(id);
    byParent.set(old.place.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    const keep = longestIncreasing(siblings.map((id) => order.get(id)!));
    siblings.forEach((id, i) => {
      if (!keep.has(i)) moved.add(id);
    });
  }
  return moved;
}

/** The blocks one edit created, removed, changed or moved. */
function blockDiff(before: PmNode, after: PmNode, moved: Set<string>) {
  const b = indexBlocks(before);
  const a = indexBlocks(after);
  const inverses: (Omit<BlockInverse, 'index' | 'target'> & { blockId: string })[] = [];
  const touched: AppliedBlock[] = [];
  for (const [id, old] of b) {
    const now = a.get(id);
    if (!now) {
      const parent = old.place.parentId;
      if (parent !== null && b.has(parent) && !a.has(parent)) continue;
      inverses.push({ blockId: id, prior: old.node.toJSON(), afterVersion: null, place: old.place });
      continue;
    }
    const changed = contentVersion(old.node) !== contentVersion(now.node);
    if (changed) touched.push({ node: now.node, parentId: now.place.parentId, depth: now.depth });
    if (changed || moved.has(id)) {
      inverses.push({
        blockId: id,
        prior: old.node.toJSON(),
        afterVersion: contentVersion(now.node),
        place: moved.has(id) ? old.place : null,
        ...(moved.has(id) ? { afterPlace: now.place } : {}),
      });
    }
  }
  const created: typeof inverses = [];
  for (const [id, now] of a) {
    if (b.has(id)) continue;
    const parent = now.place.parentId;
    if (parent !== null && a.has(parent) && !b.has(parent)) continue;
    touched.push({ node: now.node, parentId: now.place.parentId, depth: now.depth });
    // Checked without the blocks it was given that were there before (an
    // add's `existing`): undo moves those back out before removing it.
    const own = PmNode.fromJSON(now.node.type.schema, withoutBlocks(now.node.toJSON(), b));
    created.push({ blockId: id, prior: null, afterVersion: blockVersion(own), place: null });
  }
  // Undo replays newest first: the other blocks go back in reading order, so
  // each finds its previous sibling already in place, and created blocks go last.
  return { inverses: [...created, ...inverses.reverse()], touched };
}

/**
 * What one edit would change, block by block, as forward edits a person can
 * accept later (live/suggest.ts replays them): created subtrees are
 * `insert`s at their new place, removed ones `delete`s (base: the whole
 * subtree's version), changed blocks `replace` their own content (base: the
 * content version), moved ones `move`. Only the topmost block of a created or
 * removed subtree is recorded.
 */
function forwardDiff(before: PmNode, after: PmNode, moved: Set<string>, at: Target): SuggestedEdit[] {
  const b = indexBlocks(before);
  const a = indexBlocks(after);
  const out: SuggestedEdit[] = [];
  // Page text and widget labels keep their fragment: its one paragraph has
  // the owning block's id (page/text.ts), so the target names both.
  const sub = at.pid ? { pid: at.pid } : at.textId ? { textId: at.textId } : {};
  const target = (blockId: string): Target => ({ tabId: at.tabId, blockId, ...sub });
  for (const [id, old] of b) {
    if (a.has(id)) continue;
    const parent = old.place.parentId;
    if (parent !== null && b.has(parent) && !a.has(parent)) continue;
    out.push({ kind: 'delete', target: target(id), base: blockVersion(old.node), proposed: null, place: null });
  }
  // In reading order, so a block moved after a sibling that also moved finds it in place.
  for (const [id, now] of a) {
    const old = b.get(id);
    if (old) {
      const changed = contentVersion(old.node) !== contentVersion(now.node);
      const place = moved.has(id) ? now.place : null;
      if (changed) out.push({ kind: 'replace', target: target(id), base: contentVersion(old.node), proposed: now.node.toJSON(), place });
      else if (place) out.push({ kind: 'move', target: target(id), base: contentVersion(old.node), proposed: null, place });
      continue;
    }
    const parent = now.place.parentId;
    if (parent !== null && a.has(parent) && !b.has(parent)) continue;
    // Blocks that were there already and moved in are moves of their own, not part of the insert.
    out.push({ kind: 'insert', target: target(id), base: null, proposed: withoutBlocks(now.node.toJSON(), b), place: now.place });
  }
  return out;
}

/** A subtree's JSON without the blocks (with their children) in `drop`. */
function withoutBlocks(json: Record<string, unknown>, drop: Map<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(json.content)) return json;
  const content = (json.content as Record<string, unknown>[])
    .filter((child) => !(child.type === 'blockContainer' && drop.has((child.attrs as { id: string }).id)))
    .map((child) => withoutBlocks(child, drop))
    .filter((child) => !(child.type === 'blockGroup' && (child.content as unknown[] | undefined ?? []).length === 0));
  return { ...json, content };
}

function toPmDoc(fragment: Y.XmlFragment): PmNode {
  const schema = serverEditor().editor.pmSchema;
  if (fragment.length === 0) return schema.topNodeType.createAndFill()!;
  const node = PmNode.fromJSON(schema, yXmlFragmentToProsemirrorJSON(fragment));
  node.check();
  return node;
}

function targetChanged(target: Target, current: string | null): Refusal {
  return {
    code: 'target_changed',
    message: current
      ? `Block ${target.blockId} changed since you read it.`
      : `Block ${target.blockId} no longer exists.`,
    fix: 'Read the block again and retry with its current version.',
    details: { blockId: target.blockId, version: current },
  };
}

function invalidStructure(err: unknown): Refusal {
  return {
    code: 'invalid_op',
    message: `The edit would leave the document invalid: ${err instanceof Error ? err.message : String(err)}`,
    fix: 'Change the op so every block keeps a valid place and content (for example, update a block instead of removing the last one).',
  };
}
