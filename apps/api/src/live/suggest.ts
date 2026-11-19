import { Node as PmNode } from '@tiptap/pm/model';
import type { Transform } from '@tiptap/pm/transform';
import { sql } from 'drizzle-orm';
import type {
  Reconciliation,
  Refusal,
  SuggestedEditDTO,
  SuggestionBlockDTO,
  SuggestionDTO,
  SuggestionStatus,
} from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { actorNameOf } from '../lib/actors.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { readableLiveDoc } from '../lib/liveThreads.ts';
import { canEdit } from '../lib/permissions.ts';
import { blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { fragmentDoc } from './marks.ts';
import { removeBlock } from './ops.ts';
import { originFor, SYSTEM_ORIGIN } from './origin.ts';
import { applyPlan, contentVersion, type PlannedEdit } from './pipeline.ts';
import type { SuggestedEdit } from './proposals.ts';
import { docQueue } from './queue.ts';
import { tabFragmentName } from './reach.ts';
import { fenceUntrusted } from './runs.ts';
import { insertAt } from './undo.ts';

export type { SuggestedEdit, Proposal } from './proposals.ts';

export type SuggestionResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409; refusal: Refusal };

export type Decision = 'accept' | 'reject' | 'withdraw';

type Row = {
  id: string;
  documentId: string;
  authorId: string;
  authorDisplayName: string;
  runId: string | null;
  changeSetId: string | null;
  status: SuggestionStatus;
  tabId: string;
  edits: SuggestedEdit[];
  conflict: boolean;
  createdAt: Date | string;
};

const COLUMNS = sql`
  s.id, s.document_id AS "documentId", s.author_id AS "authorId", ${actorNameOf('u')} AS "authorDisplayName",
  s.run_id AS "runId", s.change_set_id AS "changeSetId", s.status, s.tab_id AS "tabId", s.edits, s.conflict,
  s.created_at AS "createdAt"`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (): SuggestionResult<never> => ({
  ok: false,
  status: 404,
  refusal: { code: 'not_found', message: 'Suggestion not found.', fix: 'List the document\'s suggestions with primer_list_suggestions.' },
});

/**
 * The open suggestions of a live document, oldest first, each edit with the
 * block as it is now and as proposed (Markdown and BlockNote JSON) so a client
 * can diff them. What people and agents proposed is untrusted text: an agent
 * gets the Markdown fenced and no JSON.
 */
export async function listSuggestions(actor: AuthUser, documentId: string): Promise<SuggestionResult<SuggestionDTO[]>> {
  const doc = await readableLiveDoc(documentId, actor);
  if (!doc) return { ok: false, status: 404, refusal: { code: 'not_found', message: 'Live document not found.', fix: 'Check the document id.' } };
  const rows = (await db.execute(sql`
    SELECT ${COLUMNS} FROM suggestions s JOIN users u ON u.id = s.author_id
     WHERE s.document_id = ${documentId} AND s.status = 'open'
     ORDER BY s.created_at, s.id LIMIT 200
  `)) as unknown as Row[];
  if (rows.length === 0) return { ok: true, value: [] };
  const pmDocs = await withDoc(documentId, (ydoc) => {
    const out = new Map<string, PmNode>();
    for (const row of rows) {
      if (!out.has(row.tabId)) out.set(row.tabId, fragmentDoc(ydoc.getXmlFragment(tabFragmentName(row.tabId))));
    }
    return out;
  });
  const forAgent = actor.kind === 'agent';
  const value: SuggestionDTO[] = [];
  for (const row of rows) {
    const pm = pmDocs.get(row.tabId)!;
    const edits: SuggestedEditDTO[] = [];
    for (const edit of row.edits) {
      const now = findBlock(pm, edit.target.blockId)?.node ?? null;
      const whole = edit.kind === 'insert' || edit.kind === 'delete';
      edits.push({
        kind: edit.kind,
        target: edit.target,
        current: now ? await blockDTO(now, whole, forAgent) : null,
        proposed: edit.proposed ? await blockDTO(PmNode.fromJSON(pm.type.schema, edit.proposed), whole, forAgent) : null,
        place: edit.place,
      });
    }
    value.push({
      id: row.id,
      documentId: row.documentId,
      authorId: row.authorId,
      authorDisplayName: row.authorDisplayName,
      runId: row.runId,
      changeSetId: row.changeSetId,
      status: row.status,
      conflict: row.conflict,
      stale: row.edits.some((edit) => staleness(pm, edit) !== null),
      createdAt: new Date(row.createdAt).toISOString(),
      edits,
    });
  }
  return { ok: true, value };
}

