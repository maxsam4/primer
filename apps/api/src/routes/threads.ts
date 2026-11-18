import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { isTextRangeAnchor, isElementPathAnchor } from '@polygonlabs/primer-api-types';
import type { AppVariables, AppDeps } from '../app.ts';
import { logger } from '../logger.ts';
import type { CommentDTO, CreateThreadRequest, ThreadDTO, ThreadsListResponse } from '@polygonlabs/primer-api-types';
import { threads, threadPlacements, versions, comments, users } from '../db/schema.ts';
import { db } from '../db/client.ts';
import { validateAndCleanMentions } from '../notifications/mentions.ts';
import type { Visibility } from '../lib/permissions.ts';
import { effectiveRole, canRead, canComment, loadCollaboratorRole } from '../lib/permissions.ts';

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
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
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

interface ThreadRow {
  id: string;
  versionId: string;
  versionNumber: number;
  anchor: unknown;
  /** Present when listing a version: the anchor there (null = context changed). */
  placementAnchor?: unknown;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: Date;
}

interface CommentRow {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;
  mentions: string[];
  createdAt: Date;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

function commentToDTO(row: CommentRow): CommentDTO {
  const isTombstoned = row.deletedAt !== null;
  return {
    id: row.id,
    threadId: row.threadId,
    authorId: row.authorId,
    authorDisplayName: row.authorDisplayName,
    body: isTombstoned ? '' : row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    mentions: row.mentions,
  };
}

function threadToDTO(row: ThreadRow, threadComments: CommentRow[]): ThreadDTO {
  const placed = row.placementAnchor === undefined ? row.anchor : row.placementAnchor;
  return {
    id: row.id,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    anchor: (placed ?? row.anchor) as ThreadDTO['anchor'],
    contextChanged: placed === null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolvedByDisplayName: row.resolvedByDisplayName,
    createdAt: row.createdAt.toISOString(),
    comments: threadComments.map(commentToDTO),
  };
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

async function loadThreadDTO(threadId: string): Promise<ThreadDTO | null> {
  const [row] = (await db
    .select({
      id: threads.id,
      versionId: threads.versionId,
      versionNumber: versions.versionNumber,
      anchor: threads.anchor,
      resolvedAt: threads.resolvedAt,
      resolvedBy: threads.resolvedBy,
      resolvedByDisplayName: users.displayName,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .innerJoin(versions, eq(versions.id, threads.versionId))
    .leftJoin(users, eq(users.id, threads.resolvedBy))
    .where(eq(threads.id, threadId))) as ThreadRow[];
  if (!row) return null;

  const commentRows = (await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      authorId: comments.authorId,
      authorDisplayName: users.displayName,
      body: comments.body,
      mentions: comments.mentions,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(eq(comments.threadId, threadId))
    .orderBy(comments.createdAt)) as CommentRow[];

  return threadToDTO(row, commentRows);
}

export type ResolveResult =
  | { ok: true; thread: ThreadDTO }
  | { ok: false; status: 403 | 404; error: 'forbidden' | 'not_found' };

/** Resolves a thread as `user` (the document owner or the thread's starter).
 *  Shared by the REST route and the MCP resolve tool. */
export async function resolveThread(user: { id: string }, threadId: string): Promise<ResolveResult> {
  const ctx = await loadDocContextForThread(threadId);
  if (!ctx.ok) return { ok: false, status: 404, error: 'not_found' };
  const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
  const eff = effectiveRole(ctx, user.id, collabRole);
  if (!canRead(ctx.visibility, eff)) return { ok: false, status: 404, error: 'not_found' };

  const authz = await authorizeThreadMutation(threadId, user.id);
  if (authz === 'not_found') return { ok: false, status: 404, error: 'not_found' };
  if (authz === 'forbidden') return { ok: false, status: 403, error: 'forbidden' };

  await db
    .update(threads)
    .set({ resolvedAt: new Date(), resolvedBy: user.id })
    .where(eq(threads.id, threadId));
  const dto = await loadThreadDTO(threadId);
  if (!dto) return { ok: false, status: 404, error: 'not_found' };
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
    const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
    const eff = effectiveRole(ctx, user.id, collabRole);
    if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    const currentEtag = await computeVersionEtag(versionId);
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch && ifNoneMatch === currentEtag) {
      return new Response(null, {
        status: 304,
        headers: { etag: currentEtag },
      });
    }

    const threadRows = (await db
      .select({
        id: threads.id,
        versionId: threads.versionId,
        versionNumber: versions.versionNumber,
        anchor: threads.anchor,
        resolvedAt: threads.resolvedAt,
        resolvedBy: threads.resolvedBy,
        resolvedByDisplayName: users.displayName,
        createdAt: threads.createdAt,
        placementAnchor: threadPlacements.anchor,
      })
      .from(threadPlacements)
      .innerJoin(threads, eq(threads.id, threadPlacements.threadId))
      .innerJoin(versions, eq(versions.id, threads.versionId))
      .leftJoin(users, eq(users.id, threads.resolvedBy))
      .where(eq(threadPlacements.versionId, versionId))
      .orderBy(threads.createdAt)) as ThreadRow[];

    const commentRows =
      threadRows.length === 0
        ? []
        : ((await db
            .select({
              id: comments.id,
              threadId: comments.threadId,
              authorId: comments.authorId,
              authorDisplayName: users.displayName,
              body: comments.body,
              mentions: comments.mentions,
              createdAt: comments.createdAt,
              updatedAt: comments.updatedAt,
              deletedAt: comments.deletedAt,
            })
            .from(comments)
            .innerJoin(users, eq(users.id, comments.authorId))
            .where(
              sql`${comments.threadId} IN (${sql.join(
                threadRows.map((t) => sql`${t.id}`),
                sql`, `
              )})`
            )
            .orderBy(comments.createdAt)) as CommentRow[]);

    const commentsByThread = new Map<string, CommentRow[]>();
    for (const cr of commentRows) {
      const list = commentsByThread.get(cr.threadId);
      if (list) list.push(cr);
      else commentsByThread.set(cr.threadId, [cr]);
    }

    const body: ThreadsListResponse = {
      threads: threadRows.map((t) => threadToDTO(t, commentsByThread.get(t.id) ?? [])),
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
    const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
    const eff = effectiveRole(ctx, user.id, collabRole);
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
             d.uploader_id AS uploader_id
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

    await db.transaction(async (tx) => {
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
    });

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

    const dto = await loadThreadDTO(threadId);
    if (!dto) return c.json({ error: 'internal' }, 500);
    return c.json({ ...dto, commentId }, 201);
  });

  app.post('/api/threads/:threadId/resolve', async (c) => {
    const out = await resolveThread(c.get('user'), c.req.param('threadId'));
    if (!out.ok) return c.json({ error: out.error }, out.status);
    return c.json(out.thread, 200);
  });

  app.post('/api/threads/:threadId/reopen', async (c) => {
    const threadId = c.req.param('threadId');

    const ctx = await loadDocContextForThread(threadId);
    if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
    const user = c.get('user');
    const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
    const eff = effectiveRole(ctx, user.id, collabRole);
    if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    const authz = await authorizeThreadMutation(threadId, user.id);
    if (authz === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (authz === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    await db
      .update(threads)
      .set({ resolvedAt: null, resolvedBy: null })
      .where(eq(threads.id, threadId));
    const dto = await loadThreadDTO(threadId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    return c.json(dto, 200);
  });
}

/**
 * Resolve/reopen are permitted for either the document uploader or the
 * thread's first-comment author (the thread starter).
 */
async function authorizeThreadMutation(
  threadId: string,
  userId: string
): Promise<'ok' | 'not_found' | 'forbidden'> {
  const [row] = (await db.execute(sql`
    SELECT d.uploader_id AS "uploaderId",
           (
             SELECT c.author_id FROM comments c
             WHERE c.thread_id = t.id
             ORDER BY c.created_at ASC
             LIMIT 1
           ) AS "firstAuthorId"
    FROM threads t
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE t.id = ${threadId}
    LIMIT 1
  `)) as unknown as { uploaderId: string; firstAuthorId: string | null }[];

  if (!row) return 'not_found';
  if (row.uploaderId === userId) return 'ok';
  if (row.firstAuthorId !== null && row.firstAuthorId === userId) return 'ok';
  return 'forbidden';
}
