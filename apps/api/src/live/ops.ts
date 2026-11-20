import { pinCitations } from './citations.ts';
import { writesDecisionProp } from './choices.ts';
import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import type { Transform } from '@tiptap/pm/transform';
import { sql } from 'drizzle-orm';
import {
  isTarget,
  type BlockInput,
  type EditOutcome,
  type LiveBlockDTO,
  type Reconciliation,
  type Refusal,
  type Target,
} from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { readableLiveDoc } from '../lib/liveThreads.ts';
import { canEdit } from '../lib/permissions.ts';
import { blockVersion, findBlock } from './blocks.ts';
import { InputError, inputToBlocks } from './convert.ts';
import { originFor } from './origin.ts';
import { applyPlan, dryRun, type AppliedBlock, type Located, type PlannedEdit } from './pipeline.ts';
import { appliedBlockDTO } from './read.ts';
import { rebaseUpdate, type UpdateInput } from './rebase.ts';
import { activeRequestedRunIds, finishDirectRun, runHooks, startDirectRun } from './runs.ts';
import { setPidText } from '../page/text.ts';

export type { BlockInput, LiveOp, ApplyOpsRequest } from '@polygonlabs/primer-api-types';

const MAX_OPS = 200;
const MAX_BLOCKS_PER_OP = 500;
const VERSION = /^[0-9a-f]{16}$/;

type RunHooks = Exclude<Awaited<ReturnType<typeof runHooks>>, Refusal>;

export type OpError = { index: number; refusal: Refusal };
export type ApplyOpsResult =
  | { ok: true; value: Reconciliation }
  | { ok: false; status: 400 | 403 | 404 | 409; refusal: Refusal; errors?: OpError[] };

/** One op, validated and converted, ready to become a PlannedEdit. */
type Prepared =
  | { op: 'add'; at: Target; position: 'before' | 'after'; nodes: PmNode[]; input: BlockInput[] }
  | { op: 'update'; target: Target; expectVersion: string; input: UpdateInput; raw: BlockInput }
  | { op: 'replaceRange'; from: Target; to: Target; expectVersions: Record<string, string>; nodes: PmNode[]; input: BlockInput[] }
  | { op: 'delete'; target: Target; expectVersion: string }
  | { op: 'pageText'; target: Target; expectVersion: string; text: string }
  | { op: 'move'; target: Target; at: Target; position: 'before' | 'after'; expectVersion: string };

/**
 * Agents edit a live document by block (plan M4.2). Every op is validated and
 * its input converted first; one bad op rejects the whole batch with an
 * indexed refusal per op. Then each op becomes one PlannedEdit through the
 * pipeline: on the document's queue its preconditions are rechecked, so a
 * stale op is a `conflict` (`target_changed`) while the others apply; an op
 * that removes text of an open comment thread is refused
 * `deletes_commented_text` unless `allowCommentedDelete`.
 *
 * An agent's batch always runs under a run (its budget, cancel and undo):
 * the `runId` it names, else a direct run opened for this batch alone; while
 * the agent has a run a person asked for on this document, a batch without
 * its `runId` is refused `run_required`.
 *
 * `onConflict: 'suggest'` turns a stale op into a stored suggestion instead
 * of a conflict. An agent in suggest mode (`effectiveAgentMode`, decided in
 * the pipeline), or a run whose requester can't edit, gets every op stored as
 * a suggestion: status `suggested` with its `suggestionId`, as does a batch
 * sent with `mode: 'suggest'` (people suggesting, including commenters).
 */
