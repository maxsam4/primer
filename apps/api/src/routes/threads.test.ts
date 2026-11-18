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
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, users, documentCollaborators } from '../db/schema.ts';
import type { ThreadsListResponse } from '@polygonlabs/primer-api-types';
import type { ThreadDTO, CreateThreadRequest } from '@polygonlabs/primer-api-types';
import { CSRF_HEADERS, asUser, asUserJson } from '../test/harness.ts';

async function seedDocument({ uploaderId = 'mock-user-1' }: { uploaderId?: string } = {}) {
  const documentId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Seed Doc',
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
  return { documentId, versionId };
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-threads-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /api/versions/:versionId/threads — happy path', () => {
  it('returns empty list with 200 when no threads exist', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ThreadsListResponse;
      expect(body.threads).toEqual([]);
      expect(typeof body.asOf).toBe('string');
      expect(res.headers.get('etag')).toBeTruthy();
    });
  });

  it('returns existing threads + comments inlined', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const threadId = uuidv7();
      const commentId = uuidv7();
      await insertThread({
        id: threadId,
        versionId,
        anchor: { type: 'text-range', selectorText: 't', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({
        id: commentId,
        threadId,
        authorId: 'mock-user-1',
        body: 'first comment',
        mentions: [],
      });

      const res = await app.request(`/api/versions/${versionId}/threads`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ThreadsListResponse;
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0].id).toBe(threadId);
      expect(body.threads[0].comments).toHaveLength(1);
      expect(body.threads[0].comments[0].body).toBe('first comment');
      expect(body.threads[0].comments[0].authorDisplayName).toBe('Mock User');
    });
  });
});

describe('GET /api/versions/:versionId/threads — ETag/304', () => {
  it('returns 304 when If-None-Match matches the current ETag', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const r1 = await app.request(`/api/versions/${versionId}/threads`);
      expect(r1.status).toBe(200);
      const etag = r1.headers.get('etag');
      expect(etag).toBeTruthy();

      const r2 = await app.request(`/api/versions/${versionId}/threads`, {
        headers: { 'if-none-match': etag! },
      });
      expect(r2.status).toBe(304);
      expect(r2.headers.get('etag')).toBe(etag);
    });
  });

  it('returns a fresh ETag and 200 after any thread/comment change', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const r1 = await app.request(`/api/versions/${versionId}/threads`);
      const etag1 = r1.headers.get('etag');

      const threadId = uuidv7();
      await insertThread({
        id: threadId,
        versionId,
        anchor: { type: 'text-range', selectorText: 't', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({
        id: uuidv7(),
        threadId,
        authorId: 'mock-user-1',
        body: 'fresh',
        mentions: [],
      });

      const r2 = await app.request(`/api/versions/${versionId}/threads`, {
        headers: { 'if-none-match': etag1! },
      });
      expect(r2.status).toBe(200);
      const etag2 = r2.headers.get('etag');
      expect(etag2).toBeTruthy();
      expect(etag2).not.toBe(etag1);
    });
  });
});

describe('POST /api/versions/:versionId/threads', () => {
  it('creates a thread + first comment in one transaction', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const body: CreateThreadRequest = {
        anchor: {
          type: 'text-range',
          selectorText: 'churn jumped',
          prefix: 'see how ',
          suffix: ' last week',
          containerPath: 'body > p:nth-of-type(2)',
        },
        body: 'is this the same metric as before?',
      };
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      const thread = (await res.json()) as ThreadDTO;
      expect(thread.id).toBeTruthy();
      expect(thread.versionId).toBe(versionId);
      expect(thread.anchor).toEqual(body.anchor);
      expect(thread.comments).toHaveLength(1);
      expect(thread.comments[0].body).toBe(body.body);
      expect(thread.comments[0].authorId).toBe('mock-user-1');
      expect(thread.comments[0].mentions).toEqual([]);

      const threadRows = await db.select().from(threads).where(eq(threads.id, thread.id));
      expect(threadRows).toHaveLength(1);
      const commentRows = await db.select().from(comments).where(eq(comments.threadId, thread.id));
      expect(commentRows).toHaveLength(1);
    });
  });

  it('rejects invalid_body for empty body', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 't', prefix: '', suffix: '', containerPath: 'body' },
          body: '   ',
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_body');
    });
  });

  it('rejects invalid_body for body over 5000 chars', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 't', prefix: '', suffix: '', containerPath: 'body' },
          body: 'x'.repeat(5001),
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });
  });

  it('rejects invalid_anchor for malformed anchor', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x' /* missing fields */ },
          body: 'hi',
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_anchor');
    });
  });
});

