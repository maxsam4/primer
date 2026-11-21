import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AgentRunDTO, AgentRunRequest, AgentRunStatus, Refusal, Target } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { runInverses } from '../db/schema.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { readableLiveDoc } from '../lib/liveThreads.ts';
import { canComment, canEdit, loadEffectiveRole, type EffectiveRole } from '../lib/permissions.ts';
import { fenceUntrusted } from '../lib/untrusted.ts';
import { setAgentAwareness } from './awareness.ts';
import type { BlockInverse, DryRun } from './pipeline.ts';
import { docQueue } from './queue.ts';

/** Past either count in one run, more ops need a plan a person approved. */
export const LARGE_RUN_EDITS = 60;
export const LARGE_RUN_REMOVALS = 20;

const MAX_PROMPT = 10_000;
const ACTIVE = ['queued', 'running'] as const;

export type RunResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409; refusal: Refusal };

type RunRow = {
  id: string;
  documentId: string;
  agentId: string;
  requestedBy: string;
  status: AgentRunStatus;
  request: AgentRunRequest;
  statusLine: string | null;
  error: string | null;
  editsApplied: number;
  blocksRemoved: number;
  plan: string | null;
  planHash: string | null;
  planApprovedBy: string | null;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
};

const RUN_COLUMNS = sql`
  id, document_id AS "documentId", agent_id AS "agentId", requested_by AS "requestedBy", status, request,
  status_line AS "statusLine", error, edits_applied AS "editsApplied", blocks_removed AS "blocksRemoved",
  plan, plan_hash AS "planHash", plan_approved_by AS "planApprovedBy", created_at AS "createdAt", started_at AS "startedAt",
  finished_at AS "finishedAt"`;

const fail = (status: 400 | 403 | 404 | 409, code: Refusal['code'], message: string, fix: string): RunResult<never> => ({
  ok: false,
  status,
  refusal: { code, message, fix },
});
const runNotFound = () => fail(404, 'not_found', 'Run not found.', 'List runs with primer_list_runs.');

/** Agents a person can ask on a document: their own agents, and agents that
 *  collaborate on it. */
export async function listDocumentAgents(user: AuthUser, documentId: string): Promise<RunResult<{ id: string; displayName: string }[]>> {
  const doc = await readableLiveDoc(documentId, user);
  if (!doc) return fail(404, 'not_found', 'Live document not found.', 'Check the document id.');
  const rows = (await db.execute(sql`
    SELECT u.id, u.display_name AS "displayName" FROM users u
     WHERE u.kind = 'agent'
       AND (u.via_user_id = ${user.id}
            OR EXISTS (SELECT 1 FROM document_collaborators dc WHERE dc.document_id = ${documentId} AND dc.user_id = u.id))
     ORDER BY u.display_name, u.id
  `)) as unknown as { id: string; displayName: string }[];
  return { ok: true, value: rows };
}

/**
 * Asks an agent to work on a document. The same ask (kind, thread or block,
 * prompt) while one is queued or running returns that run instead of a new
 * one. Emits `run.requested`.
 */
export async function requestRun(
  user: AuthUser,
  documentId: string,
  body: { agentId?: unknown; request?: unknown },
): Promise<RunResult<AgentRunDTO>> {
  const doc = await readableLiveDoc(documentId, user);
  if (!doc || !canComment(doc.visibility, doc.role)) return fail(404, 'not_found', 'Live document not found.', 'Check the document id.');
  const agents = await listDocumentAgents(user, documentId);
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  if (!agents.ok || !agents.value.some((a) => a.id === agentId)) {
    return fail(400, 'bad_request', 'That agent can\'t be asked here.', 'Pick an agent from GET /api/documents/:docId/agents.');
  }
  const request = parseRequest(body.request);
  if (typeof request === 'string') return fail(400, 'bad_request', request, 'Send { kind, prompt, viewer: { tabId, selectedBlockIds, cursorBlockId } }.');
  if (request.threadId) {
    // Ids from the client are scoped to this document.
    const [thread] = (await db.execute(sql`
      SELECT 1 AS hit FROM threads WHERE id = ${request.threadId} AND document_id = ${documentId}
    `)) as unknown as { hit: number }[];
    if (!thread) return fail(400, 'bad_request', 'That thread is not on this document.', 'Send a thread of this document.');
  }
  return { ok: true, value: toDTOFor(user, doc.role, await insertRun(documentId, agentId, user.id, request)) };
}