export async function applyOps(documentId: string, actor: AuthUser, raw: unknown): Promise<ApplyOpsResult> {
  const doc = await readableLiveDoc(documentId, actor);
  if (!doc) {
    return { ok: false, status: 404, refusal: refusal('not_found', 'Live document not found.', 'Check the document id.') };
  }
  const req = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // `mode: 'suggest'` stores every op as a suggestion: a person suggesting
  // instead of editing, which anyone who may comment can do.
  const suggestOnly = req.mode === 'suggest';
  if (!canEdit(doc.role) && !(suggestOnly && actor.kind === 'person')) {
    return {
      ok: false,
      status: 403,
      refusal: refusal('forbidden', 'Only the owner and editors can edit this document.', 'Comment instead (primer_create_thread).'),
    };
  }
  if (!Array.isArray(req.ops) || req.ops.length === 0 || req.ops.length > MAX_OPS) {
    return reject([], `ops must be a list of 1–${MAX_OPS} ops.`);
  }
  if (req.runId !== undefined && typeof req.runId !== 'string') return reject([], 'runId must be a string.');
  const onConflict = req.onConflict === 'suggest' ? 'suggest' : 'refuse';
  const allowCommentedDelete = req.allowCommentedDelete === true;

  const prepared: Prepared[] = [];
  const errors: OpError[] = [];
  for (const [index, op] of (req.ops as unknown[]).entries()) {
    const decisionProp = actor.kind === 'agent' ? writesDecisionProp(op) : null;
    if (decisionProp) {
      errors.push({
        index,
        refusal: invalid(`${decisionProp} is set only when a person decides a choice.`, 'Propose an option with primer_propose_pick instead.'),
      });
      continue;
    }
    const unpinned = await pinCitations(actor, op);
    if (unpinned) {
      errors.push({ index, refusal: invalid(unpinned, 'Cite a document you can read (docId, optionally versionNumber) or an http(s) url.') });
      continue;
    }
    const out = await prepareOp(op);
    if ('error' in out) errors.push({ index, refusal: invalid(out.error, out.fix) });
    else prepared.push(out);
  }
  if (errors.length > 0) return reject(errors, `${errors.length} of ${req.ops.length} ops are invalid; nothing was applied.`);

  // Every agent write is scoped to a run: the one it names, or (with no run
  // active on this document) one the server opens for this batch alone.
  let runId = typeof req.runId === 'string' ? req.runId : null;
  let direct = false;
  if (actor.kind === 'agent' && runId === null) {
    const active = await activeRequestedRunIds(documentId, actor.id);
    if (active.length > 0) {
      return {
        ok: false,
        status: 409,
        refusal: {
          code: 'run_required',
          message: `You have an active run on this document (${active.join(', ')}); its edits must go through it.`,
          fix: `Send the ops again with runId: "${active[0]}".`,
          details: { runIds: active },
        },
      };
    }
    runId = await startDirectRun(documentId, actor);
    direct = true;
  }
  let error: string | null = null;
  try {
    return await applyScoped(documentId, actor, runId, direct, { prepared, onConflict, allowCommentedDelete, suggestOnly });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    if (direct) await finishDirectRun(runId!, error);
  }
}

