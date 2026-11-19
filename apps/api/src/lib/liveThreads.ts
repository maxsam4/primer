import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  isLiveAnchor,
  isTarget,
  type LiveAnchor,
  type Refusal,
  type Target,
  type ThreadDTO,
} from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { commentReactions, comments, documents, threads, users } from '../db/schema.ts';
import { AnchorMissingError, commentMarkEdit, quoteMarkEdit, type RelativeSelection } from '../live/marks.ts';
import { originFor } from '../live/origin.ts';
import { applyPlan, type PlannedEdit } from '../live/pipeline.ts';
import { logger } from '../logger.ts';
import { validateAndCleanMentions } from '../notifications/mentions.ts';
import type { Notifier } from '../notifications/notifier.ts';
import { transactionWithEvents } from './events.ts';
import { canComment, canEdit, canRead, loadEffectiveRole, ownerPersonOf, type EffectiveRole, type Visibility } from './permissions.ts';
import { loadThread, loadThreads } from './threadList.ts';

export type LiveThreadResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409; refusal: Refusal };

const MAX_BODY = 5000;
const MAX_EMOJI = 32;

const notFound = (what = 'Document'): LiveThreadResult<never> => ({
  ok: false,
  status: 404,
  refusal: { code: 'not_found', message: `${what} not found.`, fix: 'Check the id; list documents with primer_list_documents.' },
});
const badRequest = (message: string, fix: string): LiveThreadResult<never> => ({
  ok: false,
  status: 400,
  refusal: { code: 'bad_request', message, fix },
});

export type LiveDoc = { id: string; title: string; uploaderId: string; visibility: Visibility; role: EffectiveRole };

