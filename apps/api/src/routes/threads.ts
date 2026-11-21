import type { Hono } from 'hono';
import { placeReopened } from '../lib/threadCarry.ts';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { isTextRangeAnchor, isElementPathAnchor, type Refusal } from '@polygonlabs/primer-api-types';
import type { AppVariables, AppDeps, AuthUser } from '../app.ts';
import { logger } from '../logger.ts';
import type { CreateThreadRequest, ThreadDTO, ThreadsListResponse } from '@polygonlabs/primer-api-types';
import { threads, threadPlacements, comments, users } from '../db/schema.ts';
import { db } from '../db/client.ts';
import { loadThread, loadThreads } from '../lib/threadList.ts';
import { reanchorThread, createLiveThread, listLiveThreads, setReaction } from '../lib/liveThreads.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { validateAndCleanMentions } from '../notifications/mentions.ts';
import type { Visibility } from '../lib/permissions.ts';
import { loadEffectiveRole, canRead, canComment, ownerPersonOf } from '../lib/permissions.ts';

async function loadDocContextForVersion(
  versionId: string,
): Promise<
  | { ok: false }
  | { ok: true; docId: string; uploaderId: string; visibility: Visibility }
> {
  const [r] = (await db.execute(sql`
    SELECT d.id AS "docId",
           d.uploader_id AS "uploaderId",
           d.visibility   AS "visibility",
           d.deleted_at   AS "deletedAt"
    FROM versions v
    INNER JOIN documents d ON d.id = v.document_id
    WHERE v.id = ${versionId}
    LIMIT 1
  `)) as unknown as {
    docId: string;
    uploaderId: string;
    visibility: Visibility;
    deletedAt: Date | null;
  }[];
  if (!r) return { ok: false };
  if (r.deletedAt !== null) return { ok: false };
  return { ok: true, docId: r.docId, uploaderId: r.uploaderId, visibility: r.visibility };
}

async function loadDocContextForThread(
  threadId: string,
): Promise<
  | { ok: false }
  | { ok: true; docId: string; uploaderId: string; visibility: Visibility }
> {
  const [r] = (await db.execute(sql`
    SELECT d.id AS "docId",
           d.uploader_id AS "uploaderId",
           d.visibility   AS "visibility",
           d.deleted_at   AS "deletedAt"
    FROM threads t
    INNER JOIN documents d ON d.id = t.document_id
    WHERE t.id = ${threadId}
    LIMIT 1
  `)) as unknown as {
    docId: string;
    uploaderId: string;
    visibility: Visibility;
    deletedAt: Date | null;
  }[];
  if (!r) return { ok: false };
  if (r.deletedAt !== null) return { ok: false };
  return { ok: true, docId: r.docId, uploaderId: r.uploaderId, visibility: r.visibility };
}

async function computeVersionEtag(versionId: string): Promise<string> {
  const result = await db.execute(sql`
    SELECT
      COALESCE(GREATEST(
        MAX(t.created_at), MAX(t.resolved_at),
        MAX(c.created_at), MAX(c.updated_at), MAX(c.deleted_at)
      ), 'epoch'::timestamptz) AS max_ts,
      COUNT(DISTINCT t.id)::int AS thread_count,
      COUNT(c.id)::int AS comment_count
    FROM thread_placements p
    INNER JOIN threads t ON t.id = p.thread_id
    LEFT JOIN comments c ON c.thread_id = t.id
    WHERE p.version_id = ${versionId}
  `);
  const row = (result as unknown as { max_ts: string | Date; thread_count: number; comment_count: number }[])[0];
  const maxTsIso = row.max_ts instanceof Date ? row.max_ts.toISOString() : new Date(row.max_ts).toISOString();
  const hash = createHash('sha256')
    .update(`${maxTsIso}|${row.thread_count}|${row.comment_count}`)
    .digest('hex')
    .slice(0, 16);
  return `W/"${hash}"`;
}

const MAX_BODY = 5000;

