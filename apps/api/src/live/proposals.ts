import { sql } from 'drizzle-orm';
import type { BlockPlace, SuggestedEditKind, Target } from '@polygonlabs/primer-api-types';
import { transactionWithEvents } from '../lib/events.ts';
import type { LiveOrigin } from './origin.ts';

/**
 * One block a suggestion changes, as stored in `suggestions.edits`:
 * - `proposed`: the blockContainer JSON as proposed (an `insert`'s whole
 *   subtree; a `replace`'s block, whose own content is what accepting writes),
 *   null for `delete` and `move`; the same format as `run_inverses.prior`, so
 *   marks and props the author never saw survive;
 * - `base`: the version accepting expects the block to still have (the whole
 *   subtree's for `delete`, the block's own content's for `replace` and
 *   `move`), null for `insert`;
 * - `place`: where an `insert` or a moved block goes.
 */
export type SuggestedEdit = {
  kind: SuggestedEditKind;
  target: Target;
  base: string | null;
  proposed: Record<string, unknown> | null;
  place: BlockPlace | null;
};

/** A suggestion the pipeline made from one planned edit. */
export type Proposal = { id: string; tabId: string; edits: SuggestedEdit[]; conflict: boolean };

/**
 * Stores the suggestions one plan made, with a `suggestion.created` event
 * each, in one transaction. Called by the pipeline on the document's queue.
 */
export async function storeProposals(
  documentId: string,
  origin: LiveOrigin,
  changeSetId: string | null,
  proposals: Proposal[],
): Promise<void> {
  // The system never authors a suggestion (no user row); the pipeline only
  // suggests for people and agents.
  if (origin.kind === 'system') throw new Error('the system cannot author a suggestion');
  await transactionWithEvents(async (tx, emit) => {
    for (const p of proposals) {
      await tx.execute(sql`
        INSERT INTO suggestions (id, document_id, author_id, run_id, change_set_id, tab_id, target_ids, edits, conflict)
        VALUES (${p.id}, ${documentId}, ${origin.actorId}, ${origin.runId}, ${changeSetId}, ${p.tabId},
                ${sql`ARRAY[${sql.join(p.edits.map((e) => sql`${e.target.blockId}`), sql`, `)}]::text[]`},
                ${JSON.stringify(p.edits)}::jsonb, ${p.conflict})
      `);
      emit({
        documentId,
        actorId: origin.actorId,
        type: 'suggestion.created',
        payload: { document_id: documentId, suggestion_id: p.id, author_id: origin.actorId },
      });
    }
  });
}