/**
 * Decides one suggestion. The suggestion's own document is the one acted on,
 * and the caller must be able to read it (else not found).
 * - `accept` and `reject`: people who own or edit the document. Accepting
 *   replays the edits through the pipeline with their base versions: if any
 *   block changed since, nothing applies, it is refused `target_changed` and
 *   the suggestion stays open.
 * - `withdraw`: only the suggestion's author (an agent withdraws its own).
 * Agents never accept or reject. Emits `suggestion.decided`.
 */
export async function decideSuggestion(id: string, actor: AuthUser, decision: Decision): Promise<SuggestionResult<Reconciliation>> {
  if (!UUID.test(id)) return notFound();
  const [row] = (await db.execute(sql`
    SELECT ${COLUMNS} FROM suggestions s JOIN users u ON u.id = s.author_id WHERE s.id = ${id}
  `)) as unknown as Row[];
  if (!row) return notFound();
  const doc = await readableLiveDoc(row.documentId, actor);
  if (!doc) return notFound();

  if (decision === 'withdraw') {
    if (row.authorId !== actor.id) {
      return { ok: false, status: 403, refusal: { code: 'forbidden', message: 'Only its author can withdraw a suggestion.', fix: 'Withdraw your own suggestions only.' } };
    }
  } else if (actor.kind !== 'person' || !canEdit(doc.role)) {
    return {
      ok: false,
      status: 403,
      refusal: {
        code: 'forbidden',
        message: 'Only a person who owns or edits the document can accept or reject a suggestion.',
        fix: actor.kind === 'agent' ? 'Ask a person to decide it; you may withdraw your own suggestions.' : 'Ask the owner or an editor.',
      },
    };
  }

  if (decision !== 'accept') {
    const status = decision === 'reject' ? 'rejected' : 'withdrawn';
    // On the document's queue, so it never interleaves with an accept.
    const closed = await docQueue(row.documentId)(() => close(row, actor, status));
    if (!closed) return closedRefusal();
    return { ok: true, value: { docVersion: await currentDocVersion(row.documentId), outcomes: [] } };
  }

  let accepted = false;
  const result = await applyPlan(row.documentId, originFor(actor), {
    onConflict: 'refuse',
    edits: [acceptEdit(row)],
    guard: async () => {
      const [open] = (await db.execute(sql`
        SELECT 1 AS hit FROM suggestions WHERE id = ${row.id} AND document_id = ${row.documentId} AND status = 'open'
      `)) as unknown as { hit: number }[];
      return open ? null : closedRefusal().refusal;
    },
    afterWrite: async (outcomes) => {
      if (outcomes[0]?.status === 'applied' || outcomes[0]?.status === 'unchanged') accepted = await close(row, actor, 'accepted');
    },
  });
  if (!accepted) {
    const refusal = result.outcomes[0]?.refusal ?? closedRefusal().refusal;
    return { ok: false, status: 409, refusal };
  }
  return { ok: true, value: result };
}

/** Closes an open suggestion with `status`; false when it was not open. */
async function close(row: Row, actor: AuthUser, status: 'accepted' | 'rejected' | 'withdrawn'): Promise<boolean> {
  return transactionWithEvents(async (tx, emit) => {
    const updated = (await tx.execute(sql`
      UPDATE suggestions SET status = ${status}, decided_by = ${actor.id}, decided_at = now()
       WHERE id = ${row.id} AND document_id = ${row.documentId} AND status = 'open'
      RETURNING id
    `)) as unknown as { id: string }[];
    if (updated.length === 0) return false;
    emit({
      documentId: row.documentId,
      actorId: actor.id,
      type: 'suggestion.decided',
      payload: { document_id: row.documentId, suggestion_id: row.id, decision: status, by: actor.id },
    });
    return true;
  });
}

