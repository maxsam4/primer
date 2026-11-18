import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import type { Notifier } from '../notifications/notifier.ts';
import { logger } from '../logger.ts';
import type { CommentBodyRequest, CommentDTO, ThreadDTO } from '@polygonlabs/primer-api-types';
import { COMMENT_UNDO_WINDOW_MS } from '@polygonlabs/primer-api-types';
import { threads, versions, comments, users } from '../db/schema.ts';
import { db } from '../db/client.ts';
import { validateAndCleanMentions } from '../notifications/mentions.ts';
import {
  type Visibility,
  effectiveRole,
  canRead,
  canComment,
  loadCollaboratorRole,
} from '../lib/permissions.ts';

async function loadDocContextForThread(
  threadId: string,
): Promise<
  | { ok: false }
  | { ok: true; docId: string; uploaderId: string; visibility: Visibility }
> {
  const [r] = (await db.execute(sql`
    SELECT d.id AS "docId", d.uploader_id AS "uploaderId",
           d.visibility AS "visibility", d.deleted_at AS "deletedAt"
    FROM threads t
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE t.id = ${threadId}
    LIMIT 1
  `)) as unknown as {
    docId: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null;
  }[];
  if (!r || r.deletedAt !== null) return { ok: false };
  return { ok: true, docId: r.docId, uploaderId: r.uploaderId, visibility: r.visibility };
}

async function loadDocContextForComment(
  commentId: string,
): Promise<
  | { ok: false }
  | { ok: true; docId: string; uploaderId: string; visibility: Visibility }
> {
  const [r] = (await db.execute(sql`
    SELECT d.id AS "docId", d.uploader_id AS "uploaderId",
           d.visibility AS "visibility", d.deleted_at AS "deletedAt"
    FROM comments c
    INNER JOIN threads t ON t.id = c.thread_id
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE c.id = ${commentId}
    LIMIT 1
  `)) as unknown as {
    docId: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null;
  }[];
  if (!r || r.deletedAt !== null) return { ok: false };
  return { ok: true, docId: r.docId, uploaderId: r.uploaderId, visibility: r.visibility };
}

const MAX_BODY = 5000;

function validateBody(raw: unknown): { ok: true; body: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BODY) return { ok: false };
  return { ok: true, body: trimmed };
}

