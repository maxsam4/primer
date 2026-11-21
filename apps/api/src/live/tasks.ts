// Task blocks become tracked tasks.
//
// `doc_tasks` is an index of the task blocks in a live document, never
// written any other way: every change to a loaded document schedules a
// reconcile (debounced per document), which reads the task blocks from the
// Y.Doc, brings the rows in line, and announces each difference as
// `task.created`, `task.updated` or `task.deleted`. Attribution is per block:
// each person or agent whose transactions touched that block in the window
// authors one event. A change no person or agent made (the system, or drift
// found later) updates the index and announces nothing: it is never pinned on
// someone. `rebuildTaskIndex` recreates the rows from the document. Primer
// runs no task system of its own: assignees (people or agents) act on the
// events, and ticking the box is what closes a task.
//
// The document is client-writable, so everything read from it is checked
// before it reaches the index: block ids by an exact pattern, assignees
// against the users table, due dates as dates.
import { sql } from 'drizzle-orm';
import {
  TASK_STATUSES,
  inlineText,
} from '@primer/blocks';
import type {
  AddTaskRequest,
  AddTaskResponse,
  AssigneesResponse,
  TaskDTO,
  TaskStatus,
  TasksResponse,
  UpdateTaskRequest,
} from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { transactionWithEvents, type EmitLifecycle } from '../lib/events.ts';
import { canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { fenceUntrusted } from '../lib/untrusted.ts';
import { logger } from '../logger.ts';
import {
  checkPlacement,
  findLiveBlock,
  insertBlock,
  liveBlocks,
  liveDocAccess,
  newBlockId,
  refuse,
  setBlockProps,
  validBlockId,
  type Result,
} from './blockTools.ts';
import { onLiveLoad, onLiveUpdate, withLiveDocument } from './instance.ts';
import { tabsOf } from './reach.ts';
import { SYSTEM_ORIGIN, type LiveOrigin } from './origin.ts';

export const TASK_SYNC_DELAY_MS = 500;
const MAX_TASKS_PER_DOCUMENT = 1_000;
const DUE = /^\d{4}-\d{2}-\d{2}$/;
const TAB_ID = /^[\w-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const TASKS_LOCK_KEY = 7_201_950;

type BlockTask = { tabId: string; blockId: string; title: string; assigneeId: string | null; due: string | null; status: TaskStatus };

/** A real calendar date: it must round-trip to the same YYYY-MM-DD. */
function validDue(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !DUE.test(raw)) return false;
  // PostgreSQL has no year 0 (its date type starts at 0001-01-01).
  if (raw.startsWith('0000')) return false;
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

/** One task block as indexed, or null when it can't be: everything here came
 *  from the client-writable document, so it is checked before it reaches SQL. */
function checkedTask(tabId: string, block: { id: string; content?: unknown; props: unknown }): BlockTask | null {
  if (!validBlockId(block.id) || !TAB_ID.test(tabId)) return null;
  const p = block.props as Record<string, unknown>;
  const assignee = p.assigneeId;
  return {
    tabId,
    blockId: block.id,
    title: inlineText(block.content).replace(CONTROL, ' ').trim().slice(0, 500),
    assigneeId:
      typeof assignee === 'string' && assignee.length > 0 && assignee.length <= 200 && !/[\u0000-\u001f\u007f]/.test(assignee)
        ? assignee
        : null,
    due: validDue(p.due) ? p.due : null,
    status: (TASK_STATUSES as readonly string[]).includes(p.status as string) ? (p.status as TaskStatus) : 'open',
  };
}

/** The task blocks of a document, as read (not yet checked against users). */
function tasksIn(doc: Parameters<Parameters<typeof withLiveDocument>[1]>[0]): BlockTask[] {
  const out: BlockTask[] = [];
  const seen = new Set<string>();
  for (const { tabId, block } of liveBlocks(doc)) {
    if (block.type !== 'task' || seen.has(block.id)) continue;
    const task = checkedTask(tabId, block);
    if (!task) continue;
    seen.add(task.blockId);
    out.push(task);
    if (out.length >= MAX_TASKS_PER_DOCUMENT) break;
  }
  return out;
}

type Row = { id: string; tabId: string; blockId: string; title: string; assigneeId: string | null; due: string | null; status: TaskStatus };

/** Who touched which block in a sync window: person and agent ids per block id. */
export type BlockActors = Map<string, Set<string>>;

/**
 * Brings `doc_tasks` in line with the document's task blocks. With `emit`,
 * each difference becomes one lifecycle event per person or agent in
 * `actors` for that block, and none when nobody is known. `rebuild` first
 * empties the document's rows, in the same transaction.
 */
export async function reconcileTasks(
  documentId: string,
  opts: { actors?: BlockActors; emit: boolean; rebuild?: boolean },
): Promise<void> {
  await transactionWithEvents(async (tx, emit) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TASKS_LOCK_KEY}, hashtext(${documentId}))`);
    if (opts.rebuild) await tx.execute(sql`DELETE FROM doc_tasks WHERE document_id = ${documentId}`);
    const [doc] = (await tx.execute(sql`
      SELECT uploader_id AS "uploaderId", format, deleted_at AS "deletedAt" FROM documents WHERE id = ${documentId}
    `)) as unknown as { uploaderId: string; format: string | null; deletedAt: Date | null }[];
    if (!doc || !doc.format) return;
    const { found, tabIds } = await withLiveDocument(documentId, (d) => ({ found: tasksIn(d), tabIds: new Set(tabsOf(d).map((t) => t.id)) }));
    const touchedBy = [...(opts.actors?.values() ?? [])].flatMap((set) => [...set]);
    const ids = [...new Set([...found.map((t) => t.assigneeId), ...touchedBy].filter((id): id is string => Boolean(id)))];
    const known = new Set(
      ids.length === 0
        ? []
        : ((await tx.execute(sql`SELECT id FROM users WHERE id = ANY(${pgTextArray(ids)}::text[])`)) as unknown as { id: string }[]).map(
            (r) => r.id,
          ),
    );
    for (const t of found) if (t.assigneeId && !known.has(t.assigneeId)) t.assigneeId = null;
    /** The people and agents who changed this block in the window. */
    const actorsOf = (key: string) => [...(opts.actors?.get(key) ?? [])].filter((id) => known.has(id)).sort();

    const rows = (await tx.execute(sql`
      SELECT id, tab_id AS "tabId", block_id AS "blockId", title, assignee_id AS "assigneeId",
             to_char(due_date, 'YYYY-MM-DD') AS due, status
        FROM doc_tasks WHERE document_id = ${documentId}
    `)) as unknown as Row[];
    const byBlock = new Map(rows.map((r) => [r.blockId, r]));
    /** One event per actor who changed the block; none when nobody is known. */
    const announce = <T extends 'task.created' | 'task.updated' | 'task.deleted'>(
      blockId: string,
      type: T,
      payload: Parameters<EmitLifecycle>[0]['payload'] & object,
      /** Who to credit when nobody touched the block itself. */
      otherwise?: string,
    ) => {
      if (!opts.emit) return;
      const actors = actorsOf(blockId);
      for (const actorId of actors.length > 0 || otherwise === undefined ? actors : actorsOf(otherwise)) {
        emit({ documentId, actorId, type, payload } as never);
      }
    };

    for (const t of found) {
      const row = byBlock.get(t.blockId);
      byBlock.delete(t.blockId);
      if (!row) {
        const [inserted] = (await tx.execute(sql`
          INSERT INTO doc_tasks (document_id, tab_id, block_id, title, assignee_id, due_date, status, created_by)
          VALUES (${documentId}, ${t.tabId}, ${t.blockId}, ${t.title}, ${t.assigneeId}, ${t.due}::date, ${t.status},
                  ${actorsOf(t.blockId).length === 1 ? actorsOf(t.blockId)[0] : null})
          RETURNING id
        `)) as unknown as { id: string }[];
        announce(t.blockId, 'task.created', {
          document_id: documentId, task_id: inserted!.id, block_id: t.blockId, assignee_id: t.assigneeId, status: t.status,
        });
        continue;
      }
      const changed: ('title' | 'assignee' | 'due' | 'status')[] = [];
      if (row.title !== t.title) changed.push('title');
      if (row.assigneeId !== t.assigneeId) changed.push('assignee');
      if (row.due !== t.due) changed.push('due');
      if (row.status !== t.status) changed.push('status');
      if (changed.length === 0 && row.tabId === t.tabId) continue;
      await tx.execute(sql`
        UPDATE doc_tasks SET tab_id = ${t.tabId}, title = ${t.title}, assignee_id = ${t.assigneeId},
               due_date = ${t.due}::date, status = ${t.status}, updated_at = now()
         WHERE id = ${row.id}
      `);
      if (changed.length === 0) continue;
      announce(t.blockId, 'task.updated', {
        document_id: documentId, task_id: row.id, block_id: t.blockId, assignee_id: t.assigneeId, status: t.status, changed,
      });
    }
    for (const row of byBlock.values()) {
      await tx.execute(sql`DELETE FROM doc_tasks WHERE id = ${row.id}`);
      // A task whose tab was removed is credited to whoever changed the tab list.
      announce(
        row.blockId,
        'task.deleted',
        { document_id: documentId, task_id: row.id, block_id: row.blockId, assignee_id: row.assigneeId },
        tabIds.has(row.tabId) ? undefined : 'tabs',
      );
    }
  });
}

/** Recreates a document's task index from its Y.Doc in one transaction,
 *  announcing nothing. */
export async function rebuildTaskIndex(documentId: string): Promise<void> {
  await reconcileTasks(documentId, { emit: false, rebuild: true });
}

// ───────────────────────── The live-update hook ─────────────────────────

type Pending = { actors: BlockActors; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const running = new Set<Promise<void>>();

function run(documentId: string, actors: BlockActors): void {
  const job = reconcileTasks(documentId, { actors, emit: true }).catch((err: unknown) => {
    logger.warn({ documentId, error: String(err) }, 'tasks: index sync failed');
  });
  running.add(job);
  void job.finally(() => running.delete(job));
}

/** Schedules a reconcile of a document's tasks, remembering which person or
 *  agent touched which blocks (system changes are remembered by nobody). */
export function scheduleTaskSync(documentId: string, origin: LiveOrigin, touched: string[]): void {
  let entry = pending.get(documentId);
  if (!entry) {
    const created: Pending = {
      actors: new Map(),
      timer: setTimeout(() => {
        pending.delete(documentId);
        run(documentId, created.actors);
      }, TASK_SYNC_DELAY_MS),
    };
    created.timer.unref?.();
    pending.set(documentId, created);
    entry = created;
  }
  if (origin.kind === 'system') return;
  for (const blockId of touched) {
    const set = entry.actors.get(blockId) ?? new Set<string>();
    set.add(origin.actorId);
    entry.actors.set(blockId, set);
  }
}

/** Runs every scheduled sync now and waits for all of them (tests, shutdown). */
export async function flushTaskSync(): Promise<void> {
  for (const [documentId, entry] of [...pending]) {
    clearTimeout(entry.timer);
    pending.delete(documentId);
    run(documentId, entry.actors);
  }
  await Promise.all([...running]);
}

onLiveUpdate(scheduleTaskSync);

// Edits made while a document was unloaded (or before this index existed)
// reach the rows when it loads: an ordinary scheduled sync with nobody known,
// so it announces nothing for them, and edits arriving in the same window
// are still announced to their authors.
onLiveLoad((documentId) => scheduleTaskSync(documentId, SYSTEM_ORIGIN, []));

// ───────────────────────── Reads ─────────────────────────

type ListRow = Row & { documentId: string; createdBy: string | null; createdAt: Date | string; updatedAt: Date | string };

function dto(r: ListRow, actor: AuthUser): TaskDTO {
  const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
  const out: TaskDTO = {
    id: r.id,
    documentId: r.documentId,
    target: { tabId: r.tabId, blockId: r.blockId },
    title: r.title,
    assigneeId: r.assigneeId,
    due: r.due,
    status: r.status,
    createdBy: r.createdBy,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
  if (actor.kind === 'agent') {
    out.untrusted = true;
    out.title = fenceUntrusted(out.title, 'content');
  }
  return out;
}

const LIST_COLUMNS = sql`t.id, t.document_id AS "documentId", t.tab_id AS "tabId", t.block_id AS "blockId", t.title,
  t.assignee_id AS "assigneeId", to_char(t.due_date, 'YYYY-MM-DD') AS due, t.status, t.created_by AS "createdBy",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;

/** One document's tasks (readers), in document order of first indexing. */
export async function listDocumentTasks(actor: AuthUser, documentId: string): Promise<Result<TasksResponse>> {
  const access = await liveDocAccess(documentId, actor);
  if (!access.ok) return access;
  const rows = (await db.execute(sql`
    SELECT ${LIST_COLUMNS} FROM doc_tasks t WHERE t.document_id = ${documentId} ORDER BY t.created_at, t.id
  `)) as unknown as ListRow[];
  return { ok: true, value: { tasks: rows.map((r) => dto(r, actor)) } };
}

/** The caller's open and done tasks across the documents it can still read. */
export async function listMyTasks(actor: AuthUser): Promise<Result<TasksResponse>> {
  const PAGE = 200;
  const tasks: TaskDTO[] = [];
  const readable = new Map<string, boolean>();
  // Page until 200 readable tasks (documents the caller lost access to must not crowd them out).
  for (let offset = 0; tasks.length < PAGE; offset += PAGE) {
    const rows = (await db.execute(sql`
      SELECT ${LIST_COLUMNS}, d.uploader_id AS "uploaderId", d.visibility
        FROM doc_tasks t JOIN documents d ON d.id = t.document_id
       WHERE t.assignee_id = ${actor.id} AND d.deleted_at IS NULL
       ORDER BY t.status, t.updated_at DESC, t.id
       LIMIT ${PAGE} OFFSET ${offset}
    `)) as unknown as (ListRow & { uploaderId: string; visibility: Visibility })[];
    for (const r of rows) {
      let ok = readable.get(r.documentId);
      if (ok === undefined) {
        const role = await loadEffectiveRole({ id: r.documentId, uploaderId: r.uploaderId, visibility: r.visibility }, actor);
        ok = canRead(r.visibility, role);
        readable.set(r.documentId, ok);
      }
      if (ok && tasks.length < PAGE) tasks.push(dto(r, actor));
    }
    if (rows.length < PAGE) break;
  }
  return { ok: true, value: { tasks } };
}

/** People with access to the document, and their agents: who a task can go to. */
export async function listAssignees(actor: AuthUser, documentId: string): Promise<Result<AssigneesResponse>> {
  const access = await liveDocAccess(documentId, actor);
  if (!access.ok) return access;
  const rows = (await db.execute(sql`
    WITH people AS (
      SELECT uploader_id AS id FROM documents WHERE id = ${documentId}
      UNION SELECT user_id FROM document_collaborators WHERE document_id = ${documentId}
    )
    SELECT u.id, u.display_name AS name, u.kind FROM users u
     WHERE u.id IN (SELECT id FROM people) OR u.via_user_id IN (SELECT id FROM people)
     ORDER BY u.kind DESC, u.display_name
     LIMIT 500
  `)) as unknown as { id: string; name: string; kind: 'person' | 'agent' }[];
  return { ok: true, value: { assignees: rows } };
}

// ───────────────────────── Writes ─────────────────────────

/** Adds a task block (open). The index picks it up like any other edit. */
export async function addTask(actor: AuthUser, documentId: string, req: AddTaskRequest): Promise<Result<AddTaskResponse>> {
  const bad =
    (typeof req.title === 'string' && req.title.trim().length > 0 && req.title.length <= 500 ? null : 'title must be 1–500 characters') ??
    (req.assigneeId === undefined || (typeof req.assigneeId === 'string' && req.assigneeId.length <= 200) ? null : 'assigneeId must be a user id') ??
    (req.due === undefined || validDue(req.due) ? null : 'due must be a date (YYYY-MM-DD)') ??
    checkPlacement(req);
  if (bad) return refuse('bad_request', bad);
  const access = await liveDocAccess(documentId, actor, true);
  if (!access.ok) return access;
  if (req.assigneeId) {
    const [user] = (await db.execute(sql`SELECT id FROM users WHERE id = ${req.assigneeId}`)) as unknown as { id: string }[];
    if (!user) return refuse('bad_request', `No user has id ${req.assigneeId}.`, 'Pick an assignee from GET /api/documents/:docId/assignees.');
  }
  return insertBlock(actor, documentId, req, {
    id: newBlockId(),
    type: 'task',
    props: { assigneeId: req.assigneeId ?? '', due: req.due ?? '', status: 'open' },
    content: req.title.trim(),
  } as never);
}

/** Sets a task's status and the assignee's progress line, shown inline. */
export async function updateTask(
  actor: AuthUser,
  documentId: string,
  blockId: string,
  req: UpdateTaskRequest,
): Promise<Result<{ docVersion: number }>> {
  if (!validBlockId(blockId)) return refuse('not_found', 'Task not found.');
  const bad =
    (req.status === undefined || (TASK_STATUSES as readonly string[]).includes(req.status) ? null : 'status must be open or done') ??
    (req.progress === undefined || (typeof req.progress === 'string' && req.progress.length <= 200) ? null : 'progress must be at most 200 characters');
  if (bad) return refuse('bad_request', bad);
  if (req.status === undefined && req.progress === undefined) return refuse('bad_request', 'Give a status, a progress line, or both.');
  const access = await liveDocAccess(documentId, actor, true);
  if (!access.ok) return access;
  const found = await withLiveDocument(documentId, (doc) => findLiveBlock(doc, blockId, 'task'));
  if (!found) return refuse('not_found', 'Task not found.');
  const props: Record<string, string> = {};
  if (req.status !== undefined) props.status = req.status;
  if (req.progress !== undefined) props.progress = req.progress;
  return setBlockProps(
    actor,
    documentId,
    { tabId: found.tabId, blockId },
    (block) => (block.type === 'task' ? null : refuse('not_found', 'Task not found.').refusal),
    props,
  );
}

function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
}