async function insertRun(documentId: string, agentId: string, requestedBy: string, request: AgentRunRequest): Promise<RunRow> {
  const dedupeKey = createHash('sha256')
    .update(`${request.kind}\n${request.threadId ?? request.blockId ?? ''}\n${request.prompt}`)
    .digest('hex');
  const id = await transactionWithEvents(async (tx, emit) => {
    // The conflicting active run can finish between the INSERT and the
    // SELECT: then there is nothing to return, so insert again.
    for (;;) {
      const inserted = (await tx.execute(sql`
        INSERT INTO agent_runs (id, document_id, agent_id, requested_by, status, request, dedupe_key)
        VALUES (${uuidv7()}, ${documentId}, ${agentId}, ${requestedBy}, 'queued', ${JSON.stringify(request)}::jsonb, ${dedupeKey})
        ON CONFLICT (document_id, agent_id, dedupe_key) WHERE status in ('queued', 'running') DO NOTHING
        RETURNING id
      `)) as unknown as { id: string }[];
      if (inserted[0]) {
        emit({
          documentId,
          actorId: requestedBy,
          type: 'run.requested',
          payload: { document_id: documentId, run_id: inserted[0].id, agent_id: agentId },
        });
        return inserted[0].id;
      }
      const [existing] = (await tx.execute(sql`
        SELECT id FROM agent_runs
         WHERE document_id = ${documentId} AND agent_id = ${agentId} AND dedupe_key = ${dedupeKey} AND status in ('queued', 'running')
      `)) as unknown as { id: string }[];
      if (existing) return existing.id;
    }
  });
  return (await loadRun(id))!;
}

/** Runs on a document, newest first (readers). The request (prompt, unsent
 *  text, selection) is the requester's: only they, the run's agent and the
 *  owner see it; other readers see status and progress. */
export async function listDocumentRuns(user: AuthUser, documentId: string): Promise<RunResult<AgentRunDTO[]>> {
  const doc = await readableLiveDoc(documentId, user);
  if (!doc) return fail(404, 'not_found', 'Live document not found.', 'Check the document id.');
  const rows = (await db.execute(sql`
    SELECT ${RUN_COLUMNS} FROM agent_runs WHERE document_id = ${documentId} ORDER BY created_at DESC LIMIT 100
  `)) as unknown as RunRow[];
  return {
    ok: true,
    value: rows.map((row) => toDTOFor(user, doc.role, row)),
  };
}

/** The calling agent's runs (active by default), oldest first, optionally
 *  for one document or status. What people wrote arrives fenced. */
export async function listAgentRuns(agent: AuthUser, opts: { documentId?: string; status?: string }): Promise<AgentRunDTO[]> {
  const rows = (await db.execute(sql`
    SELECT ${RUN_COLUMNS} FROM agent_runs
     WHERE agent_id = ${agent.id}
       ${opts.documentId ? sql`AND document_id = ${opts.documentId}` : sql``}
       ${opts.status ? sql`AND status = ${opts.status}` : sql`AND status in ('queued', 'running')`}
     ORDER BY created_at LIMIT 100
  `)) as unknown as RunRow[];
  return rows.map((row) => toDTOFor(agent, 'stranger', row));
}

type Transition = {
  /** Statuses the run may be in. */
  from: readonly AgentRunStatus[];
  set: ReturnType<typeof sql>;
  extra?: ReturnType<typeof sql>;
};

/**
 * One status change, written as a job on the document's queue so it never
 * interleaves with an apply: an apply either lands fully before it or sees
 * it in its guard. DB work only (never awaits the pipeline).
 */
async function transition(run: RunRow, by: AuthUser, t: Transition): Promise<RunResult<AgentRunDTO>> {
  const updated = await docQueue(run.documentId)(() =>
    transactionWithEvents(async (tx, emit) => {
      const rows = (await tx.execute(sql`
        UPDATE agent_runs SET ${t.set}
         WHERE id = ${run.id} AND status IN (${sql.join(t.from.map((s) => sql`${s}`), sql`, `)}) ${t.extra ?? sql``}
        RETURNING id
      `)) as unknown as { id: string }[];
      if (rows.length === 0) return false;
      emit({
        documentId: run.documentId,
        actorId: by.id,
        type: 'run.updated',
        payload: { document_id: run.documentId, run_id: run.id, by: by.id },
      });
      return true;
    }),
  );
  const now = (await loadRun(run.id))!;
  const role = (await readableLiveDoc(run.documentId, by))?.role ?? 'stranger';
  if (!updated) {
    if (now.status === 'cancelled' || now.status === 'done' || now.status === 'failed') {
      return fail(409, 'run_cancelled', `The run is ${now.status}.`, 'Start a new run (retry) instead.');
    }
    return fail(409, 'bad_request', `The run can't do that while ${now.status}${now.plan ? '' : ' and without a plan'}.`, 'Check the run\'s status and plan.');
  }
  return { ok: true, value: toDTOFor(by, role, now) };
}