interface ThreadRow {
  id: string;
  versionId: string;
  versionNumber: number;
  anchor: unknown;
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

/** Re-read one comment as a DTO. Used by the routes that mutate a single
 *  comment (edit / delete / restore) to return the row's settled state. */
async function loadCommentDTO(commentId: string): Promise<CommentDTO | null> {
  const [row] = (await db
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
    .where(eq(comments.id, commentId))) as CommentRow[];
  return row ? commentToDTO(row) : null;
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

  return {
    id: row.id,
    versionId: row.versionId,
    versionNumber: row.versionNumber,
    anchor: row.anchor as ThreadDTO['anchor'],
    contextChanged: false,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolvedByDisplayName: row.resolvedByDisplayName,
    createdAt: row.createdAt.toISOString(),
    comments: commentRows.map(commentToDTO),
  };
}

export type ReplyResult =
  | { ok: true; comment: CommentDTO; thread: ThreadDTO }
  | { ok: false; status: 400 | 404; error: string; message?: string };

/** Posts a reply to a thread as `user` (reopening it if resolved) and notifies
 *  participants. Shared by the REST route and the MCP reply tool. */
export async function replyToThread(
  notifier: Notifier,
  user: { id: string },
  threadId: string,
  payload: { body?: unknown; mentions?: unknown },
): Promise<ReplyResult> {
  const ctx = await loadDocContextForThread(threadId);
  if (!ctx.ok) return { ok: false, status: 404, error: 'not_found' };
  const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
  const eff = effectiveRole(ctx, user.id, collabRole);
  if (!canComment(ctx.visibility, eff)) return { ok: false, status: 404, error: 'not_found' };

  const validation = validateBody(payload.body);
  if (!validation.ok) {
    return { ok: false, status: 400, error: 'invalid_body', message: `Body must be 1–${MAX_BODY} chars after trim.` };
  }

  // Load thread context (existence check + doc/version info for notifier).
  const [threadCtx] = (await db.execute(sql`
    SELECT d.id AS doc_id, d.title AS doc_title,
           d.uploader_id AS uploader_id,
           v.id AS version_id, v.version_number::int AS version_number
    FROM threads t
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE t.id = ${threadId}
    LIMIT 1
  `)) as unknown as Array<{
    doc_id: string;
    doc_title: string;
    uploader_id: string;
    version_id: string;
    version_number: number;
  }>;
  if (!threadCtx) {
    return { ok: false, status: 404, error: 'not_found', message: 'thread not found' };
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
    return { ok: false, status: 400, error: validated.error, message: validated.message };
  }
  const cleanedMentions = validated.mentions;

  const commentId = uuidv7();
  const insertedAt = new Date();

  // Prior thread participants (only non-deleted comments).
  const priorRows = (await db.execute(sql`
    SELECT DISTINCT author_id AS author_id
    FROM comments
    WHERE thread_id = ${threadId}
      AND deleted_at IS NULL
  `)) as unknown as Array<{ author_id: string }>;

  const mentionSet = new Set(cleanedMentions);
  const participantUserIds = priorRows
    .map((r) => r.author_id)
    .filter((id) => id !== user.id && !mentionSet.has(id));

  await db.transaction(async (tx) => {
    await tx.insert(comments).values({
      id: commentId,
      threadId,
      authorId: user.id,
      body: validation.body,
      mentions: cleanedMentions,
    });
    // Auto-reopen if resolved (no-op when not resolved).
    await tx
      .update(threads)
      .set({ resolvedAt: null, resolvedBy: null })
      .where(eq(threads.id, threadId));
  });

  void notifier
    .notifyComment({
      doc: { id: threadCtx.doc_id, title: threadCtx.doc_title },
      version: { id: threadCtx.version_id, versionNumber: threadCtx.version_number },
      thread: { id: threadId },
      comment: { id: commentId, body: validation.body, createdAt: insertedAt },
      mentionedUserIds: cleanedMentions,
      participantUserIds,
      uploaderUserId: threadCtx.uploader_id,
      actorUserId: user.id,
    })
    .catch((err) => logger.error({ err, commentId }, 'notifier failed'));

  const dto = await loadThreadDTO(threadId);
  if (!dto) return { ok: false, status: 404, error: 'not_found' };
  const newComment = dto.comments.find((cm) => cm.id === commentId)!;
  return { ok: true, comment: newComment, thread: dto };
}

export function registerCommentRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.post('/api/threads/:threadId/comments', async (c) => {
    let payload: Partial<CommentBodyRequest>;
    try {
      payload = (await c.req.json()) as Partial<CommentBodyRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    const out = await replyToThread(deps.notifier, c.get('user'), c.req.param('threadId'), payload);
    if (!out.ok) return c.json({ error: out.error, message: out.message }, out.status);
    return c.json({ comment: out.comment, thread: out.thread }, 201);
  });

  app.patch('/api/comments/:commentId', async (c) => {
    const commentId = c.req.param('commentId');

    const ctx = await loadDocContextForComment(commentId);
    if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
    const user = c.get('user');
    const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
    const eff = effectiveRole(ctx, user.id, collabRole);
    if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    let payload: Partial<CommentBodyRequest>;
    try {
      payload = (await c.req.json()) as Partial<CommentBodyRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    const validation = validateBody(payload.body);
    if (!validation.ok) {
      return c.json({ error: 'invalid_body', message: `Body must be 1–${MAX_BODY} chars after trim.` }, 400);
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

    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.authorId !== user.id) return c.json({ error: 'forbidden' }, 403);
    if (existing.deletedAt !== null) return c.json({ error: 'conflict' }, 409);

    // Diff mentions: only newly-added ones trigger a notification.
    const previous = new Set(existing.mentions);
    const newlyAdded = cleanedMentions.filter((id) => !previous.has(id));

    const updatedAt = new Date();
    await db
      .update(comments)
      .set({ body: validation.body, mentions: cleanedMentions, updatedAt })
      .where(eq(comments.id, commentId));

    if (newlyAdded.length > 0) {
      const [editCtx] = (await db.execute(sql`
        SELECT d.id AS doc_id, d.title AS doc_title,
               v.id AS version_id, v.version_number::int AS version_number
        FROM threads t
        INNER JOIN versions v ON v.id = t.version_id
        INNER JOIN documents d ON d.id = v.document_id
        WHERE t.id = ${existing.threadId}
        LIMIT 1
      `)) as unknown as Array<{
        doc_id: string;
        doc_title: string;
        version_id: string;
        version_number: number;
      }>;

      if (editCtx) {
        void deps.notifier
          .notifyComment({
            doc: { id: editCtx.doc_id, title: editCtx.doc_title },
            version: { id: editCtx.version_id, versionNumber: editCtx.version_number },
            thread: { id: existing.threadId },
            comment: { id: commentId, body: validation.body, createdAt: existing.createdAt },
            mentionedUserIds: newlyAdded,
            participantUserIds: [],   // edits never re-notify participants
            uploaderUserId: null,
            actorUserId: user.id,
          })
          .catch((err) => logger.error({ err, commentId }, 'notifier failed (edit)'));
      }
    }

    const dto = await loadCommentDTO(commentId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    return c.json(dto, 200);
  });

  app.delete('/api/comments/:commentId', async (c) => {
    const commentId = c.req.param('commentId');

    const ctx = await loadDocContextForComment(commentId);
    if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
    const user = c.get('user');
    const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
    const eff = effectiveRole(ctx, user.id, collabRole);
    if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);
    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.authorId !== user.id) return c.json({ error: 'forbidden' }, 403);
    if (existing.deletedAt === null) {
      await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
    }
    const dto = await loadCommentDTO(commentId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    return c.json(dto, 200);
  });

  /**
   * Undo a delete. Authorized exactly like DELETE — the comment's own author,
   * and only while the doc is readable to them — but additionally time-boxed:
   * past COMMENT_UNDO_WINDOW_MS the tombstone is permanent, so a comment can't
   * be resurrected into a conversation that has long since moved on.
   *
   * Deliberately idempotent for a comment that is already live, so a
   * double-tapped Undo is not an error.
   */
  app.post('/api/comments/:commentId/restore', async (c) => {
    const commentId = c.req.param('commentId');

    const ctx = await loadDocContextForComment(commentId);
    if (!ctx.ok) return c.json({ error: 'not_found' }, 404);
    const user = c.get('user');
    const collabRole = await loadCollaboratorRole(ctx.docId, user.id);
    const eff = effectiveRole(ctx, user.id, collabRole);
    if (!canRead(ctx.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.authorId !== user.id) return c.json({ error: 'forbidden' }, 403);

    if (existing.deletedAt !== null) {
      const elapsedMs = Date.now() - existing.deletedAt.getTime();
      if (elapsedMs > COMMENT_UNDO_WINDOW_MS) {
        return c.json(
          {
            error: 'restore_window_expired',
            message: `A deleted comment can only be restored within ${Math.round(
              COMMENT_UNDO_WINDOW_MS / 60_000,
            )} minutes of deletion.`,
          },
          409,
        );
      }
      await db.update(comments).set({ deletedAt: null }).where(eq(comments.id, commentId));
      logger.info({ commentId, userId: user.id }, 'comment delete undone');
    }

    const dto = await loadCommentDTO(commentId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    return c.json(dto, 200);
  });
}