async function seedThread(versionId: string) {
  const threadId = uuidv7();
  await insertThread({
    id: threadId,
    versionId,
    anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
  });
  await db.insert(comments).values({
    id: uuidv7(),
    threadId,
    authorId: 'mock-user-1',
    body: 'seed',
    mentions: [],
  });
  return threadId;
}

describe('POST /api/threads/:tid/resolve', () => {
  it('sets resolvedAt + resolvedBy and is idempotent', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const threadId = await seedThread(versionId);
      const r1 = await app.request(`/api/threads/${threadId}/resolve`, { method: 'POST', headers: CSRF_HEADERS });
      expect(r1.status).toBe(200);
      const t1 = (await r1.json()) as ThreadDTO;
      expect(t1.resolvedAt).not.toBeNull();
      expect(t1.resolvedBy).toBe('mock-user-1');
      expect(t1.resolvedByDisplayName).toBe('Mock User');

      const r2 = await app.request(`/api/threads/${threadId}/resolve`, { method: 'POST', headers: CSRF_HEADERS });
      expect(r2.status).toBe(200);
      const t2 = (await r2.json()) as ThreadDTO;
      expect(t2.resolvedAt).not.toBeNull();
    });
  });
});

describe('POST /api/threads/:tid/reopen', () => {
  it('clears resolvedAt + resolvedBy and is idempotent', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const threadId = await seedThread(versionId);
      await app.request(`/api/threads/${threadId}/resolve`, { method: 'POST', headers: CSRF_HEADERS });

      const r1 = await app.request(`/api/threads/${threadId}/reopen`, { method: 'POST', headers: CSRF_HEADERS });
      expect(r1.status).toBe(200);
      const t1 = (await r1.json()) as ThreadDTO;
      expect(t1.resolvedAt).toBeNull();
      expect(t1.resolvedBy).toBeNull();

      const r2 = await app.request(`/api/threads/${threadId}/reopen`, { method: 'POST', headers: CSRF_HEADERS });
      expect(r2.status).toBe(200);
      expect(((await r2.json()) as ThreadDTO).resolvedAt).toBeNull();
    });
  });
});