async function applyScoped(
  documentId: string,
  actor: AuthUser,
  runId: string | null,
  direct: boolean,
  {
    prepared,
    onConflict,
    allowCommentedDelete,
    suggestOnly,
  }: { prepared: Prepared[]; onConflict: 'refuse' | 'suggest'; allowCommentedDelete: boolean; suggestOnly: boolean },
): Promise<ApplyOpsResult> {
  let hooks: RunHooks | null = null;
  if (runId !== null) {
    const out = await runHooks(documentId, actor, runId);
    if ('code' in out) {
      return { ok: false, status: out.code === 'not_found' ? 404 : 409, refusal: out };
    }
    hooks = out;
  }

  const open = new Set<string>();
  const notes = new Map<number, string>();
  const applied = new Map<number, AppliedBlock[]>();
  const edits = prepared.map((p, index) =>
    toEdit(p, {
      inverse: hooks !== null,
      open,
      allowCommentedDelete,
      note: (n) => notes.set(index, n),
      applied: (blocks) => applied.set(index, blocks),
      // A direct run ends with this batch: no cursor left behind.
      onTarget: direct ? undefined : hooks?.onTarget,
    }),
  );
  // The same builds without side effects, for the budget's dry run.
  const inert = prepared.map((p) => toEdit(p, { inverse: false, open, allowCommentedDelete, note: () => {} }));

  const result = await applyPlan(documentId, originFor(actor, runId), {
    edits,
    onConflict,
    // A run whose requester can't edit only suggests; the pipeline itself
    // makes an agent in suggest mode suggest.
    mode: suggestOnly || hooks?.suggestOnly ? 'suggest' : undefined,
    guard: async (doc, { suggesting }) => {
      // Threads first: the dry run must refuse what the real apply refuses.
      for (const id of await openThreadIds(documentId)) open.add(id);
      if (hooks) {
        // The run's budget is charged with what the batch does to the live
        // document, counted by a dry run of these very edits. Suggestions
        // write nothing, so a batch that only suggests is charged nothing
        // (the guard still refuses a cancelled run).
        const work = suggesting ? { edits: 0, removals: 0, unresolved: false } : dryRun(doc, inert);
        const refused = await hooks.guard(work);
        if (refused) return refused;
      }
      return null;
    },
    afterPersist: hooks?.afterPersist,
  });

  const outcomes: EditOutcome[] = [];
  for (const outcome of result.outcomes) {
    const out: EditOutcome = { ...outcome };
    const blocks = applied.get(outcome.index);
    if (blocks && blocks.length > 0) {
      out.blocks = await Promise.all(blocks.map((b) => appliedBlockDTO(b, outcome.target.tabId)));
      const wrote = writtenMarkdown(prepared[outcome.index]!);
      const stored = out.blocks.map((b) => b.markdown ?? '').join('\n\n');
      if (wrote !== null && normalize(wrote) !== normalize(stored)) {
        notes.set(outcome.index, [notes.get(outcome.index), `You wrote:\n${wrote}\nWe stored:\n${stored}`].filter(Boolean).join('\n'));
      }
    }
    const note = notes.get(outcome.index);
    if (note) out.note = note;
    outcomes.push(out);
  }
  return { ok: true, value: { docVersion: result.docVersion, outcomes } };
}

