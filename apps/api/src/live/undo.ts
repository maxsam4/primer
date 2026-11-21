import { Node as PmNode } from '@tiptap/pm/model';
import type { Transform } from '@tiptap/pm/transform';
import { sql } from 'drizzle-orm';
import type { Reconciliation, Refusal, Target } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { readableLiveDoc } from '../lib/liveThreads.ts';
import { canEdit } from '../lib/permissions.ts';
import { blockVersion, findBlock, hasAnnotations } from './blocks.ts';
import { serverEditor } from './editor.ts';
import { insertFirstChild, removeBlock } from './ops.ts';
import { originFor } from './origin.ts';
import { applyPlan, contentVersion, indexBlocks, type BlockPlace, type PlannedEdit } from './pipeline.ts';
import { loadRun, type RunResult } from './runs.ts';

type InverseRow = {
  target: Target;
  prior: Record<string, unknown> | null;
  afterVersion: string | null;
  /** Where the block was; for a moved block also `after`, where the run left it. */
  place: (BlockPlace & { after?: BlockPlace }) | null;
};

/**
 * Undoes one agent run from its stored inverses (run_inverses), newest first,
 * in one pass through the pipeline. Each block is put back only if it is
 * still as the run left it (its content version equals `after_version`), so a
 * person's later edit is never overwritten: such a block becomes a restore
 * suggestion (`onConflict: 'suggest'`) for a person to decide. Blocks the run created are removed, removed ones re-inserted at
 * their place, changed ones restored, moved ones moved back. Durable: works
 * after a restart, with no expiry. Allowed for owners and editors (role read
 * now), once the run has stopped.
 */
export async function undoRun(runId: string, actor: AuthUser): Promise<RunResult<Reconciliation>> {
  const run = await loadRun(runId);
  const doc = run ? await readableLiveDoc(run.documentId, actor) : null;
  if (!run || !doc) {
    return { ok: false, status: 404, refusal: { code: 'not_found', message: 'Run not found.', fix: 'Check the run id.' } };
  }
  // Undo writes the document: whoever asks must be able to edit it now.
  if (!canEdit(doc.role)) {
    return {
      ok: false,
      status: 403,
      refusal: { code: 'forbidden', message: 'Only the owner and editors can undo a run.', fix: 'Ask the owner or an editor.' },
    };
  }
  if (run.status === 'queued' || run.status === 'running') {
    return {
      ok: false,
      status: 409,
      refusal: { code: 'bad_request', message: 'The run is still active.', fix: 'Cancel the run first, then undo it.' },
    };
  }
  // Scoped to the run's document: rows are never applied elsewhere.
  const rows = (await db.execute(sql`
    SELECT target, prior, after_version AS "afterVersion", place
      FROM run_inverses WHERE run_id = ${runId} AND document_id = ${run.documentId}
     ORDER BY id DESC
  `)) as unknown as InverseRow[];

  // Put removed blocks back before removing created ones, so removing the
  // last block (a whole-tab replacement) never trips the last-block guard.
  const restores = (row: InverseRow) => row.prior !== null && row.afterVersion === null;
  const edits = [...rows.filter(restores), ...rows.filter((row) => !restores(row))].map(toEdit);
  const value = await applyPlan(run.documentId, originFor(actor), { edits, onConflict: 'suggest' });
  return { ok: true, value };
}

function toEdit(row: InverseRow): PlannedEdit {
  const schema = serverEditor().editor.pmSchema;
  const prior = row.prior ? PmNode.fromJSON(schema, row.prior) : null;
  return {
    target: row.target,
    inverse: false,
    build: (tr, at, ctx) => {
      // Suggesting: what restoring would do to the block as it is now.
      const stale = (changed: boolean) => changed && !ctx.suggesting;
      if (prior === null) {
        // The run created this block: remove it, unless someone changed it.
        if (!at) return;
        if (stale(blockVersion(at.node) !== row.afterVersion)) return changedSince(row.target);
        return removeBlock(tr, at);
      }
      if (row.afterVersion === null) {
        // The run removed this block: put it back where it was.
        if (at) return;
        return insertAt(tr, prior, row.place!);
      }
      if (!at || stale(contentVersion(at.node) !== row.afterVersion)) return changedSince(row.target);
      if (row.place?.after && stale(!stillAt(tr.doc, row.target.blockId, row.place.after))) return changedSince(row.target);
      if (contentVersion(prior) !== contentVersion(at.node)) {
        // Restoring replaces the content whole, which would drop a comment or
        // suggestion added since: leave such a block as it is (a suggestion
        // is checked again when accepted).
        if (stale(hasAnnotations(at.node.firstChild!))) return changedSince(row.target);
        tr.replaceWith(at.pos + 1, at.pos + 1 + at.node.firstChild!.nodeSize, prior.firstChild!);
      }
      if (row.place) {
        const now = findBlock(tr.doc, row.target.blockId)!;
        const node = now.node;
        const removed = removeBlock(tr, now);
        if (removed) return removed;
        return insertAt(tr, node, row.place);
      }
    },
  };
}

/** Whether the block is still where the run left it: in the same parent,
 *  next to the same previous or next sibling. */
function stillAt(doc: PmNode, blockId: string, after: BlockPlace): boolean {
  const now = indexBlocks(doc).get(blockId)?.place;
  if (!now || now.parentId !== after.parentId) return false;
  return now.prevId === after.prevId || now.nextId === after.nextId;
}

/** Inserts `node` at its recorded place: after its previous sibling, before
 *  its next one, first in its parent, or first in the document. */
export function insertAt(tr: Transform, node: PmNode, place: BlockPlace): Refusal | void {
  const prev = place.prevId ? findBlock(tr.doc, place.prevId) : null;
  if (prev) {
    tr.insert(prev.pos + prev.node.nodeSize, node);
    return;
  }
  const next = place.nextId ? findBlock(tr.doc, place.nextId) : null;
  if (next) {
    tr.insert(next.pos, node);
    return;
  }
  const parent = place.parentId ? findBlock(tr.doc, place.parentId) : null;
  if (parent) {
    insertFirstChild(tr, parent, node);
    return;
  }
  tr.insert(1, node);
}

function changedSince(target: Target): Refusal {
  return {
    code: 'target_changed',
    message: `Block ${target.blockId} changed after the run; it was left as it is.`,
    fix: 'Restore it by hand if you still want the run\'s version gone.',
    details: { blockId: target.blockId },
  };
}