/** A live (non-deleted) document the user can read, with their role. */
export async function readableLiveDoc(documentId: string, user: AuthUser): Promise<LiveDoc | null> {
  const [doc] = await db
    .select({
      id: documents.id,
      title: documents.title,
      uploaderId: documents.uploaderId,
      visibility: documents.visibility,
      format: documents.format,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc || doc.deletedAt !== null || doc.format === null) return null;
  const visibility = doc.visibility as Visibility;
  const role = await loadEffectiveRole({ id: doc.id, uploaderId: doc.uploaderId, visibility }, user);
  if (!canRead(visibility, role)) return null;
  return { id: doc.id, title: doc.title, uploaderId: doc.uploaderId, visibility, role };
}

/** Live threads of a document the user can read. */
export async function listLiveThreads(user: AuthUser, documentId: string): Promise<LiveThreadResult<ThreadDTO[]>> {
  const doc = await readableLiveDoc(documentId, user);
  if (!doc) return notFound();
  return { ok: true, value: await loadThreads({ liveOf: documentId }) };
}

/**
 * Starts a thread on a live document. A `prose` anchor's comment mark is
 * placed first, through the pipeline: over `selection` (the person's editor
 * sends Yjs relative positions) or else over the first occurrence of the
 * anchor's quote (the path agents use). If it can't be placed, nothing is
 * written. Other anchors are rows only.
 */
export async function createLiveThread(
  notifier: Notifier,
  user: AuthUser,
  documentId: string,
  req: { anchor?: unknown; body?: unknown; mentions?: unknown; selection?: unknown },
): Promise<LiveThreadResult<ThreadDTO & { commentId: string }>> {
  const doc = await readableLiveDoc(documentId, user);
  if (!doc || !canComment(doc.visibility, doc.role)) return notFound();
  if (!isLiveAnchor(req.anchor)) {
    return badRequest('The anchor is not a live-document anchor.', 'Send { type: "prose", target: { tabId, blockId }, quote }.');
  }
  const anchor: LiveAnchor = { ...req.anchor };
  const body = typeof req.body === 'string' ? req.body.trim() : '';
  if (body.length === 0 || body.length > MAX_BODY) {
    return badRequest(`The body must be 1–${MAX_BODY} characters.`, 'Send a shorter, non-empty comment.');
  }
  const mentions = await cleanMentions(req.mentions, user.id);
  if (!mentions.ok) return badRequest(mentions.message, 'Mention user ids from primer_lookup_user.');

  const threadId = uuidv7();
  if (anchor.type === 'prose') {
    const sel = req.selection as Partial<RelativeSelection> | undefined;
    const bySelection = typeof sel?.anchor === 'string' && typeof sel.head === 'string';
    const edit = bySelection
      ? commentMarkEdit(documentId, threadId, anchor.target, sel as RelativeSelection, (q) => (anchor.quote = q))
      : quoteMarkEdit(threadId, anchor.target, anchor.quote);
    const placed = await placeMark(documentId, user, edit);
    if (!placed.ok) return bySelection ? targetMissing(placed.message) : quoteNotFound(anchor.quote);
  }

  const commentId = uuidv7();
  await transactionWithEvents(async (tx, emit) => {
    await tx.insert(threads).values({ id: threadId, documentId, versionId: null, anchor });
    await tx.insert(comments).values({ id: commentId, threadId, authorId: user.id, body, mentions: mentions.mentions });
    emit({
      documentId,
      actorId: user.id,
      type: 'comment.created',
      payload: { document_id: documentId, version_id: null, thread_id: threadId, comment_id: commentId, author_id: user.id },
    });
  });

  const [owner] = (await db.execute(sql`
    SELECT ${ownerPersonOf(sql`d.uploader_id`)} AS id FROM documents d WHERE d.id = ${documentId}
  `)) as unknown as { id: string }[];
  void notifier
    .notifyComment({
      doc: { id: documentId, title: doc.title },
      version: null,
      thread: { id: threadId },
      comment: { id: commentId, body, createdAt: new Date() },
      mentionedUserIds: mentions.mentions,
      participantUserIds: [],
      uploaderUserId: owner?.id ?? doc.uploaderId,
      actorUserId: user.id,
    })
    .catch((err) => logger.error({ err, commentId }, 'notifier failed'));

  const dto = await loadThread(threadId);
  return { ok: true, value: { ...dto!, commentId } };
}

/**
 * Moves a live thread's comment mark (re-anchoring an orphaned thread): over a selection the
 * caller's editor sent as Yjs relative positions, or over the first
 * occurrence of a quote. The thread's anchor quote becomes the marked text
 * and its orphan flag clears. Allowed for the thread's starter, the owner
 * and editors, through the server's pipeline, so a commenter's read-only
 * connection is never written by the client.
 */
export async function reanchorThread(
  user: AuthUser,
  threadId: string,
  req: { target?: unknown; anchor?: unknown; head?: unknown; quote?: unknown },
): Promise<LiveThreadResult<ThreadDTO>> {
  const [row] = (await db.execute(sql`
    SELECT t.document_id AS "documentId", t.anchor,
           (SELECT c.author_id FROM comments c WHERE c.thread_id = t.id ORDER BY c.created_at LIMIT 1) AS "starterId"
      FROM threads t
     WHERE t.id = ${threadId} AND t.version_id IS NULL
  `)) as unknown as { documentId: string; anchor: LiveAnchor; starterId: string | null }[];
  if (!row) return notFound('Thread');
  const doc = await readableLiveDoc(row.documentId, user);
  if (!doc) return notFound('Thread');
  if (!canComment(doc.visibility, doc.role) || (row.starterId !== user.id && !canEdit(doc.role))) {
    return {
      ok: false,
      status: 403,
      refusal: {
        code: 'forbidden',
        message: 'Only the thread starter, the owner or an editor can move a comment.',
        fix: 'Reply in the thread instead.',
      },
    };
  }
  if (row.anchor.type !== 'prose') return badRequest('Only text comments have a mark.', 'Leave block and widget anchors as they are.');
  if (!isTarget(req.target)) return badRequest('The target is missing or invalid.', 'Send target: { tabId, blockId }.');
  const target: Target = req.target;

  let quote = typeof req.quote === 'string' ? req.quote : '';
  let edit: PlannedEdit;
  if (typeof req.anchor === 'string' && typeof req.head === 'string') {
    const sel: RelativeSelection = { anchor: req.anchor, head: req.head };
    edit = commentMarkEdit(row.documentId, threadId, target, sel, (q) => (quote = q));
  } else if (quote) {
    edit = quoteMarkEdit(threadId, target, quote);
  } else {
    return badRequest('Send a selection or a quote.', 'Send { target, anchor, head } or { target, quote }.');
  }

  const placed = await placeMark(row.documentId, user, edit);
  if (!placed.ok) return typeof req.anchor === 'string' ? targetMissing(placed.message) : quoteNotFound(quote);

  const anchor: LiveAnchor = { type: 'prose', target, quote };
  await transactionWithEvents(async (tx, emit) => {
    await tx.update(threads).set({ anchor, orphanedAt: null }).where(eq(threads.id, threadId));
    emit({
      documentId: row.documentId,
      actorId: user.id,
      type: 'thread.updated',
      payload: { document_id: row.documentId, thread_id: threadId, by: user.id },
    });
  });
  return { ok: true, value: (await loadThread(threadId))! };
}

/** Adds (`on`) or removes the user's `emoji` reaction on a comment. */
export async function setReaction(
  user: AuthUser,
  commentId: string,
  emoji: string,
  on: boolean,
): Promise<LiveThreadResult<ThreadDTO>> {
  if (emoji.length === 0 || emoji.length > MAX_EMOJI || /\s/.test(emoji)) {
    return badRequest('The reaction must be one emoji.', 'Send a single emoji.');
  }
  const [row] = (await db.execute(sql`
    SELECT c.thread_id AS "threadId", t.document_id AS "documentId", d.uploader_id AS "uploaderId",
           d.visibility, d.deleted_at AS "deletedAt", c.deleted_at AS "commentDeletedAt"
      FROM comments c
      JOIN threads t ON t.id = c.thread_id
      JOIN documents d ON d.id = t.document_id
     WHERE c.id = ${commentId}
  `)) as unknown as {
    threadId: string;
    documentId: string;
    uploaderId: string;
    visibility: Visibility;
    deletedAt: Date | null;
    commentDeletedAt: Date | null;
  }[];
  if (!row || row.deletedAt !== null || row.commentDeletedAt !== null) return notFound('Comment');
  const role = await loadEffectiveRole({ id: row.documentId, uploaderId: row.uploaderId, visibility: row.visibility }, user);
  if (!canComment(row.visibility, role)) return notFound('Comment');

  await transactionWithEvents(async (tx, emit) => {
    if (on) {
      await tx.insert(commentReactions).values({ commentId, userId: user.id, emoji }).onConflictDoNothing();
    } else {
      await tx
        .delete(commentReactions)
        .where(
          and(eq(commentReactions.commentId, commentId), eq(commentReactions.userId, user.id), eq(commentReactions.emoji, emoji)),
        );
    }
    emit({
      documentId: row.documentId,
      actorId: user.id,
      type: 'thread.updated',
      payload: { document_id: row.documentId, thread_id: row.threadId, by: user.id },
    });
  });
  return { ok: true, value: (await loadThread(row.threadId))! };
}

async function placeMark(
  documentId: string,
  user: AuthUser,
  edit: PlannedEdit,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await applyPlan(documentId, originFor(user), { onConflict: 'refuse', annotation: true, edits: [edit] });
    return { ok: true };
  } catch (err) {
    if (err instanceof AnchorMissingError) return { ok: false, message: err.message };
    throw err;
  }
}

function targetMissing(message: string): LiveThreadResult<never> {
  return { ok: false, status: 409, refusal: { code: 'target_missing', message, fix: 'Select the text again and retry.' } };
}

function quoteNotFound(quote: string): LiveThreadResult<never> {
  return {
    ok: false,
    status: 409,
    refusal: {
      code: 'quote_not_found',
      message: `"${quote}" was not found in the target block.`,
      fix: 'Read the block with primer_get_doc and quote its text exactly, within one paragraph.',
    },
  };
}

async function cleanMentions(
  raw: unknown,
  authorId: string,
): Promise<{ ok: true; mentions: string[] } | { ok: false; message: string }> {
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return { ok: true, mentions: [] };
  const known = new Set((await db.select({ id: users.id }).from(users)).map((r) => r.id));
  const out = validateAndCleanMentions(raw as string[], authorId, known);
  return out.ok ? { ok: true, mentions: out.mentions } : { ok: false, message: out.message };
}