describe('POST /api/versions/:vid/threads — non-latest guard', () => {
  it('returns 409 not_latest_version when posting to a non-latest version', async () => {
    await withApp(async (app) => {
      const { documentId, versionId: v1Id } = await seedDocument();

      // Insert a second version so v1 becomes non-latest.
      const v2Id = uuidv7();
      await db.insert(versions).values({
        id: v2Id,
        documentId,
        versionNumber: 2,
        storageKey: `v1/${v2Id}.html`,
        sizeBytes: 0,
        versionNote: null,
      });

      const res = await app.request(`/api/versions/${v1Id}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'late comment',
        }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('not_latest_version');
    });
  });
});

describe('threads endpoints respect soft-delete', () => {
  it('GET /api/versions/:vid/threads returns 404 on soft-deleted doc', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await seedDocument();
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));
      const res = await app.request(`/api/versions/${versionId}/threads`);
      expect(res.status).toBe(404);
    });
  });

  it('POST /api/versions/:vid/threads returns 404 on soft-deleted doc', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await seedDocument();
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'attempt',
        }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('POST /api/threads/:tid/resolve returns 404 on soft-deleted doc', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await seedDocument();
      const threadId = await seedThread(versionId);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));
      const res = await app.request(`/api/threads/${threadId}/resolve`, { method: 'POST', headers: CSRF_HEADERS });
      expect(res.status).toBe(404);
    });
  });

  it('POST /api/threads/:tid/reopen returns 404 on soft-deleted doc', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await seedDocument();
      const threadId = await seedThread(versionId);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));
      const res = await app.request(`/api/threads/${threadId}/reopen`, { method: 'POST', headers: CSRF_HEADERS });
      expect(res.status).toBe(404);
    });
  });
});

describe('POST /api/versions/:vid/threads — mentions', () => {
  it('persists cleaned mentions[] on the first comment', async () => {
    await withApp(async (app) => {
      // Seed a second user that can be mentioned.
      await db
        .insert(users)
        .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
        .onConflictDoNothing();
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: '@Two please look',
          mentions: ['mock-user-2'],
        }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { commentId: string };
      const [row] = await db.select().from(comments).where(eq(comments.id, out.commentId));
      expect(row.mentions).toEqual(['mock-user-2']);
    });
  });

  it('returns 400 invalid_mention when an unknown user id is in mentions', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'hi',
          mentions: ['ghost-user'],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_mention');
    });
  });

  it('silently drops the actor from mentions', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'self',
          mentions: ['mock-user-1'],
        }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { commentId: string };
      const [row] = await db.select().from(comments).where(eq(comments.id, out.commentId));
      expect(row.mentions).toEqual([]);
    });
  });

  it('fires notifyComment with mentionedUserIds populated', async () => {
    await db
      .insert(users)
      .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
      .onConflictDoNothing();

    const captured: { mentionedUserIds: string[]; actorUserId: string }[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-spy-'))),
      notifier: {
        async notifyComment(args: unknown) {
          captured.push(args as never);
        },
      } as never,
    });
    const seed = await seedDocument();
    await spyApp.request(`/api/versions/${seed.versionId}/threads`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
        body: '@Two hi',
        mentions: ['mock-user-2'],
      }),
    });
    // Notifier is fire-and-forget; give it a microtask tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0].mentionedUserIds).toEqual(['mock-user-2']);
    expect(captured[0].actorUserId).toBe('mock-user-1');
  });

  it('forwards the document uploader id to notifyComment on a new thread', async () => {
    await db
      .insert(users)
      .values({ id: 'mock-user-2', email: 'two@p.t', displayName: 'Two' })
      .onConflictDoNothing();

    const captured: { uploaderUserId: string | null; actorUserId: string }[] = [];
    const spyApp = createApp({
      storage: new FilesystemStorage(await mkdtemp(join(tmpdir(), 'primer-uploader-spy-'))),
      notifier: {
        async notifyComment(args: unknown) {
          captured.push(args as never);
        },
      } as never,
    });
    // Uploader is user-2; actor (default header) is user-1.
    const seed = await seedDocument({ uploaderId: 'mock-user-2' });
    await spyApp.request(`/api/versions/${seed.versionId}/threads`, {
      method: 'POST',
      headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
        body: 'first comment, no mentions',
        mentions: [],
      }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(1);
    expect(captured[0].uploaderUserId).toBe('mock-user-2');
    expect(captured[0].actorUserId).toBe('mock-user-1');
  });
});

async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-threads-multi-'));
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

describe('threads under visibility + collab', () => {
  it('GET threads on private doc as non-collab returns 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/versions/${v.id}/threads`, {
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(404);
    });
  });

  it('POST thread on private doc as commenter collab returns 201', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'hey',
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  it('POST thread on private doc as stranger returns 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
          body: 'hey',
        }),
      });
      expect(res.status).toBe(404);
    });
  });
});
