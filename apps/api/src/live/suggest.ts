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
import { fenceUntrusted } from '../lib/untrusted.ts';
import { blockIndex, blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';
import { liveDocName, liveInstance, withLiveDocument } from './instance.ts';
import { fragmentDoc } from './marks.ts';
import { removeBlock } from './ops.ts';
import { originFor, SYSTEM_ORIGIN } from './origin.ts';
import { applyPlan, contentVersion, type PlannedEdit } from './pipeline.ts';
import type { SuggestedEdit } from './proposals.ts';
import { docQueue } from './queue.ts';
import { fragmentName, reachableFragments, tabFragmentName } from './reach.ts';
import { groupVersion, pmDocOf, rewriteSources, trustedMeta, trustedSources } from './sources.ts';
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

/** Suggestions per list call; page on with `after` (the last id returned). */
const LIST_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (): SuggestionResult<never> => ({
  ok: false,
  status: 404,
  refusal: { code: 'not_found', message: 'Suggestion not found.', fix: 'List the document\'s suggestions with primer_list_suggestions.' },
});

/**
 * The open suggestions of a live document, oldest first (at most 200 per call;
 * pass the last id as `after` for the next page, `tabId` for one tab), each edit with the
 * block as it is now and as proposed (Markdown and BlockNote JSON) so a client
 * can diff them. What people and agents proposed is untrusted text: an agent
 * gets the Markdown fenced and no JSON.
 */
export async function listSuggestions(
  actor: AuthUser,
  documentId: string,
  opts: { tabId?: string; after?: string } = {},
): Promise<SuggestionResult<SuggestionDTO[]>> {
  const doc = await readableLiveDoc(documentId, actor);
  if (!doc) return { ok: false, status: 404, refusal: { code: 'not_found', message: 'Live document not found.', fix: 'Check the document id.' } };
  const rows = (await db.execute(sql`
    SELECT ${COLUMNS} FROM suggestions s JOIN users u ON u.id = s.author_id
     WHERE s.document_id = ${documentId} AND s.status = 'open'
       ${opts.tabId ? sql`AND s.tab_id = ${opts.tabId}` : sql``}
       ${opts.after && UUID.test(opts.after) ? sql`AND (s.created_at, s.id) > (SELECT created_at, id FROM suggestions WHERE id = ${opts.after})` : sql``}
     ORDER BY s.created_at, s.id LIMIT ${LIST_LIMIT}
  `)) as unknown as Row[];
  if (rows.length === 0) return { ok: true, value: [] };
  const pmDocs = await withDoc(documentId, (ydoc) => {
    const out = new Map<string, PmNode>();
    // A suggestion's edits share one fragment (a tab, or a page text or label).
    for (const row of rows) {
      const name = fragmentName({ ...row.edits[0]!.target, tabId: row.tabId });
      if (!out.has(name)) out.set(name, fragmentDoc(ydoc.getXmlFragment(name)));
    }
    return out;
  });
  const forAgent = actor.kind === 'agent';
  const value: SuggestionDTO[] = [];
  for (const row of rows) {
    const pm = pmDocs.get(fragmentName({ ...row.edits[0]!.target, tabId: row.tabId }))!;
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
    edits: [acceptEdit(row, (await goneRows(row.documentId, [row])).has(row.id))],
    guard: async () => {
      const [open] = (await db.execute(sql`
        SELECT 1 AS hit FROM suggestions WHERE id = ${row.id} AND document_id = ${row.documentId} AND status = 'open'
      `)) as unknown as { hit: number }[];
      return open ? null : closedRefusal().refusal;
    },
    // The republish's `sources` follow the accepted groups, so the next
    // republish still recognises them.
    alsoWrite: (doc, outcomes) => {
      if (outcomes[0]?.status !== 'applied' || !row.edits.some((e) => e.source)) return;
      const entries = trustedSources(doc, row.documentId);
      const final = blockIndex(pmDocOf(doc.getXmlFragment(tabFragmentName(row.tabId))));
      for (const { source } of row.edits) {
        if (source?.drop) entries.delete(source.drop);
        if (!source?.entry) continue;
        const version = groupVersion(final, source.entry.groupIds);
        if (version !== null) entries.set(source.entry.groupIds[0]!, { ...source.entry, version });
      }
      rewriteSources(doc, row.documentId, entries, trustedMeta(doc, row.documentId));
    },
    // Closed once the edit is stored, so a crash can't leave it accepted but lost.
    afterPersist: async ({ outcomes }) => {
      if (outcomes[0]?.status === 'applied' || outcomes[0]?.status === 'unchanged') accepted = await close(row, actor, 'accepted');
    },
  });
  if (!accepted) {
    const refusal = result.outcomes[0]?.refusal ?? closedRefusal().refusal;
    return { ok: false, status: 409, refusal };
  }
  return { ok: true, value: result };
}