function closedRefusal(): { ok: false; status: 409; refusal: Refusal } {
  return {
    ok: false,
    status: 409,
    refusal: { code: 'suggestion_closed', message: 'The suggestion was already decided or withdrawn.', fix: 'List the open suggestions again.' },
  };
}

/** The whole suggestion as one planned edit, so it applies entirely or not
 *  at all: every edit's base is checked against the document as it is. */
function acceptEdit(row: Row): PlannedEdit {
  const schema = serverEditor().editor.pmSchema;
  const first = row.edits[0]!;
  return {
    target: { tabId: row.tabId, blockId: first.target.blockId },
    inverse: false,
    build: (tr) => {
      const stale: { blockId: string; reason: string }[] = [];
      for (const edit of row.edits) {
        const reason = staleness(tr.doc, edit);
        if (reason) {
          stale.push({ blockId: edit.target.blockId, reason });
          continue;
        }
        const refused = replay(tr, edit, schema);
        if (refused) return refused;
      }
      if (stale.length > 0) {
        return {
          code: 'target_changed',
          message: `${stale.length} block(s) of this suggestion changed since it was made; nothing was applied.`,
          fix: 'Reject it, or ask its author to suggest it again against the current text.',
          details: { blocks: stale },
        };
      }
    },
  };
}

/** Why an edit no longer applies to `doc`, or null when it does. */
function staleness(doc: PmNode, edit: SuggestedEdit): string | null {
  const at = findBlock(doc, edit.target.blockId);
  if (edit.kind === 'insert') return at ? 'already exists' : null;
  if (!at) return 'gone';
  const now = edit.kind === 'delete' ? blockVersion(at.node) : contentVersion(at.node);
  return now === edit.base ? null : 'changed';
}

function replay(tr: Transform, edit: SuggestedEdit, schema: PmNode['type']['schema']): Refusal | void {
  const proposed = edit.proposed ? PmNode.fromJSON(schema, edit.proposed) : null;
  if (edit.kind === 'insert') return insertAt(tr, proposed!, edit.place!);
  const at = findBlock(tr.doc, edit.target.blockId)!;
  if (edit.kind === 'delete') return removeBlock(tr, at);
  if (edit.kind === 'replace' && contentVersion(proposed!) !== contentVersion(at.node)) {
    tr.replaceWith(at.pos + 1, at.pos + 1 + at.node.firstChild!.nodeSize, proposed!.firstChild!);
  }
  if (edit.place) {
    const now = findBlock(tr.doc, edit.target.blockId)!;
    const removed = removeBlock(tr, now);
    if (removed) return removed;
    return insertAt(tr, now.node, edit.place);
  }
}

/** One block as a suggestion shows it: its own content, or its whole
 *  subtree (`whole`, for inserts and deletes). */
async function blockDTO(container: PmNode, whole: boolean, forAgent: boolean): Promise<SuggestionBlockDTO> {
  const editor = serverEditor();
  const schema = editor.editor.pmSchema;
  const doc = schema.topNodeType.create(null, schema.nodes.blockGroup!.create(null, container));
  const [block] = editor._prosemirrorJSONToBlocks(doc.toJSON());
  const shown = whole ? block! : ({ ...block!, children: [] } as typeof block);
  const markdown = (await editor.blocksToMarkdownLossy([shown] as never)).trimEnd();
  if (forAgent) return { markdown: fenceUntrusted(markdown, 'untrusted-content') };
  return { markdown, json: shown as unknown as Record<string, unknown> };
}

async function withDoc<T>(documentId: string, fn: (doc: import('yjs').Doc) => T): Promise<T> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), SYSTEM_ORIGIN);
  try {
    return fn(connection.document!);
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}

async function currentDocVersion(documentId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    SELECT COALESCE(MAX(id), 0)::int AS v FROM doc_updates WHERE document_id = ${documentId}
  `)) as unknown as { v: number }[];
  return row?.v ?? 0;
}