async function agentRun(agent: AuthUser, runId: string): Promise<RunRow | RunResult<never>> {
  const run = await loadRun(runId);
  if (!run || run.agentId !== agent.id) return runNotFound();
  return run;
}

/** Clears the agent's awareness on a document once none of its runs is
 *  active there (a finished run must not wipe another run's status). */
async function clearAwarenessIfIdle(documentId: string, agentId: string): Promise<void> {
  const [{ n }] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM agent_runs
     WHERE document_id = ${documentId} AND agent_id = ${agentId} AND status IN ('queued', 'running')
  `)) as unknown as { n: number }[];
  if (n === 0) await setAgentAwareness(documentId, { id: agentId } as AuthUser, null);
}

export async function claimRun(agent: AuthUser, runId: string): Promise<RunResult<AgentRunDTO>> {
  const run = await agentRun(agent, runId);
  if ('ok' in run) return run;
  // The awareness line shows in the document: only an agent that can read it may set one.
  if (!(await readableLiveDoc(run.documentId, agent))) return runNotFound();
  const out = await transition(run, agent, { from: ['queued'], set: sql`status = 'running', started_at = now()` });
  if (out.ok) await setAgentAwareness(run.documentId, agent, { status: 'Working…', cursorBlockId: null });
  return out;
}

/** The agent's status line (shown in awareness) and, for large runs, its plan. */
export async function updateRunStatus(
  agent: AuthUser,
  runId: string,
  body: { statusLine?: unknown; plan?: unknown },
): Promise<RunResult<AgentRunDTO>> {
  const run = await agentRun(agent, runId);
  if ('ok' in run) return run;
  if (!(await readableLiveDoc(run.documentId, agent))) return runNotFound();
  const statusLine = typeof body.statusLine === 'string' ? body.statusLine.slice(0, 200) : null;
  const plan = typeof body.plan === 'string' && body.plan.trim() ? body.plan.slice(0, 10_000) : null;
  if (statusLine === null && plan === null) return fail(400, 'bad_request', 'Send statusLine or plan.', 'Send { statusLine } or { plan }.');
  const sets = [
    ...(statusLine !== null ? [sql`status_line = ${statusLine}`] : []),
    // A new plan needs a new approval.
    ...(plan !== null
      ? [sql`plan = ${plan}`, sql`plan_hash = ${createHash('sha256').update(plan).digest('hex')}`, sql`plan_approved_by = NULL`]
      : []),
  ];
  const out = await transition(run, agent, { from: ACTIVE, set: sql.join(sets, sql`, `) });
  if (out.ok && statusLine !== null) await setAgentAwareness(run.documentId, agent, { status: statusLine, cursorBlockId: null });
  return out;
}

export async function finishRun(agent: AuthUser, runId: string, body: { error?: unknown }): Promise<RunResult<AgentRunDTO>> {
  const run = await agentRun(agent, runId);
  if ('ok' in run) return run;
  const error = typeof body.error === 'string' && body.error.trim() ? body.error.slice(0, 2000) : null;
  const set = error
    ? sql`status = 'failed', error = ${error}, finished_at = now()`
    : sql`status = 'done', finished_at = now()`;
  const out = await transition(run, agent, { from: ACTIVE, set });
  if (out.ok) await clearAwarenessIfIdle(run.documentId, agent.id);
  return out;
}

/** Who may steer a run: its requester, the owner and editors, and the agent. */
async function steerable(user: AuthUser, runId: string): Promise<RunRow | RunResult<never>> {
  const run = await loadRun(runId);
  if (!run) return runNotFound();
  const doc = await readableLiveDoc(run.documentId, user);
  if (!doc) return runNotFound();
  if (run.requestedBy !== user.id && run.agentId !== user.id && !canEdit(doc.role)) {
    return fail(403, 'forbidden', 'Only the person who asked, the agent, the owner and editors can do this.', 'Ask one of them.');
  }
  return run;
}

export async function cancelRun(user: AuthUser, runId: string): Promise<RunResult<AgentRunDTO>> {
  const run = await steerable(user, runId);
  if ('ok' in run) return run;
  const out = await transition(run, user, { from: ACTIVE, set: sql`status = 'cancelled', finished_at = now()` });
  if (out.ok) await clearAwarenessIfIdle(run.documentId, run.agentId);
  return out;
}

/** A new run with the same request, asked by `user` now: the same checks as
 *  a new ask (access, the agent, the thread), and never by the agent itself. */
export async function retryRun(user: AuthUser, runId: string): Promise<RunResult<AgentRunDTO>> {
  const run = await steerable(user, runId);
  if ('ok' in run) return run;
  // Only the person who asked repeats their own ask (an agent never does).
  if (user.id !== run.requestedBy || user.id === run.agentId) {
    return fail(403, 'forbidden', 'Only the person who asked can retry a run.', 'Ask the agent with a new request instead (POST /api/documents/:docId/runs).');
  }
  if (run.status === 'queued' || run.status === 'running') {
    return fail(409, 'bad_request', 'The run is still active.', 'Cancel it first, or wait for it to finish.');
  }
  return requestRun(user, run.documentId, { agentId: run.agentId, request: run.request });
}

/** A person (owner or editor) approves the run's plan, so it may pass the
 *  large-edit threshold. On the document queue, like cancel. */
export async function approveRun(user: AuthUser, runId: string, body: { planHash?: unknown } = {}): Promise<RunResult<AgentRunDTO>> {
  const run = await loadRun(runId);
  if (!run) return runNotFound();
  const doc = await readableLiveDoc(run.documentId, user);
  if (!doc) return runNotFound();
  // An agent inherits editor from its person: it must never approve a plan.
  if (user.kind !== 'person' || !canEdit(doc.role)) {
    return fail(403, 'forbidden', 'Only a person who owns or edits the document can approve a plan.', 'Ask the owner or an editor.');
  }
  const planHash = typeof body.planHash === 'string' ? body.planHash : '';
  if (!planHash) return fail(400, 'bad_request', 'Send the planHash of the plan you approve.', 'Read the run and send its planHash.');
  const out = await transition(run, user, {
    from: ACTIVE,
    set: sql`plan_approved_by = ${user.id}`,
    extra: sql`AND plan IS NOT NULL AND plan_hash = ${planHash}`,
  });
  if (!out.ok && out.refusal.code === 'bad_request') {
    const now = (await loadRun(runId))!;
    if (now.planHash && now.planHash !== planHash) {
      return fail(409, 'plan_changed', 'The agent replaced the plan since you read it.', 'Read the new plan and approve that one.');
    }
  }
  return out;
}

/**
 * Run support for a batch of ops (live/ops.ts): the run must be this agent's
 * and this document's. The guard runs on the document queue with the batch's
 * dry run (pipeline `dryRun`: blocks added, changed or moved, and blocks
 * removed, by id on the live document). One conditional UPDATE reserves that
 * work if the run is still active and either has an approved plan or stays
 * under the large-edit threshold; otherwise the batch is refused
 * (`run_cancelled` or `approval_required`). Fail closed: a dry run with an op
 * that would not apply while the rest removes or moves blocks needs an
 * approved plan whatever the counts. The reservation is not refunded for ops
 * that end as conflicts.
 */
export async function runHooks(documentId: string, actor: AuthUser, runId: string) {
  const run = await loadRun(runId);
  if (!run || run.agentId !== actor.id || run.documentId !== documentId) {
    return { code: 'not_found', message: 'Run not found for this agent and document.', fix: 'Pass a runId from primer_list_runs for this document, or none.' } as Refusal;
  }
  // A run acts for its requester: it never edits more than they could (read
  // now, so a requester who lost access stops the run's edits too). A
  // requester who can't edit gets the run's edits as suggestions.
  const [doc] = (await db.execute(sql`
    SELECT id, uploader_id AS "uploaderId", visibility FROM documents WHERE id = ${documentId}
  `)) as unknown as { id: string; uploaderId: string; visibility: 'org' | 'private' }[];
  const [requester] = (await db.execute(sql`
    SELECT id, email, display_name AS "displayName", kind, via_user_id AS "viaUserId" FROM users WHERE id = ${run.requestedBy}
  `)) as unknown as AuthUser[];
  if (!doc || !requester) return { code: 'not_found', message: 'Run not found for this agent and document.', fix: 'Pass a runId from primer_list_runs for this document, or none.' } as Refusal;
  const suggestOnly = !canEdit(await loadEffectiveRole(doc, requester));
  return {
    /** The requester can't edit: the run's edits become suggestions. */
    suggestOnly,
    guard: async (work: DryRun): Promise<Refusal | null> => {
      const underBudget = work.unresolved
        ? sql`FALSE`
        : sql`(edits_applied + ${work.edits} <= ${LARGE_RUN_EDITS} AND blocks_removed + ${work.removals} <= ${LARGE_RUN_REMOVALS})`;
      const rows = (await db.execute(sql`
        UPDATE agent_runs
           SET edits_applied = edits_applied + ${work.edits}, blocks_removed = blocks_removed + ${work.removals}
         WHERE id = ${runId} AND document_id = ${documentId} AND status IN ('queued', 'running')
           AND (plan_approved_by IS NOT NULL OR ${underBudget})
        RETURNING id
      `)) as unknown as { id: string }[];
      if (rows.length > 0) return null;
      const now = (await loadRun(runId))!;
      if (now.status !== 'queued' && now.status !== 'running') {
        return { code: 'run_cancelled', message: `The run is ${now.status}; nothing was applied.`, fix: 'Stop working on this run.' };
      }
      if (work.unresolved) {
        return {
          code: 'approval_required',
          message: 'Some ops in this batch would not apply while others remove or move blocks, so its removals can\'t be counted safely; nothing was applied.',
          fix: 'Read the document again and send the batch with current targets and versions, or send the removals and moves in a batch of their own.',
          details: { editsApplied: now.editsApplied, blocksRemoved: now.blocksRemoved, unresolved: true },
        };
      }
      return {
        code: 'approval_required',
        message: `This run would pass ${LARGE_RUN_EDITS} edits or ${LARGE_RUN_REMOVALS} removed blocks; nothing was applied.`,
        fix:
          run.request.kind === 'direct'
            ? 'An edit this large needs a run a person asked for: ask them to request one, then post your plan on it with primer_update_run and wait for their approval.'
            : 'Post your plan with primer_update_run (action "status", plan) and wait until a person approves it, then send the ops again.',
        details: { editsApplied: now.editsApplied, blocksRemoved: now.blocksRemoved },
      };
    },
    beforeWrite: async ({ inverses }: { inverses: BlockInverse[] }) => {
      if (inverses.length === 0) return;
      await db.insert(runInverses).values(
        inverses.map((inv) => ({
          runId,
          documentId,
          target: inv.target as unknown as Record<string, unknown>,
          prior: inv.prior,
          afterVersion: inv.afterVersion,
          // A moved block's post-run place rides along as `after` (undo checks it).
          place: (inv.afterPlace ? { ...inv.place, after: inv.afterPlace } : inv.place) as unknown as Record<string, unknown> | null,
        })),
      );
    },
    onTarget: (target: Target) => {
      void setAgentAwareness(documentId, actor, {
        status: run.statusLine ?? 'Editing…',
        cursorBlockId: target.blockId,
        tabId: target.tabId,
      });
    },
  };
}

/** The agent's queued or running runs a person asked for on the document. */
export async function activeRequestedRunIds(documentId: string, agentId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT id FROM agent_runs
     WHERE document_id = ${documentId} AND agent_id = ${agentId} AND status IN ('queued', 'running')
       AND request->>'kind' <> 'direct'
     ORDER BY created_at
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** The run an agent's write without a runId goes under: running from the
 *  start, asked by the agent itself, so its edits have inverses (undo), a
 *  budget and attribution like any run. Finish it with `finishDirectRun`. */
export async function startDirectRun(documentId: string, agent: AuthUser): Promise<string> {
  const id = uuidv7();
  const request: AgentRunRequest = { kind: 'direct', prompt: '', viewer: { tabId: '', selectedBlockIds: [], cursorBlockId: null } };
  await db.execute(sql`
    INSERT INTO agent_runs (id, document_id, agent_id, requested_by, status, request, dedupe_key, started_at)
    VALUES (${id}, ${documentId}, ${agent.id}, ${agent.id}, 'running', ${JSON.stringify(request)}::jsonb, ${id}, now())
  `);
  return id;
}

export async function finishDirectRun(runId: string, error: string | null): Promise<void> {
  await db.execute(sql`
    UPDATE agent_runs SET ${error ? sql`status = 'failed', error = ${error}` : sql`status = 'done'`}, finished_at = now()
     WHERE id = ${runId} AND status = 'running'
  `);
}

/** The viewer context of a run, for the agent's reads. */
export async function runViewer(documentId: string, agent: AuthUser, runId: string) {
  const run = await loadRun(runId);
  if (!run || run.agentId !== agent.id || run.documentId !== documentId) return null;
  return fencedRequest(run.request).viewer;
}

export async function loadRun(runId: string): Promise<RunRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(runId)) return null;
  const [row] = (await db.execute(sql`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = ${runId}`)) as unknown as RunRow[];
  return row ?? null;
}

function iso(d: Date | string | null): string | null {
  return d === null ? null : new Date(d).toISOString();
}

/**
 * A run as `user` may see it. Every run returned to a caller goes through
 * here: the request (prompt, unsent text, selection) is the requester's, so
 * only they, the run's agent and the document owner get it; others see
 * status and progress with `request: null`. The agent gets it fenced: it is
 * text written by people, data rather than instructions.
 */
export function toDTOFor(user: AuthUser, role: EffectiveRole, row: RunRow): AgentRunDTO {
  const dto = toDTO(row);
  if (row.agentId === user.id) return { ...dto, request: fencedRequest(row.request) };
  const mayRead = row.requestedBy === user.id || row.agentId === user.id || role === 'owner';
  return mayRead ? dto : { ...dto, request: null };
}

/** A run with its full request (callers: `toDTOFor`, and the agent's own list). */
function toDTO(row: RunRow): AgentRunDTO & { request: AgentRunRequest } {
  return {
    id: row.id,
    documentId: row.documentId,
    agentId: row.agentId,
    requestedBy: row.requestedBy,
    status: row.status,
    request: row.request,
    statusLine: row.statusLine,
    error: row.error,
    editsApplied: row.editsApplied,
    blocksRemoved: row.blocksRemoved,
    plan: row.plan,
    planHash: row.planHash,
    planApprovedBy: row.planApprovedBy,
    createdAt: iso(row.createdAt)!,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

function fencedRequest(request: AgentRunRequest): AgentRunRequest {
  const viewer = { ...request.viewer };
  if (viewer.unsentText !== undefined) viewer.unsentText = fenceUntrusted(viewer.unsentText, 'request');
  return { ...request, prompt: fenceUntrusted(request.prompt, 'request'), viewer };
}

function parseRequest(raw: unknown): AgentRunRequest | string {
  if (!raw || typeof raw !== 'object') return 'request is required.';
  const r = raw as Record<string, unknown>;
  if (!['mention', 'send', 'inline', 'selection'].includes(r.kind as string)) return 'request.kind must be mention, send, inline or selection.';
  if (typeof r.prompt !== 'string' || r.prompt.trim() === '' || r.prompt.length > MAX_PROMPT) return `request.prompt must be 1–${MAX_PROMPT} characters.`;
  const v = r.viewer as Record<string, unknown> | undefined;
  if (
    !v ||
    typeof v.tabId !== 'string' ||
    !Array.isArray(v.selectedBlockIds) ||
    !v.selectedBlockIds.every((id) => typeof id === 'string') ||
    !(v.cursorBlockId === null || typeof v.cursorBlockId === 'string') ||
    !(v.unsentText === undefined || typeof v.unsentText === 'string')
  ) {
    return 'request.viewer must be { tabId, selectedBlockIds, cursorBlockId, unsentText? }.';
  }
  const out: AgentRunRequest = {
    kind: r.kind as AgentRunRequest['kind'],
    prompt: r.prompt,
    viewer: {
      tabId: v.tabId,
      selectedBlockIds: v.selectedBlockIds as string[],
      cursorBlockId: v.cursorBlockId as string | null,
      ...(typeof v.unsentText === 'string' ? { unsentText: v.unsentText.slice(0, MAX_PROMPT) } : {}),
    },
  };
  if (typeof r.threadId === 'string') out.threadId = r.threadId;
  if (typeof r.blockId === 'string') out.blockId = r.blockId;
  return out;
}