async function prepareOp(raw: unknown): Promise<Prepared | { error: string; fix: string }> {
  if (!raw || typeof raw !== 'object') return { error: 'An op is an object with an `op` field.', fix: 'Send { op: "add" | "update" | "replaceRange" | "delete" | "move", … }.' };
  const op = raw as Record<string, unknown>;
  const target = (name: string): Target | { error: string; fix: string } => {
    const t = op[name];
    if (!isTarget(t)) return { error: `\`${name}\` must be a target { tabId, blockId }.`, fix: 'Use the target of a block from primer_get_doc.' };
    if (t.pid && name === 'target' && op.op === 'update') return { tabId: t.tabId, blockId: t.blockId, pid: t.pid };
    if (t.textId && name === 'target' && op.op === 'update') return { tabId: t.tabId, blockId: t.blockId, textId: t.textId };
    if (t.pid || t.textId || t.embedId) {
      return {
        error: 'Page text and widget labels are edited only with `update` (plain text); embeds are not editable by ops yet.',
        fix: 'Send { op: "update", target: { tabId, blockId, pid } or { tabId, blockId, textId }, expectVersion, block: "the new text" }.',
      };
    }
    return { tabId: t.tabId, blockId: t.blockId };
  };
  const version = (v: unknown) => typeof v === 'string' && VERSION.test(v);
  const position = op.position === 'before' || op.position === 'after' ? op.position : null;
  const blocks = async (list: unknown): Promise<{ nodes: PmNode[]; input: BlockInput[] } | { error: string; fix: string }> => {
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BLOCKS_PER_OP) {
      return { error: `\`blocks\` must list 1–${MAX_BLOCKS_PER_OP} blocks.`, fix: 'Send at least one block.' };
    }
    const nodes: PmNode[] = [];
    for (const input of list) {
      const converted = await convert(input as BlockInput);
      if ('error' in converted) return converted;
      nodes.push(...converted.nodes);
    }
    if (nodes.length === 0) return { error: 'The blocks are empty.', fix: 'Send some content.' };
    return { nodes, input: list as BlockInput[] };
  };

  switch (op.op) {
    case 'add': {
      const at = target('at');
      if ('error' in at) return at;
      if (!position) return { error: '`position` must be "before" or "after".', fix: 'Say where the blocks go relative to `at`.' };
      const b = await blocks(op.blocks);
      if ('error' in b) return b;
      return { op: 'add', at, position, ...b };
    }
    case 'update': {
      const t = target('target');
      if ('error' in t) return t;
      if (!version(op.expectVersion)) return missingVersion('expectVersion');
      if (t.pid) {
        // Page text is plain text (newlines are line breaks): the page owns its markup.
        if (typeof op.block !== 'string' || op.block.length > 10_000) {
          return { error: 'Page text takes `block` as a plain-text string (up to 10,000 characters).', fix: 'Send the element\'s new text as a string.' };
        }
        return { op: 'pageText', target: t, expectVersion: op.expectVersion as string, text: op.block };
      }
      if (t.textId) {
        // A widget label is one line of plain text (widgets/labels.ts).
        if (typeof op.block !== 'string' || op.block.length > 500) {
          return { error: 'A widget label takes `block` as one line of plain text (up to 500 characters).', fix: 'Send the label\'s new words as a string.' };
        }
        return { op: 'pageText', target: t, expectVersion: op.expectVersion as string, text: op.block.replace(/\s+/g, ' ').trim() };
      }
      const converted = await convert(op.block as BlockInput);
      if ('error' in converted) return converted;
      if (converted.nodes.length !== 1 || converted.nodes[0]!.childCount > 1) {
        return {
          error: `update takes exactly one block without children; the input made ${converted.nodes.length} block(s).`,
          fix: 'Send one block; use replaceRange to turn one block into several, and add for children.',
        };
      }
      const input: UpdateInput = { kind: converted.kind, node: converted.nodes[0]!, props: converted.props, keys: converted.keys };
      return { op: 'update', target: t, expectVersion: op.expectVersion as string, input, raw: op.block as BlockInput };
    }
    case 'replaceRange': {
      const from = target('from');
      if ('error' in from) return from;
      const to = target('to');
      if ('error' in to) return to;
      if (from.tabId !== to.tabId) return { error: '`from` and `to` must be in the same tab.', fix: 'Replace a range within one tab.' };
      const ev = op.expectVersions;
      if (!ev || typeof ev !== 'object' || !Object.values(ev).every(version) || !(from.blockId in ev) || !(to.blockId in ev)) {
        return {
          error: '`expectVersions` must map every block id in the range (from `from` to `to`) to the version you read.',
          fix: 'Read the range with primer_get_doc and send each block\'s version.',
        };
      }
      const b = await blocks(op.blocks);
      if ('error' in b) return b;
      return { op: 'replaceRange', from, to, expectVersions: ev as Record<string, string>, ...b };
    }
    case 'delete': {
      const t = target('target');
      if ('error' in t) return t;
      if (!version(op.expectVersion)) return missingVersion('expectVersion');
      return { op: 'delete', target: t, expectVersion: op.expectVersion as string };
    }
    case 'move': {
      const t = target('target');
      if ('error' in t) return t;
      const at = target('at');
      if ('error' in at) return at;
      if (!position) return { error: '`position` must be "before" or "after".', fix: 'Say where the block goes relative to `at`.' };
      if (!version(op.expectVersion)) return missingVersion('expectVersion');
      if (t.tabId !== at.tabId) return { error: 'A block moves within its tab.', fix: 'Pick an `at` block in the same tab.' };
      if (t.blockId === at.blockId) return { error: 'A block can\'t move relative to itself.', fix: 'Pick another `at` block.' };
      return { op: 'move', target: t, at, position, expectVersion: op.expectVersion as string };
    }
    default:
      return { error: `Unknown op ${JSON.stringify(op.op)}.`, fix: 'Use add, update, replaceRange, delete or move.' };
  }
}

async function convert(input: BlockInput) {
  try {
    const out = await inputToBlocks(input);
    return out;
  } catch (err) {
    if (err instanceof InputError) return { error: err.message, fix: 'Send Markdown, { html } with one element, or { json } BlockNote partial-block JSON.' };
    throw err;
  }
}