/**
 * Decides a change set at once (a branch's proposal): every open suggestion
 * in it that is not a conflict. Conflicts are decided one by one. Same rules
 * as `decideSuggestion`: a person who owns or edits the suggestions'
 * document. Accepting replays them in order in one plan; one whose blocks
 * changed since stays open (its outcome says why) and the rest apply.
 */
export async function decideChangeSet(
  changeSetId: string,
  actor: AuthUser,
  decision: 'accept' | 'reject',
): Promise<SuggestionResult<Reconciliation>> {
  if (!UUID.test(changeSetId)) return notFound();
  const all = (await db.execute(sql`
    SELECT ${COLUMNS} FROM suggestions s JOIN users u ON u.id = s.author_id
     WHERE s.change_set_id = ${changeSetId} AND s.status = 'open' AND NOT s.conflict
     ORDER BY s.created_at, s.id
  `)) as unknown as Row[];
  if (all.length === 0) return notFound();
  const documentId = all[0]!.documentId;
  const rows = all.filter((r) => r.documentId === documentId);
  const doc = await readableLiveDoc(documentId, actor);
  if (!doc) return notFound();
  if (actor.kind !== 'person' || !canEdit(doc.role)) {
    return {
      ok: false,
      status: 403,
      refusal: { code: 'forbidden', message: 'Only a person who owns or edits the document can accept or reject suggestions.', fix: 'Ask the owner or an editor.' },
    };
  }
  if (decision === 'reject') {
    await docQueue(documentId)(async () => {
      for (const row of rows) await close(row, actor, 'rejected');
    });
    return { ok: true, value: { docVersion: await currentDocVersion(documentId), outcomes: [] } };
  }
  const gone = await goneRows(documentId, rows);
  const result = await applyPlan(documentId, originFor(actor), {
    onConflict: 'refuse',
    edits: rows.map((r) => acceptEdit(r, gone.has(r.id))),
    guard: async () => {
      const [open] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM suggestions
         WHERE id IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)}) AND status = 'open'
      `)) as unknown as { n: number }[];
      return open?.n === rows.length ? null : closedRefusal().refusal;
    },
    afterWrite: async (outcomes) => {
      for (const o of outcomes) {
        if (o.status === 'applied' || o.status === 'unchanged') await close(rows[o.index]!, actor, 'accepted');
      }
    },
  });
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
function acceptEdit(row: Row, gone: boolean): PlannedEdit {
  const schema = serverEditor().editor.pmSchema;
  const first = row.edits[0]!;
  return {
    target: { ...first.target, tabId: row.tabId },
    inverse: false,
    build: (tr) => {
      if (gone) {
        return {
          code: 'target_missing',
          message: 'The page text or label this suggestion changes is no longer in the document; nothing was applied.',
          fix: 'Reject it: its text was removed after it was made.',
        };
      }
      const stale: { blockId: string; reason: string }[] = [];
      // Inserts first and deletes last, so a whole-tab replacement never
      // empties the tab on the way (removing the last block is refused).
      const order = { insert: 0, replace: 1, move: 1, delete: 2 } as const;
      for (const edit of [...row.edits].sort((a, b) => order[a.kind] - order[b.kind])) {
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

/** The suggestions of `rows` whose page text, embed or widget label fragment the document no longer reaches. */
async function goneRows(documentId: string, rows: Row[]): Promise<Set<string>> {
  const reachable = new Set(await withLiveDocument(documentId, (doc) => reachableFragments(doc)));
  const sub = (e: SuggestedEdit) => e.target.pid !== undefined || e.target.textId !== undefined || e.target.embedId !== undefined;
  return new Set(rows.filter((r) => r.edits.some((e) => sub(e) && !reachable.has(fragmentName({ ...e.target, tabId: r.tabId })))).map((r) => r.id));
}

/** Why an edit no longer applies to `doc`, or null when it does. */
function staleness(doc: PmNode, edit: SuggestedEdit): string | null {
  const at = findBlock(doc, edit.target.blockId);
  if (edit.kind === 'insert') return at ? 'already exists' : null;
  if (!at) return 'gone';
  const now = edit.kind === 'delete' ? blockVersion(at.node) : contentVersion(at.node);
  if (now !== edit.base) return 'changed';
  // Replacing the content would drop a comment added since the suggestion.
  if (edit.kind === 'replace' && edit.proposed) {
    const kept = commentThreads(PmNode.fromJSON(doc.type.schema, edit.proposed).firstChild!);
    if ([...commentThreads(at.node.firstChild!)].some((id) => !kept.has(id))) return 'commented';
  }
  return null;
}

/** The threads whose comment mark is on a node's inline content. */
function commentThreads(content: PmNode): Set<string> {
  const ids = new Set<string>();
  content.descendants((node) => {
    for (const mark of node.marks) if (mark.type.name === 'comment') ids.add(mark.attrs.threadId as string);
  });
  return ids;
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
  if (forAgent) return { markdown: fenceUntrusted(markdown, 'content') };
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
