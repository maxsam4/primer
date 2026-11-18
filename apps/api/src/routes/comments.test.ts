import { describe, it, expect } from 'vitest';
import { insertThread } from '../testing/threads.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, users, documentCollaborators } from '../db/schema.ts';
import type { CommentDTO, ThreadDTO } from '@polygonlabs/primer-api-types';
import { COMMENT_UNDO_WINDOW_MS } from '@polygonlabs/primer-api-types';
import { CSRF_HEADERS, asUserJson } from '../test/harness.ts';
import { mockMultiResolver } from '../auth/resolver.ts';

async function seedDocVersionThread({
  authorId = 'mock-user-1',
  uploaderId = 'mock-user-1',
  mentions = [],
}: { authorId?: string; uploaderId?: string; mentions?: string[] } = {}) {
  const documentId = uuidv7();
  const versionId = uuidv7();
  const threadId = uuidv7();
  const commentId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Seed',
    description: null,
    uploaderId,
  });
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: null,
  });
  await insertThread({
    id: threadId,
    versionId,
    anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
  });
  await db.insert(comments).values({
    id: commentId,
    threadId,
    authorId,
    body: 'first',
    mentions,
  });
  return { documentId, versionId, threadId, commentId };
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-comments-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('POST /api/threads/:tid/comments — reply', () => {
  it('appends a comment to an existing thread', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'a reply' }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { comment: CommentDTO; thread: ThreadDTO };
      expect(out.comment.body).toBe('a reply');
      expect(out.thread.comments).toHaveLength(2);
      expect(out.thread.resolvedAt).toBeNull();
    });
  });

  it('auto-reopens a resolved thread on reply', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      await db
        .update(threads)
        .set({ resolvedAt: new Date(), resolvedBy: 'mock-user-1' })
        .where(eq(threads.id, threadId));

      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'I have more thoughts' }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { comment: CommentDTO; thread: ThreadDTO };
      expect(out.thread.resolvedAt).toBeNull();
      expect(out.thread.resolvedBy).toBeNull();
      expect(out.thread.comments).toHaveLength(2);
    });
  });

  it('rejects empty body', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: '  ' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });
  });

  it('returns 404 for an unknown threadId', async () => {
    await withApp(async (app) => {
      const fakeId = uuidv7();
      const res = await app.request(`/api/threads/${fakeId}/comments`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'orphan reply' }),
      });
      expect(res.status).toBe(404);
    });
  });
});

describe('POST /api/threads/:tid/comments — mentions', () => {
  it('persists mentions[] on a reply and fires notifyComment with mention+participant sets', async () => {
    await db
      .insert(users)
      .values([
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'Three' },
      ])
      .onConflictDoNothing();
    // Seed a thread with a first comment authored by mock-user-2.
    const { threadId } = await seedDocVersionThread({ authorId: 'mock-user-2' });

    const captured: { mentionedUserIds: string[]; participantUserIds: string[]; actorUserId: string }[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-reply-spy-'))),
      notifier: {
        async notifyComment(args: unknown) {
          captured.push(args as never);
        },
      } as never,
    });

    const res = await spyApp.request(`/api/threads/${threadId}/comments`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Three look here', mentions: ['mock-user-3'] }),
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { comment: CommentDTO; thread: ThreadDTO };
    const [row] = await db.select().from(comments).where(eq(comments.id, out.comment.id));
    expect(row.mentions).toEqual(['mock-user-3']);

    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0].mentionedUserIds).toEqual(['mock-user-3']);
    // mock-user-2 is the prior participant (first comment author); mock-user-1 is the actor.
    expect(captured[0].participantUserIds).toEqual(['mock-user-2']);
    expect(captured[0].actorUserId).toBe('mock-user-1');
  });

  it('returns 400 invalid_mention when an unknown user id is in mentions', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread({ authorId: 'mock-user-1' });
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'hi', mentions: ['ghost'] }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_mention');
    });
  });

  it('forwards the document uploader id to notifyComment on a reply', async () => {
    await db
      .insert(users)
      .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
      .onConflictDoNothing();
    // Uploader is user-2; the first comment author is also user-2 so user-1's reply is the only new event.
    const { threadId } = await seedDocVersionThread({ uploaderId: 'mock-user-2', authorId: 'mock-user-2' });

    const captured: { uploaderUserId: string | null; actorUserId: string }[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-reply-uploader-spy-'))),
      notifier: {
        async notifyComment(args: unknown) {
          captured.push(args as never);
        },
      } as never,
    });

    const res = await spyApp.request(`/api/threads/${threadId}/comments`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'plain reply, no mentions' }),
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0].uploaderUserId).toBe('mock-user-2');
    expect(captured[0].actorUserId).toBe('mock-user-1');
  });
});