type EditContext = {
  inverse: boolean;
  open: Set<string>;
  allowCommentedDelete: boolean;
  note: (note: string) => void;
  applied?: (blocks: AppliedBlock[]) => void;
  onTarget?: (target: Target) => void;
};

function toEdit(p: Prepared, ctx: EditContext): PlannedEdit {
  const base = { inverse: ctx.inverse, applied: ctx.applied };
  const guarded = (target: Target, build: PlannedEdit['build']): PlannedEdit['build'] => (tr, at, bctx) => {
    ctx.onTarget?.(target);
    const refused = build(tr, at, bctx);
    if (refused) return refused;
    if (ctx.allowCommentedDelete) return;
    return droppedComments(tr.before, tr.doc, ctx.open);
  };

  switch (p.op) {
    case 'add':
      return {
        ...base,
        target: p.at,
        build: guarded(p.at, (tr, at) => {
          if (!at) return gone(p.at);
          tr.insert(p.position === 'before' ? at.pos : at.pos + at.node.nodeSize, Fragment.fromArray(p.nodes));
        }),
      };
    case 'update':
      return {
        ...base,
        target: p.target,
        expectVersion: p.expectVersion,
        build: guarded(p.target, (tr, at) => {
          const note = rebaseUpdate(tr, at!, p.input);
          if (note) ctx.note(note);
        }),
      };
    case 'pageText': {
      const edit = setPidText(p.target, p.text);
      return { ...base, target: p.target, expectVersion: p.expectVersion, build: guarded(p.target, edit.build) };
    }
    case 'delete':
      return {
        ...base,
        target: p.target,
        expectVersion: p.expectVersion,
        build: guarded(p.target, (tr, at) => removeBlock(tr, at!)),
      };
    case 'move':
      return {
        ...base,
        target: p.target,
        expectVersion: p.expectVersion,
        build: guarded(p.target, (tr, at, bctx) => {
          const node = at!.node;
          const anchor = findBlock(tr.doc, p.at.blockId);
          if (!anchor) return gone(p.at);
          if (anchor.pos > at!.pos && anchor.pos < at!.pos + node.nodeSize) {
            return invalid('A block can\'t move inside itself.', 'Pick an `at` block outside the moved block.');
          }
          const removed = removeBlock(tr, at!);
          if (removed) return removed;
          const there = findBlock(tr.doc, p.at.blockId)!;
          tr.insert(p.position === 'before' ? there.pos : there.pos + there.node.nodeSize, node);
          bctx.moved(node.attrs.id as string);
        }),
      };
    case 'replaceRange':
      return {
        ...base,
        target: p.from,
        expectVersion: p.expectVersions[p.from.blockId],
        build: guarded(p.from, (tr, at, bctx) => {
          const range = rangeOf(tr.doc, at!, p.to.blockId);
          if (!range) return invalid('`to` is not a later sibling of `from`.', 'Pick `to` among the siblings after `from` (same parent).');
          const { end } = range;
          const ids = range.blocks.map((b) => b.attrs.id as string);
          const stale: { blockId: string; version: string | null }[] = [];
          for (const id of ids) {
            const found = findBlock(tr.doc, id)!;
            const current = blockVersion(found.node);
            if (p.expectVersions[id] === undefined) {
              return invalid(`Block ${id} is in the range but not in expectVersions.`, 'Send the version of every block from `from` to `to`.');
            }
            if (p.expectVersions[id] !== current) stale.push({ blockId: id, version: current });
          }
          const extra = Object.keys(p.expectVersions).filter((id) => !ids.includes(id));
          if (extra.length > 0) return invalid(`expectVersions names blocks outside the range: ${extra.join(', ')}.`, 'Send versions for the range\'s blocks only.');
          if (stale.length > 0 && !bctx.suggesting) {
            return {
              code: 'target_changed',
              message: `${stale.length} block(s) in the range changed since you read them.`,
              fix: 'Read the range again and retry with the current versions.',
              details: { blocks: stale },
            };
          }
          tr.replaceWith(at!.pos, end, Fragment.fromArray(p.nodes));
        }),
      };
  }
}

