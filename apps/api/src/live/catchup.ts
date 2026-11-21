import { sql } from 'drizzle-orm';
import type {
  CatchUpDTO,
  CatchUpDecision,
  CatchUpPerson,
  CatchUpSince,
  CatchUpSuggestion,
  CatchUpTask,
  CatchUpThread,
  CatchUpVersion,
  DigestResponse,
  LiveBlockDTO,
  Refusal,
  TaskStatus,
} from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { actorNameOf } from '../lib/actors.ts';
import { canRead, libraryOwnerId, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { fenceUntrusted } from '../lib/untrusted.ts';
import { withLiveDocument } from './instance.ts';
import { getLiveDoc } from './read.ts';
import { blockOfFragment, tabsOf } from './reach.ts';

/** Changed blocks a catch-up lists in full. */
const MAX_BLOCKS = 50;
/** Lifecycle events a catch-up reads (newest dropped beyond this). */
const MAX_EVENTS = 500;
/** Documents a digest covers. */
const MAX_DIGEST_DOCS = 50;
const EXCERPT = 280;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CatchUpResult = { ok: true; value: CatchUpDTO } | { ok: false; status: 400 | 404; refusal: Refusal };

const notFound: CatchUpResult = {
  ok: false,
  status: 404,
  refusal: { code: 'not_found', message: 'Document not found.', fix: 'Check the id; list documents with primer_list_documents.' },
};

type EventRow = { id: number; type: string; authorId: string; payload: Record<string, unknown>; at: Date };

/**
 * "Since you last looked" (M10b.1): what others did to one document after
 * `since`, read from what Primer already keeps. Edits come from the update
 * log (`doc_updates`: who saved, which blocks), shown as the blocks read
 * now; everything else from Primer's own lifecycle events (`primer.*`,
 * audience readers) joined to their rows. The caller's own actions, and those
 * of the person an agent caller acts for, are left out. Agent callers get
 * every text people wrote fenced.
 */
export async function getCatchUp(actor: AuthUser, documentId: string, since: CatchUpSince): Promise<CatchUpResult> {
  if (!UUID_RE.test(documentId)) return notFound;
  const sinceAt = new Date(since.at);
  if (Number.isNaN(sinceAt.getTime())) {
    return { ok: false, status: 400, refusal: { code: 'bad_request', message: 'since is not a time.', fix: 'Pass an ISO 8601 time.' } };
  }
  const [doc] = (await db.execute(sql`
    SELECT id, title, uploader_id AS "uploaderId", visibility, format, deleted_at AS "deletedAt"
      FROM documents WHERE id = ${documentId}
  `)) as unknown as { id: string; title: string; uploaderId: string; visibility: Visibility; format: string | null; deletedAt: Date | null }[];
  if (!doc || doc.deletedAt !== null) return notFound;
  const role = await loadEffectiveRole({ id: doc.id, uploaderId: doc.uploaderId, visibility: doc.visibility }, actor);
  if (!canRead(doc.visibility, role)) return notFound;

  const forAgent = actor.kind === 'agent';
  const text = (s: string) => (forAgent ? fenceUntrusted(s, 'content') : s);
  const excluded = [...new Set([actor.id, libraryOwnerId(actor)])];
  const isOwn = (id: string | null) => id !== null && excluded.includes(id);
  const people = new Map<string, CatchUpPerson>();
  const person = (id: string) => {
    let p = people.get(id);
    if (!p) {
      p = { id, displayName: id, kind: 'person', edits: 0, comments: 0, resolved: 0, decisions: 0, suggestions: 0, tasks: 0 };
      people.set(id, p);
    }
    return p;
  };

  // ── Edits (live documents) ──
  const live = doc.format !== null;
  let sinceVersion: number | null = since.docVersion;
  let untilVersion: number | null = null;
  const changedBlocks: LiveBlockDTO[] = [];
  let moreChangedBlocks = 0;
  const deletedBlockIds: string[] = [];
  if (live) {
    if (sinceVersion === null) {
      const [row] = (await db.execute(sql`
        SELECT coalesce(max(id), 0) AS v FROM doc_updates WHERE document_id = ${documentId} AND created_at <= ${sinceAt.toISOString()}::timestamptz
      `)) as unknown as { v: number | string }[];
      sinceVersion = Number(row?.v ?? 0);
    }
    const rows = (await db.execute(sql`
      SELECT u.actor_id AS "actorId", count(DISTINCT u.id)::int AS n, array_agg(DISTINCT t) AS touched
        FROM doc_updates u, unnest(u.touched) AS t
       WHERE u.document_id = ${documentId} AND u.id > ${sinceVersion}
       GROUP BY u.actor_id
    `)) as unknown as { actorId: string | null; n: number; touched: string[] }[];
    const touched = new Set<string>();
    for (const row of rows) {
      if (isOwn(row.actorId)) continue;
      for (const id of row.touched) touched.add(blockOfFragment(id) ?? id);
      if (row.actorId) person(row.actorId).edits += row.n;
    }
    if (touched.size > 0) {
      const tabs = await withLiveDocument(documentId, (ydoc) => tabsOf(ydoc).map((t) => t.id));
      const deleted = new Set<string>();
      for (const tabId of tabs) {
        const read = await getLiveDoc(documentId, actor, { format: 'markdown', tabId, since: sinceVersion });
        if (!read.ok) continue;
        untilVersion = Math.max(untilVersion ?? 0, read.value.docVersion);
        for (const block of read.value.blocks) {
          if (!touched.has(block.target.blockId)) continue;
          if (changedBlocks.length >= MAX_BLOCKS) moreChangedBlocks++;
          else changedBlocks.push(block.markdown === undefined ? block : { ...block, markdown: text(block.markdown) });
        }
        for (const id of read.value.deletedIds ?? []) if (touched.has(id)) deleted.add(id);
      }
      deletedBlockIds.push(...deleted);
    }
    if (untilVersion === null) {
      const [row] = (await db.execute(sql`
        SELECT coalesce(max(id), 0) AS v FROM doc_updates WHERE document_id = ${documentId}
      `)) as unknown as { v: number | string }[];
      untilVersion = Number(row?.v ?? 0);
    }
  }

  // ── Everything else, from Primer's own events ──
  const rows = (await db.execute(sql`
    SELECT id, type, author_id AS "authorId", payload, created_at AS at
      FROM events
     WHERE document_id = ${documentId} AND namespace = 'primer' AND audience = 'readers' AND created_at > ${sinceAt.toISOString()}::timestamptz
       AND (author_id IS NULL OR author_id NOT IN (${sql.join(excluded.map((id) => sql`${id}`), sql`, `)}))
       AND type IN ('comment.created', 'thread.resolved', 'decision.made', 'decision.cleared', 'suggestion.created',
                    'suggestion.decided', 'task.created', 'task.updated', 'task.deleted', 'version.published')
     ORDER BY id
     LIMIT ${MAX_EVENTS}
  `)) as unknown as EventRow[];
  const events = rows.map((e) => ({ ...e, payload: typeof e.payload === 'string' ? (JSON.parse(e.payload) as Record<string, unknown>) : e.payload }));
  // Past the cap the rest is still to come: `until` stops at the last event read, so a consumer that continues from it misses none.
  const untilAt = rows.length === MAX_EVENTS ? new Date(rows[rows.length - 1]!.at) : new Date();
  const ids = (type: string, key: string) =>
    events.filter((e) => e.type === type).map((e) => e.payload[key]).filter((v): v is string => typeof v === 'string' && UUID_RE.test(v));

  // Every lookup below is scoped to this document: ids come from payloads.
  const commentIds = ids('comment.created', 'comment_id');
  const threadIds = [...new Set([...ids('comment.created', 'thread_id'), ...ids('thread.resolved', 'thread_id')])];
  const comments = new Map(
    (commentIds.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT c.id, c.body, c.deleted_at AS "deletedAt",
                 c.id = (SELECT f.id FROM comments f WHERE f.thread_id = c.thread_id ORDER BY f.created_at, f.id LIMIT 1) AS first
            FROM comments c JOIN threads t ON t.id = c.thread_id
           WHERE t.document_id = ${documentId} AND c.id IN (${sql.join(commentIds.map((id) => sql`${id}`), sql`, `)})
        `)) as unknown as { id: string; body: string; deletedAt: Date | null; first: boolean }[])
    ).map((c) => [c.id, c]),
  );
  const quotes = new Map(
    (threadIds.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT id, anchor FROM threads WHERE document_id = ${documentId} AND id IN (${sql.join(threadIds.map((id) => sql`${id}`), sql`, `)})
        `)) as unknown as { id: string; anchor: unknown }[])
    ).map((t) => [t.id, quoteOf(t.anchor)]),
  );
  const taskIds = [...new Set([...ids('task.created', 'task_id'), ...ids('task.updated', 'task_id')])];
  const titles = new Map(
    (taskIds.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT id, title FROM doc_tasks WHERE document_id = ${documentId} AND id IN (${sql.join(taskIds.map((id) => sql`${id}`), sql`, `)})
        `)) as unknown as { id: string; title: string }[])
    ).map((t) => [t.id, t.title]),
  );
  const decided = new Map(
    ((await db.execute(sql`
      SELECT block_id AS "blockId", option_id AS "optionId", decided_by AS "decidedBy", question, option_label AS "optionLabel", rationale
        FROM doc_decisions WHERE document_id = ${documentId} AND archived_at IS NULL
    `)) as unknown as { blockId: string; optionId: string; decidedBy: string; question: string; optionLabel: string; rationale: string }[]).map((d) => [d.blockId, d]),
  );

  const threads: CatchUpThread[] = [];
  const decisions: CatchUpDecision[] = [];
  const suggestions: CatchUpSuggestion[] = [];
  const tasks: CatchUpTask[] = [];
  const versions: CatchUpVersion[] = [];
  for (const e of events) {
    const p = e.payload;
    const at = new Date(e.at).toISOString();
    const by = e.authorId;
    switch (e.type) {
      case 'comment.created': {
        const c = comments.get(p.comment_id as string);
        if (!c || c.deletedAt !== null) break;
        person(by).comments++;
        threads.push({
          threadId: p.thread_id as string,
          event: c.first ? 'started' : 'replied',
          by,
          at,
          quote: text(quotes.get(p.thread_id as string) ?? ''),
          excerpt: text(c.body.slice(0, EXCERPT)),
        });
        break;
      }
      case 'thread.resolved':
        person(by).resolved++;
        threads.push({ threadId: p.thread_id as string, event: 'resolved', by, at, quote: text(quotes.get(p.thread_id as string) ?? '') });
        break;
      case 'decision.made':
      case 'decision.cleared': {
        person(by).decisions++;
        const blockId = String(p.block_id);
        const entry: CatchUpDecision = { blockId, event: e.type === 'decision.made' ? 'made' : 'cleared', by, at };
        const d = decided.get(blockId);
        // The standing decision describes this event only when it is this pick (a later one replaced it otherwise).
        if (entry.event === 'made' && d && d.optionId === p.option_id && d.decidedBy === by) Object.assign(entry, { question: text(d.question), optionLabel: text(d.optionLabel), rationale: text(d.rationale) });
        decisions.push(entry);
        break;
      }
      case 'suggestion.created':
      case 'suggestion.decided':
        person(by).suggestions++;
        suggestions.push({
          suggestionId: p.suggestion_id as string,
          event: e.type === 'suggestion.created' ? 'created' : (p.decision as CatchUpSuggestion['event']),
          by,
          at,
        });
        break;
      case 'task.created':
      case 'task.updated':
      case 'task.deleted': {
        person(by).tasks++;
        const title = titles.get(p.task_id as string);
        tasks.push({
          taskId: p.task_id as string,
          blockId: String(p.block_id),
          event: e.type.slice('task.'.length) as CatchUpTask['event'],
          status: (p.status as TaskStatus | undefined) ?? null,
          assigneeId: (p.assignee_id as string | null) ?? null,
          ...(title !== undefined && e.type !== 'task.deleted' ? { title: text(title) } : {}),
          at,
        });
        break;
      }
      case 'version.published':
        versions.push({ versionId: p.version_id as string, number: Number(p.number), by, at });
        break;
    }
  }

  // Names, labelled by the server ("<name> (via <person>)" for agents).
  if (people.size > 0) {
    const named = (await db.execute(sql`
      SELECT u.id, ${actorNameOf('u')} AS name, u.kind FROM users u
       WHERE u.id IN (${sql.join([...people.keys()].map((id) => sql`${id}`), sql`, `)})
    `)) as unknown as { id: string; name: string; kind: 'person' | 'agent' }[];
    for (const n of named) Object.assign(people.get(n.id)!, { displayName: n.name, kind: n.kind });
  }

  const value: CatchUpDTO = {
    documentId,
    title: doc.title,
    since: { at: sinceAt.toISOString(), docVersion: live ? sinceVersion : null },
    until: { at: untilAt.toISOString(), docVersion: untilVersion },
    people: [...people.values()],
    changedBlocks,
    moreChangedBlocks,
    deletedBlockIds,
    threads,
    decisions,
    suggestions,
    tasks,
    versions,
  };
  if (forAgent) value.untrusted = true;
  return { ok: true, value };
}

/** Whether a catch-up has anything to tell. */
export function isEmptyCatchUp(c: CatchUpDTO): boolean {
  return (
    c.changedBlocks.length + c.moreChangedBlocks + c.deletedBlockIds.length + c.threads.length + c.decisions.length +
      c.suggestions.length + c.tasks.length + c.versions.length === 0
  );
}

/**
 * The digest (M10b.1): the catch-up of every document in the caller's
 * library that changed after `since`. The library is an agent's person's
 * (as `primer_list_documents` and tasks treat agents): documents they or
 * their agents uploaded, collaborate on, or opened (org documents). Every
 * candidate passes the read gate again in `getCatchUp`, so a document the
 * caller has lost access to (or that was deleted) never appears.
 */
export async function getDigest(actor: AuthUser, since: Date): Promise<DigestResponse> {
  const me = libraryOwnerId(actor);
  // Only what others did counts toward the candidates (and the limit): the
  // caller's own activity never shows in a catch-up, so it must not crowd out
  // a document someone else changed.
  const own = sql.join([...new Set([actor.id, me])].map((id) => sql`${id}`), sql`, `);
  const candidates = (await db.execute(sql`
    SELECT d.id,
           greatest((SELECT max(e.created_at) FROM events e WHERE e.document_id = d.id AND e.namespace = 'primer' AND e.created_at > ${since.toISOString()}::timestamptz AND (e.author_id IS NULL OR e.author_id NOT IN (${own}))),
                    (SELECT max(u.created_at) FROM doc_updates u WHERE u.document_id = d.id AND u.created_at > ${since.toISOString()}::timestamptz AND (u.actor_id IS NULL OR u.actor_id NOT IN (${own})))) AS last
      FROM documents d
     WHERE d.deleted_at IS NULL
       AND (d.uploader_id = ${me} OR d.uploader_id IN (SELECT a.id FROM users a WHERE a.via_user_id = ${me})
            OR EXISTS (SELECT 1 FROM document_collaborators dc WHERE dc.document_id = d.id AND dc.user_id IN (${me}, ${actor.id}))
            OR (d.visibility = 'org' AND EXISTS (SELECT 1 FROM document_views dv WHERE dv.document_id = d.id AND dv.user_id = ${me})))
       AND (EXISTS (SELECT 1 FROM events e WHERE e.document_id = d.id AND e.namespace = 'primer' AND e.created_at > ${since.toISOString()}::timestamptz AND (e.author_id IS NULL OR e.author_id NOT IN (${own})))
            OR EXISTS (SELECT 1 FROM doc_updates u WHERE u.document_id = d.id AND u.created_at > ${since.toISOString()}::timestamptz AND (u.actor_id IS NULL OR u.actor_id NOT IN (${own}))))
     ORDER BY last DESC NULLS LAST
     LIMIT ${MAX_DIGEST_DOCS}
  `)) as unknown as { id: string }[];
  const documents: CatchUpDTO[] = [];
  for (const { id } of candidates) {
    const out = await getCatchUp(actor, id, { at: since.toISOString(), docVersion: null });
    if (out.ok && !isEmptyCatchUp(out.value)) documents.push(out.value);
  }
  return { since: since.toISOString(), until: new Date().toISOString(), documents };
}

function quoteOf(anchor: unknown): string {
  const a = (typeof anchor === 'string' ? JSON.parse(anchor) : anchor) as Record<string, unknown> | null;
  if (!a) return '';
  if (typeof a.quote === 'string') return a.quote;
  if (typeof a.selectorText === 'string') return a.selectorText;
  return '';
}
