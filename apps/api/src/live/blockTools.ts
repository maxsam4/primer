// Shared by the choice and task features: access to a live document, walking
// its blocks across tabs, and inserting one new block through the pipeline.
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { Node as PmNode } from '@tiptap/pm/model';
import { eq } from 'drizzle-orm';
import { blockToNode, type PartialBlock } from '@blocknote/core';
import { LIVE_BLOCK_ID_RE, type BlockPlacement, type Refusal, type RefusalCode, type Target } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { canEdit, canRead, loadEffectiveRole, type EffectiveRole, type Visibility } from '../lib/permissions.ts';
import { readBlocks, serverEditor, type PrimerBlock } from './editor.ts';
import { originFor } from './origin.ts';
import type { EditOutcome } from '@polygonlabs/primer-api-types';
import { applyPlan, dryRun, type PlannedEdit, type Plan } from './pipeline.ts';
import { tabsOf } from './reach.ts';
import { activeRequestedRunIds, finishDirectRun, runHooks, startDirectRun } from './runs.ts';

export type Result<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB_ID = /^[\w-]{1,64}$/;

const FIX: Partial<Record<RefusalCode, string>> = {
  bad_request: 'Fix the arguments and call again.',
  not_found: 'Check the document and block ids, and that you can read the document.',
  forbidden: 'Ask the document owner for editor access.',
  choice_decided: 'The choice is closed; read the decision with primer_list_decisions.',
};

export function refuse(code: RefusalCode, message: string, fix?: string): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: { code, message, fix: fix ?? FIX[code] ?? 'Call again with valid arguments.' } };
}

export type LiveDocAccess = { role: EffectiveRole; uploaderId: string };

/** The caller's role on a live document it can read; edit rights when `write`. */
export async function liveDocAccess(documentId: string, actor: AuthUser, write = false): Promise<Result<LiveDocAccess>> {
  if (!UUID.test(documentId)) return refuse('not_found', 'Document not found.');
  const [doc] = await db
    .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt, format: documents.format })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc || doc.deletedAt !== null) return refuse('not_found', 'Document not found.');
  const role = await loadEffectiveRole({ id: documentId, uploaderId: doc.uploaderId, visibility: doc.visibility as Visibility }, actor);
  if (!canRead(doc.visibility as Visibility, role)) return refuse('not_found', 'Document not found.');
  if (!doc.format) {
    return refuse('bad_request', 'This document is version-only HTML, not a live document.', 'Use a live (Markdown or text) document.');
  }
  if (write && !canEdit(role)) return refuse('forbidden', 'Only the document owner and editors can change its blocks.');
  return { ok: true, value: { role, uploaderId: doc.uploaderId } };
}

/** Every block of every tab, depth first, with its tab. */
export function* liveBlocks(doc: Y.Doc): Generator<{ tabId: string; block: PrimerBlock }> {
  for (const tab of tabsOf(doc)) {
    const stack = [...readBlocks(doc, tab.id)].reverse();
    while (stack.length > 0) {
      const block = stack.pop()!;
      yield { tabId: tab.id, block };
      for (let i = block.children.length - 1; i >= 0; i--) stack.push(block.children[i] as PrimerBlock);
    }
  }
}

/** The block with this id (of this type), or null. */
export function findLiveBlock(doc: Y.Doc, blockId: string, type: string): { tabId: string; block: PrimerBlock } | null {
  for (const entry of liveBlocks(doc)) if (entry.block.id === blockId && entry.block.type === type) return entry;
  return null;
}

export function validBlockId(raw: unknown): raw is string {
  return typeof raw === 'string' && LIVE_BLOCK_ID_RE.test(raw);
}

/** A placement, validated: `afterBlockId` or the end of `tabId` (main by default). */
export function checkPlacement(raw: BlockPlacement): string | null {
  if (raw.tabId !== undefined && (typeof raw.tabId !== 'string' || !TAB_ID.test(raw.tabId))) return 'tabId is not a tab id';
  if (raw.afterBlockId !== undefined && !validBlockId(raw.afterBlockId)) return 'afterBlockId is not a block id';
  return null;
}

/** A fresh block id. */
export function newBlockId(): string {
  return randomUUID();
}

type RunHooks = Exclude<Awaited<ReturnType<typeof runHooks>>, Refusal>;

/**
 * Runs a write under a run, as applyOps does for an agent: refused while the
 * agent has an active run it must use, otherwise inside a direct run of its
 * own, so the write has a budget, a cancel and an undo. People write as they are.
 */
async function scoped<T>(documentId: string, actor: AuthUser, write: (hooks: RunHooks | null) => Promise<Result<T>>): Promise<Result<T>> {
  if (actor.kind !== 'agent') return write(null);
  const active = await activeRequestedRunIds(documentId, actor.id);
  if (active.length > 0) {
    return {
      ok: false,
      refusal: {
        code: 'run_required',
        message: `You have an active run on this document (${active.join(', ')}); its edits must go through it.`,
        fix: 'Make this change with primer_apply_ops and runId, or finish the run first.',
        details: { runIds: active },
      },
    };
  }
  const runId = await startDirectRun(documentId, actor);
  let error: string | null = null;
  try {
    const hooks = await runHooks(documentId, actor, runId);
    if ('code' in hooks) return { ok: false, refusal: hooks };
    return await write(hooks);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    await finishDirectRun(runId, error);
  }
}