/** The sibling blocks from `at` through `toBlockId`, and the position after
 *  the last one; null when `toBlockId` is not a later sibling. */
function rangeOf(doc: PmNode, at: NonNullable<Located>, toBlockId: string): { blocks: PmNode[]; end: number } | null {
  const $from = doc.resolve(at.pos);
  const parent = $from.parent;
  const blocks: PmNode[] = [];
  let pos = at.pos;
  for (let i = $from.index(); i < parent.childCount; i++) {
    const child = parent.child(i);
    blocks.push(child);
    pos += child.nodeSize;
    if (child.attrs.id === toBlockId) return { blocks, end: pos };
  }
  return null;
}

/** Removes a block; a last child takes its (then empty) group with it. The
 *  last top-level block stays: a document always has one. */
export function removeBlock(tr: Transform, at: NonNullable<Located>): Refusal | void {
  const $pos = tr.doc.resolve(at.pos);
  if ($pos.parent.childCount > 1) {
    tr.delete(at.pos, at.pos + at.node.nodeSize);
    return;
  }
  if ($pos.depth <= 1) {
    return invalid('This is the document\'s only block.', 'Update it instead of deleting it.');
  }
  tr.delete($pos.before(), $pos.after());
}

/** Open threads whose commented text the edit shrinks, as a refusal. */
function droppedComments(before: PmNode, after: PmNode, open: Set<string>): Refusal | void {
  if (open.size === 0) return;
  const was = commentedText(before, open);
  const now = commentedText(after, open);
  const dropped = [...was].filter(([id, quote]) => (now.get(id)?.length ?? 0) < quote.length);
  if (dropped.length === 0) return;
  return {
    code: 'deletes_commented_text',
    message: `This edit removes text that ${dropped.length} open comment thread(s) are on.`,
    fix: 'Keep the commented text, or retry with allowCommentedDelete: true once removing it is intended (the threads are then shown as "Text removed").',
    details: { threads: dropped.map(([threadId, quote]) => ({ threadId, quote })) },
  };
}

function commentedText(doc: PmNode, open: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  doc.descendants((node) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      const id = mark.type.name === 'comment' ? (mark.attrs.threadId as string) : null;
      if (id && open.has(id)) out.set(id, (out.get(id) ?? '') + node.text!);
    }
    return true;
  });
  return out;
}

/** Open live threads of the document (resolved ones don't hold text). */
async function openThreadIds(documentId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT id FROM threads WHERE document_id = ${documentId} AND version_id IS NULL AND resolved_at IS NULL
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

function writtenMarkdown(p: Prepared): string | null {
  const inputs = p.op === 'update' ? [p.raw] : p.op === 'add' || p.op === 'replaceRange' ? p.input : [];
  if (inputs.length === 0 || !inputs.every((i) => typeof i === 'string')) return null;
  return (inputs as string[]).join('\n\n');
}

/** Spacing and list markers aside, did the stored text say what was written? */
function normalize(markdown: string): string {
  return markdown
    .replace(/^(\s*)[-+*](\s)/gm, '$1*$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function gone(target: Target): Refusal {
  return {
    code: 'target_changed',
    message: `Block ${target.blockId} no longer exists.`,
    fix: 'Read the document again and pick a block that exists.',
    details: { blockId: target.blockId, version: null },
  };
}

function invalid(message: string, fix: string): Refusal {
  return { code: 'invalid_op', message, fix };
}

function refusal(code: Refusal['code'], message: string, fix: string): Refusal {
  return { code, message, fix };
}

function missingVersion(name: string) {
  return { error: `\`${name}\` must be the block's 16-hex version from primer_get_doc.`, fix: 'Read the block and pass its version.' };
}

function reject(errors: OpError[], message: string): ApplyOpsResult {
  return {
    ok: false,
    status: 400,
    refusal: refusal('invalid_op', message, errors.length > 0 ? 'Fix the listed ops and send the batch again.' : 'Fix the request and retry.'),
    errors,
  };
}