describe('PATCH /api/comments/:cid', () => {
  it('updates body and sets updatedAt when called by author', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;

      const res = await app.request(`/api/comments/${firstCommentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'edited body' }),
      });
      expect(res.status).toBe(200);
      const cm = (await res.json()) as CommentDTO;
      expect(cm.body).toBe('edited body');
      expect(cm.updatedAt).not.toBeNull();
    });
  });

  it('returns 403 when called by non-author', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const otherUserId = 'other-user-test';
      await db.insert(users).values({ id: otherUserId, email: 'o@p.t', displayName: 'Other' }).onConflictDoNothing();
      const otherCommentId = uuidv7();
      await db.insert(comments).values({
        id: otherCommentId,
        threadId,
        authorId: otherUserId,
        body: 'theirs',
        mentions: [],
      });

      const res = await app.request(`/api/comments/${otherCommentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'sneaky edit' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('returns 409 when patching a tombstoned comment', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;
      await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, firstCommentId));

      const res = await app.request(`/api/comments/${firstCommentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'too late' }),
      });
      expect(res.status).toBe(409);
    });
  });

  it('persists the new mentions[] and fires notifyComment for newly-added mentions only', async () => {
    await db
      .insert(users)
      .values([
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'Three' },
      ])
      .onConflictDoNothing();
    const { commentId } = await seedDocVersionThread({
      authorId: 'mock-user-1',
      mentions: ['mock-user-2'],
    });

    const captured: { mentionedUserIds: string[]; participantUserIds: string[] }[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-edit-spy-'))),
      notifier: {
        async notifyComment(args: unknown) {
          captured.push(args as never);
        },
      } as never,
    });

    // Edit: keep mock-user-2, add mock-user-3.
    const res = await spyApp.request(`/api/comments/${commentId}`, {
      method: 'PATCH',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Two @Three', mentions: ['mock-user-2', 'mock-user-3'] }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(comments).where(eq(comments.id, commentId));
    expect(row.mentions.sort()).toEqual(['mock-user-2', 'mock-user-3']);

    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0].mentionedUserIds).toEqual(['mock-user-3']); // diff only
    expect(captured[0].participantUserIds).toEqual([]);            // edits never re-notify participants
  });

  it('passes uploaderUserId: null to notifyComment on edit (edits never notify the uploader)', async () => {
    await db
      .insert(users)
      .values([
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'Three' },
      ])
      .onConflictDoNothing();
    // Uploader is user-2; the comment author (editor) is user-1.
    const { commentId } = await seedDocVersionThread({ uploaderId: 'mock-user-2', authorId: 'mock-user-1' });

    const captured: { uploaderUserId: string | null }[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-edit-uploader-spy-'))),
      notifier: {
        async notifyComment(args: unknown) {
          captured.push(args as never);
        },
      } as never,
    });

    // An edit that adds a new mention so notifyComment actually fires.
    const res = await spyApp.request(`/api/comments/${commentId}`, {
      method: 'PATCH',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '@Three look', mentions: ['mock-user-3'] }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0].uploaderUserId).toBeNull();
  });

  it('does not fire notifyComment on edits that only remove mentions', async () => {
    await db
      .insert(users)
      .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
      .onConflictDoNothing();
    const { commentId } = await seedDocVersionThread({
      authorId: 'mock-user-1',
      mentions: ['mock-user-2'],
    });

    const captured: unknown[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-edit-rm-'))),
      notifier: {
        async notifyComment(args: unknown) {
          captured.push(args);
        },
      } as never,
    });

    const res = await spyApp.request(`/api/comments/${commentId}`, {
      method: 'PATCH',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'no longer tagging anyone', mentions: [] }),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(0);
  });
});

describe('comment endpoints respect soft-delete', () => {
  it('POST /api/threads/:tid/comments returns 404 on soft-deleted doc', async () => {
    await withApp(async (app) => {
      const { documentId, threadId } = await seedDocVersionThread();
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'attempted reply' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('PATCH /api/comments/:cid returns 404 on soft-deleted doc', async () => {
    await withApp(async (app) => {
      const { documentId, threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));
      const res = await app.request(`/api/comments/${firstCommentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'edit attempt' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('DELETE /api/comments/:cid returns 404 on soft-deleted doc', async () => {
    await withApp(async (app) => {
      const { documentId, threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));
      const res = await app.request(`/api/comments/${firstCommentId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      expect(res.status).toBe(404);
    });
  });
});

async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-comments-multi-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    await db.insert(users).values([
      { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
      { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
    ]).onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function uploadFixture(app: ReturnType<typeof createApp>) {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><p>x</p></body></html>'], { type: 'text/html' }), 'r.html');
  fd.append('title', 'Fixture');
  const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  return (await res.json()) as { documentId: string; versionId: string };
}

describe('DELETE /api/comments/:cid', () => {
  it('soft-deletes by author and returns tombstone', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;
      const res = await app.request(`/api/comments/${firstCommentId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      expect(res.status).toBe(200);
      const cm = (await res.json()) as CommentDTO;
      expect(cm.body).toBe('');
      expect(cm.deletedAt).not.toBeNull();

      const stillThere = await db.select().from(comments).where(eq(comments.id, firstCommentId));
      expect(stillThere).toHaveLength(1);
      expect(stillThere[0].body).toBe('first');
    });
  });

  it('returns 403 when called by non-author', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const otherUserId = 'other-user-test-2';
      await db.insert(users).values({ id: otherUserId, email: 'o2@p.t', displayName: 'Other2' }).onConflictDoNothing();
      const otherCommentId = uuidv7();
      await db.insert(comments).values({
        id: otherCommentId,
        threadId,
        authorId: otherUserId,
        body: 'theirs',
        mentions: [],
      });
      const res = await app.request(`/api/comments/${otherCommentId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      expect(res.status).toBe(403);
    });
  });

  it('is idempotent on already-tombstoned comment', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;
      await app.request(`/api/comments/${firstCommentId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      const res = await app.request(`/api/comments/${firstCommentId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      expect(res.status).toBe(200);
      expect(((await res.json()) as CommentDTO).deletedAt).not.toBeNull();
    });
  });
});

describe('comment routes under visibility + collab', () => {
  it('POST reply on private doc as stranger returns 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      // owner creates a thread
      const createRes = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'seed',
        }),
      });
      const { id: threadId } = (await createRes.json()) as { id: string };
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ body: 'sneak' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('POST reply on private doc as commenter collab returns 201', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      const createRes = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'seed',
        }),
      });
      const { id: threadId } = (await createRes.json()) as { id: string };
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ body: 'hey' }),
      });
      expect(res.status).toBe(201);
    });
  });
});

describe('POST /api/comments/:cid/restore', () => {
  /** Soft-delete `commentId` and backdate the tombstone by `agoMs`. */
  async function tombstone(commentId: string, agoMs = 0) {
    await db
      .update(comments)
      .set({ deletedAt: new Date(Date.now() - agoMs) })
      .where(eq(comments.id, commentId));
  }

  it('restores an in-window tombstone by its author, body and all', async () => {
    await withApp(async (app) => {
      const { commentId } = await seedDocVersionThread();
      await tombstone(commentId, 60_000);

      const res = await app.request(`/api/comments/${commentId}/restore`, {
        method: 'POST',
        headers: CSRF_HEADERS,
      });
      expect(res.status).toBe(200);
      const cm = (await res.json()) as CommentDTO;
      expect(cm.deletedAt).toBeNull();
      expect(cm.body).toBe('first');

      const row = await db.select().from(comments).where(eq(comments.id, commentId));
      expect(row[0].deletedAt).toBeNull();
    });
  });

  it('is idempotent on a comment that was never deleted', async () => {
    await withApp(async (app) => {
      const { commentId } = await seedDocVersionThread();
      const res = await app.request(`/api/comments/${commentId}/restore`, {
        method: 'POST',
        headers: CSRF_HEADERS,
      });
      expect(res.status).toBe(200);
      const cm = (await res.json()) as CommentDTO;
      expect(cm.deletedAt).toBeNull();
      expect(cm.body).toBe('first');
    });
  });

  it('refuses once the undo window has elapsed, leaving the tombstone intact', async () => {
    await withApp(async (app) => {
      const { commentId } = await seedDocVersionThread();
      await tombstone(commentId, COMMENT_UNDO_WINDOW_MS + 60_000);

      const res = await app.request(`/api/comments/${commentId}/restore`, {
        method: 'POST',
        headers: CSRF_HEADERS,
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('restore_window_expired');

      const row = await db.select().from(comments).where(eq(comments.id, commentId));
      expect(row[0].deletedAt).not.toBeNull();
    });
  });

  it('returns 403 when someone other than the author tries to restore', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const otherUserId = 'other-user-restore';
      await db
        .insert(users)
        .values({ id: otherUserId, email: 'or@p.t', displayName: 'OtherRestore' })
        .onConflictDoNothing();
      const otherCommentId = uuidv7();
      await db.insert(comments).values({
        id: otherCommentId,
        threadId,
        authorId: otherUserId,
        body: 'theirs',
        mentions: [],
      });
      await tombstone(otherCommentId, 60_000);

      const res = await app.request(`/api/comments/${otherCommentId}/restore`, {
        method: 'POST',
        headers: CSRF_HEADERS,
      });
      expect(res.status).toBe(403);

      const row = await db.select().from(comments).where(eq(comments.id, otherCommentId));
      expect(row[0].deletedAt).not.toBeNull();
    });
  });

  it('returns 404 for an unknown comment', async () => {
    await withApp(async (app) => {
      const res = await app.request(`/api/comments/${uuidv7()}/restore`, {
        method: 'POST',
        headers: CSRF_HEADERS,
      });
      expect(res.status).toBe(404);
    });
  });

  it('returns 404 when the document has been soft-deleted', async () => {
    await withApp(async (app) => {
      const { documentId, commentId } = await seedDocVersionThread();
      await tombstone(commentId, 60_000);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));

      const res = await app.request(`/api/comments/${commentId}/restore`, {
        method: 'POST',
        headers: CSRF_HEADERS,
      });
      expect(res.status).toBe(404);
    });
  });

  it('puts the comment back in the version thread listing', async () => {
    await withApp(async (app) => {
      const { versionId, commentId } = await seedDocVersionThread();
      await tombstone(commentId, 60_000);

      await app.request(`/api/comments/${commentId}/restore`, {
        method: 'POST',
        headers: CSRF_HEADERS,
      });

      const listed = await app.request(`/api/versions/${versionId}/threads`);
      const body = (await listed.json()) as { threads: ThreadDTO[] };
      const restored = body.threads[0].comments.find((c) => c.id === commentId);
      expect(restored?.deletedAt).toBeNull();
      expect(restored?.body).toBe('first');
    });
  });
});