/** One edit as a plan: guarded by the run's budget, with its inverses, and
 *  refused on a tab the document no longer has. */
function planOf(edit: PlannedEdit, tabId: string, hooks: RunHooks | null, extra: Partial<Plan> = {}): Plan {
  return {
    onConflict: 'refuse',
    mode: hooks?.suggestOnly ? 'suggest' : undefined,
    edits: [{ ...edit, inverse: hooks !== null }],
    guard: async (doc, { suggesting }) => {
      if (!tabsOf(doc).some((t) => t.id === tabId)) return refuse('not_found', `Tab ${tabId} not found.`, 'Read the document to list its tabs.').refusal;
      if (!hooks) return null;
      return hooks.guard(suggesting ? { edits: 0, removals: 0, unresolved: false } : dryRun(doc, [{ ...edit, inverse: false }]));
    },
    beforeWrite: hooks?.beforeWrite,
    ...extra,
  };
}

/** Why an outcome stored nothing (a conflict, or only a suggestion), or null when it applied. */
function notStored(outcome: EditOutcome | undefined): Refusal | null {
  if (outcome?.status === 'applied') return null;
  if (outcome?.refusal) return outcome.refusal;
  return {
    code: 'forbidden',
    message:
      outcome?.status === 'suggested'
        ? 'Your changes to this document are suggestions only, so nothing was added.'
        : 'Nothing was stored.',
    fix: 'Ask the owner to let your agent edit directly, or make the change as a suggestion in the editor.',
  };
}

/**
 * Inserts `block` (built entirely by the server, never taken from the caller)
 * after `afterBlockId`, or at the end of the tab, through the pipeline.
 */
export async function insertBlock(
  actor: AuthUser,
  documentId: string,
  placement: BlockPlacement,
  block: PartialBlock,
): Promise<Result<{ target: Target; docVersion: number }>> {
  const tabId = placement.tabId ?? 'main';
  const node = blockToNode(block as never, serverEditor().editor.pmSchema);
  return scoped(documentId, actor, async (hooks) => {
    let refusal: Refusal | null = null;
    const result = await applyPlan(
      documentId,
      originFor(actor),
      planOf(
        {
          target: { tabId, blockId: placement.afterBlockId ?? '' },
          inverse: false,
          build: (tr) => {
            if (placement.afterBlockId) {
              const anchor = anchorBlock(tr.doc, placement.afterBlockId);
              if (!anchor) {
                refusal = refuse('not_found', `Block ${placement.afterBlockId} is not a block in tab ${tabId}.`).refusal;
                return;
              }
              tr.insert(anchor.pos + anchor.node.nodeSize, node);
              return;
            }
            const group = tr.doc.firstChild!;
            tr.insert(1 + group.content.size, node);
          },
        },
        tabId,
        hooks,
      ),
    );
    const failed = refusal ?? notStored(result.outcomes[0]);
    if (failed) return { ok: false, refusal: failed };
    return { ok: true, value: { target: { tabId, blockId: block.id! }, docVersion: result.docVersion } };
  });
}

/** A block a new one may follow: an ordinary block, or a layout block (a
 *  choice) that sits in a block group. */
function anchorBlock(doc: PmNode, blockId: string): { pos: number; node: PmNode } | null {
  let found: { pos: number; node: PmNode } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs.id === blockId && (node.type.name === 'blockContainer' || node.type.name === 'choice')) {
      if (doc.resolve(pos).parent.type.name === 'blockGroup') found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Sets props on one block through the pipeline, once `check` accepts the
 * block as it is inside the document's queue. Layout blocks (a choice) are
 * the node itself; other blocks keep their props on the content node.
 * `afterWrite` runs on the queue right after the write, so what it records
 * can't interleave with another write to the same block.
 */
export async function setBlockProps(
  actor: AuthUser,
  documentId: string,
  target: Target,
  check: (block: { type: string; attrs: Record<string, unknown>; childIds: string[] }) => Refusal | null,
  props: Record<string, string>,
  afterWrite?: () => Promise<void>,
): Promise<Result<{ docVersion: number }>> {
  return scoped(documentId, actor, async (hooks) => {
    let refusal: Refusal | null = null;
    const result = await applyPlan(
      documentId,
      originFor(actor),
      planOf(
        {
          target,
          inverse: false,
          build: (tr, at) => {
            if (!at) {
              refusal = refuse('not_found', `Block ${target.blockId} no longer exists.`).refusal;
              return;
            }
            const layout = at.node.type.name !== 'blockContainer';
            const pos = layout ? at.pos : at.pos + 1;
            const node = layout ? at.node : at.node.firstChild!;
            const childIds: string[] = [];
            if (layout) at.node.forEach((child) => childIds.push(String(child.attrs.id)));
            refusal = check({ type: node.type.name, attrs: node.attrs, childIds });
            if (refusal) return;
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...props });
          },
        },
        target.tabId,
        hooks,
        {
          afterWrite: afterWrite
            ? async (outcomes) => {
                if (!refusal && outcomes[0]?.status === 'applied') await afterWrite();
              }
            : undefined,
        },
      ),
    );
    const failed = refusal ?? notStored(result.outcomes[0]);
    if (failed) return { ok: false, refusal: failed };
    return { ok: true, value: { docVersion: result.docVersion } };
  });
}