function validateBody(raw: unknown): { ok: true; body: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BODY) return { ok: false };
  return { ok: true, body: trimmed };
}

function validateAnchor(raw: unknown): boolean {
  return isTextRangeAnchor(raw) || isElementPathAnchor(raw);
}

export type ResolveResult =
  | { ok: true; thread: ThreadDTO }
  | { ok: false; status: 403 | 404; error: 'forbidden' | 'not_found'; refusal: Refusal };

/** Resolves a thread as `user`. Shared by the REST route and the MCP
 *  resolve tool; see authorizeThreadMutation for who may. */
export async function resolveThread(user: AuthUser, threadId: string): Promise<ResolveResult> {
  const authz = await authorizeThreadMutation(threadId, user);
  if (!authz.ok) return authz;
  const { ctx } = authz;

  await transactionWithEvents(async (tx, emit) => {
    await tx
      .update(threads)
      .set({ resolvedAt: new Date(), resolvedBy: user.id })
      .where(eq(threads.id, threadId));
    emit({
      documentId: ctx.docId,
      actorId: user.id,
      type: 'thread.resolved',
      payload: { document_id: ctx.docId, thread_id: threadId, by: user.id },
    });
  });
  const dto = await loadThread(threadId);
  if (!dto) return { ok: false, status: 404, error: 'not_found', refusal: THREAD_NOT_FOUND };
  return { ok: true, thread: dto };
}

export function registerThreadRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.get('/api/versions/:versionId/threads', async (c) => {
    const versionId = c.req.param('versionId');

    const ctx = await loadDocContextForVersion(versionId);
    if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
    const user = c.get('user');
    const eff = await loadEffectiveRole({ id: ctx.docId, uploaderId: ctx.uploaderId, visibility: ctx.visibility as Visibility }, user);
    if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    const currentEtag = await computeVersionEtag(versionId);
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch && ifNoneMatch === currentEtag) {
      return new Response(null, {
        status: 304,
        headers: { etag: currentEtag },
      });
    }

    const body: ThreadsListResponse = {
      threads: await loadThreads({ placedOn: versionId }),
      asOf: new Date().toISOString(),
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        etag: currentEtag,
      },
    });
  });

  app.post('/api/versions/:versionId/threads', async (c) => {
    const versionId = c.req.param('versionId');

    const ctx = await loadDocContextForVersion(versionId);
    if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
    const user = c.get('user');
    const eff = await loadEffectiveRole({ id: ctx.docId, uploaderId: ctx.uploaderId, visibility: ctx.visibility as Visibility }, user);
    if (!canComment(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    let payload: Partial<CreateThreadRequest>;
    try {
      payload = (await c.req.json()) as Partial<CreateThreadRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }

    if (!validateAnchor(payload.anchor)) {
      return c.json(
        { error: 'invalid_anchor', message: 'Anchor must be a TextRangeAnchor or ElementPathAnchor.' },
        400
      );
    }

    const bodyValidation = validateBody(payload.body);
    if (!bodyValidation.ok) {
      return c.json(
        { error: 'invalid_body', message: `Body must be 1–${MAX_BODY} chars after trim.` },
        400
      );
    }

    // Reject posting to a non-latest version, and fetch doc/version context for notifier.
    const [latestRow] = (await db.execute(sql`
      SELECT MAX(v2.version_number)::int AS max_n,
             v.version_number::int AS this_n,
             v.id AS version_id,
             d.id AS doc_id,
             d.title AS doc_title,
             ${ownerPersonOf(sql`d.uploader_id`)} AS uploader_id
      FROM versions v
      INNER JOIN documents d ON d.id = v.document_id
      INNER JOIN versions v2 ON v2.document_id = d.id
      WHERE v.id = ${versionId}
      GROUP BY v.version_number, v.id, d.id, d.title, d.uploader_id
    `)) as unknown as {
      max_n: number | null;
      this_n: number | null;
      version_id: string;
      doc_id: string;
      doc_title: string;
      uploader_id: string;
    }[];

    if (!latestRow || latestRow.this_n === null) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (latestRow.this_n !== latestRow.max_n) {
      return c.json({ error: 'not_latest_version', message: 'Cannot post to a non-latest version.' }, 409);
    }

    // Validate mentions before touching the DB.
    const rawMentions = (payload as { mentions?: unknown }).mentions;
    let validated;
    if (rawMentions === undefined || (Array.isArray(rawMentions) && rawMentions.length === 0)) {
      validated = { ok: true as const, mentions: [] };
    } else {
      const userRows = await db.select({ id: users.id }).from(users);
      const knownUserIds = new Set(userRows.map((r) => r.id));
      validated = validateAndCleanMentions(rawMentions as string[], user.id, knownUserIds);
    }
    if (!validated.ok) {
      return c.json({ error: validated.error, message: validated.message }, 400);
    }
    const cleanedMentions = validated.mentions;

    const threadId = uuidv7();
    const commentId = uuidv7();
    const insertedAt = new Date();

    // Lock the document row (a publish holds it exclusively) and recheck: a publish that
    // committed since the check above would leave this thread placed only on the old version.
    const stale = await transactionWithEvents(async (tx, emit) => {
      await tx.execute(sql`SELECT id FROM documents WHERE id = ${latestRow.doc_id} FOR SHARE`);
      const [now] = (await tx.execute(sql`
        SELECT MAX(version_number)::int AS max_n FROM versions WHERE document_id = ${latestRow.doc_id}
      `)) as unknown as { max_n: number }[];
      if (now?.max_n !== latestRow.this_n) return true;
      await tx.insert(threads).values({
        id: threadId,
        documentId: latestRow.doc_id,
        versionId,
        anchor: payload.anchor!,
      });
      await tx.insert(threadPlacements).values({ threadId, versionId, anchor: payload.anchor! });
      await tx.insert(comments).values({
        id: commentId,
        threadId,
        authorId: user.id,
        body: bodyValidation.body,
        mentions: cleanedMentions,
      });
      emit({
        documentId: latestRow.doc_id,
        versionId,
        actorId: user.id,
        type: 'comment.created',
        payload: {
          document_id: latestRow.doc_id,
          version_id: versionId,
          thread_id: threadId,
          comment_id: commentId,
          author_id: user.id,
        },
      });
      return false;
    });
    if (stale) {
      return c.json({ error: 'not_latest_version', message: 'Cannot post to a non-latest version.' }, 409);
    }

    void deps.notifier
      .notifyComment({
        doc: { id: latestRow.doc_id, title: latestRow.doc_title },
        version: { id: latestRow.version_id, versionNumber: latestRow.this_n },
        thread: { id: threadId },
        comment: { id: commentId, body: bodyValidation.body, createdAt: insertedAt },
        mentionedUserIds: cleanedMentions,
        participantUserIds: [],
        uploaderUserId: latestRow.uploader_id,
        actorUserId: user.id,
      })
      .catch((err) => logger.error({ err, commentId }, 'notifier failed'));

    const dto = await loadThread(threadId);
    if (!dto) return c.json({ error: 'internal' }, 500);
    return c.json({ ...dto, commentId }, 201);
  });

  // Threads on live documents, their comment marks placed by the server
  // (lib/liveThreads.ts).
  app.get('/api/documents/:docId/threads', async (c) => {
    const out = await listLiveThreads(c.get('user'), c.req.param('docId'));
    if (!out.ok) return c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
    const body: ThreadsListResponse = { threads: out.value, asOf: new Date().toISOString() };
    return c.json(body, 200);
  });

  app.post('/api/documents/:docId/threads', async (c) => {
    const payload = await jsonBody(c);
    if (payload === null) return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    const out = await createLiveThread(deps.notifier, c.get('user'), c.req.param('docId'), payload);
    if (!out.ok) return c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
    return c.json(out.value, 201);
  });

  app.post('/api/threads/:threadId/reanchor', async (c) => {
    const payload = await jsonBody(c);
    if (payload === null) return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    const out = await reanchorThread(c.get('user'), c.req.param('threadId'), payload);
    if (!out.ok) return c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
    return c.json(out.value, 200);
  });

  for (const method of ['post', 'delete'] as const) {
    app[method]('/api/comments/:commentId/reactions/:emoji', async (c) => {
      const out = await setReaction(c.get('user'), c.req.param('commentId'), c.req.param('emoji'), method === 'post');
      if (!out.ok) return c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
      return c.json(out.value, 200);
    });
  }

  app.post('/api/threads/:threadId/resolve', async (c) => {
    const out = await resolveThread(c.get('user'), c.req.param('threadId'));
    if (!out.ok) return c.json({ error: out.error, refusal: out.refusal }, out.status);
    return c.json(out.thread, 200);
  });

  app.post('/api/threads/:threadId/reopen', async (c) => {
    const threadId = c.req.param('threadId');
    const user = c.get('user');
    const authz = await authorizeThreadMutation(threadId, user);
    if (!authz.ok) return c.json({ error: authz.error, refusal: authz.refusal }, authz.status);
    const { ctx } = authz;

    await transactionWithEvents(async (tx, emit) => {
      await tx
        .update(threads)
        .set({ resolvedAt: null, resolvedBy: null })
        .where(eq(threads.id, threadId));
      await placeReopened(tx, threadId);
      emit({
        documentId: ctx.docId,
        actorId: user.id,
        type: 'thread.updated',
        payload: { document_id: ctx.docId, thread_id: threadId, by: user.id },
      });
    });
    const dto = await loadThread(threadId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    return c.json(dto, 200);
  });
}

const THREAD_NOT_FOUND: Refusal = {
  code: 'not_found',
  message: 'Thread not found.',
  fix: 'Check the thread id; list threads with primer_get_comments.',
};

/**
 * Who may resolve or reopen a thread: the document owner or the thread's
 * starter (its first comment's author). An agent additionally may only when
 * no person has written in the thread (deleted comments included): a
 * person's feedback is closed by a person.
 */
async function authorizeThreadMutation(
  threadId: string,
  user: AuthUser,
): Promise<
  | { ok: true; ctx: { docId: string } }
  | { ok: false; status: 403 | 404; error: 'forbidden' | 'not_found'; refusal: Refusal }
> {
  const ctx = await loadDocContextForThread(threadId);
  const notFound = { ok: false, status: 404, error: 'not_found', refusal: THREAD_NOT_FOUND } as const;
  if (!ctx.ok) return notFound;
  const eff = await loadEffectiveRole({ id: ctx.docId, uploaderId: ctx.uploaderId, visibility: ctx.visibility }, user);
  if (!canRead(ctx.visibility, eff)) return notFound;

  const [row] = (await db.execute(sql`
    SELECT
      (SELECT c.author_id FROM comments c
        WHERE c.thread_id = ${threadId}
        ORDER BY c.created_at ASC
        LIMIT 1) AS "firstAuthorId",
      EXISTS (SELECT 1 FROM comments c
                INNER JOIN users u ON u.id = c.author_id
               WHERE c.thread_id = ${threadId} AND u.kind = 'person') AS "personWrote"
  `)) as unknown as { firstAuthorId: string | null; personWrote: boolean }[];

  if (user.kind === 'agent' && row.personWrote) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      refusal: {
        code: 'forbidden',
        message: 'A person wrote in this thread, so an agent cannot resolve or reopen it.',
        fix: 'Reply in the thread and ask a person to resolve it.',
      },
    };
  }
  if (eff === 'owner' || row.firstAuthorId === user.id) return { ok: true, ctx };
  return {
    ok: false,
    status: 403,
    error: 'forbidden',
    refusal: {
      code: 'forbidden',
      message: 'Only the document owner or the person who started the thread can resolve or reopen it.',
      fix: 'Reply in the thread instead.',
    },
  };
}

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
