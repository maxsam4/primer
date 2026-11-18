import { describe, it, expect } from 'vitest';
import { insertThread } from '../testing/threads.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, documentViews, users } from '../db/schema.ts';
import type { AdminStatsResponse } from '@polygonlabs/primer-api-types';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-admin-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshot(app: ReturnType<typeof createApp>): Promise<AdminStatsResponse> {
  const res = await app.request('/api/admin/stats');
  expect(res.status).toBe(200);
  return (await res.json()) as AdminStatsResponse;
}

describe('GET /api/admin/stats', () => {
  it('returns the expected JSON shape', async () => {
    await withApp(async (app) => {
      const body = await snapshot(app);
      expect(body).toMatchObject({
        users:         { total: expect.any(Number), last7d: expect.any(Number) },
        documents:     { total: expect.any(Number), last7d: expect.any(Number) },
        versions:      { total: expect.any(Number), last7d: expect.any(Number) },
        threads:       { total: expect.any(Number), last7d: expect.any(Number) },
        comments:      { total: expect.any(Number), last7d: expect.any(Number) },
        documentViews: { total: expect.any(Number), last7d: expect.any(Number) },
      });
    });
  });

  it('counts inserted rows in totals (delta from baseline)', async () => {
    await withApp(async (app) => {
      const before = await snapshot(app);

      const userId = `admin-test-user-${uuidv7()}`;
      const docId = uuidv7();
      const versionId = uuidv7();
      const threadId = uuidv7();
      const commentId = uuidv7();

      await db.insert(users).values({ id: userId, email: 'a@p.t', displayName: 'A' });
      await db.insert(documents).values({ id: docId, title: 'A', uploaderId: userId });
      await db.insert(versions).values({
        id: versionId, documentId: docId, versionNumber: 1,
        storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
      });
      await insertThread({
        id: threadId, versionId,
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({
        id: commentId, threadId, authorId: userId, body: 'hi',
      });
      await db.insert(documentViews).values({ userId, documentId: docId });

      const after = await snapshot(app);
      expect(after.users.total - before.users.total).toBe(1);
      expect(after.documents.total - before.documents.total).toBe(1);
      expect(after.versions.total - before.versions.total).toBe(1);
      expect(after.threads.total - before.threads.total).toBe(1);
      expect(after.comments.total - before.comments.total).toBe(1);
      expect(after.documentViews.total - before.documentViews.total).toBe(1);
    });
  });

  it('excludes soft-deleted documents and tombstoned comments from totals', async () => {
    await withApp(async (app) => {
      const before = await snapshot(app);

      const userId = `admin-test-user-${uuidv7()}`;
      const aliveDocId = uuidv7();
      const deletedDocId = uuidv7();
      const versionId = uuidv7();
      const threadId = uuidv7();
      const aliveCommentId = uuidv7();
      const tombstonedCommentId = uuidv7();
      const now = new Date();

      await db.insert(users).values({ id: userId, email: 'b@p.t', displayName: 'B' });
      await db.insert(documents).values({ id: aliveDocId, title: 'Alive', uploaderId: userId });
      await db.insert(documents).values({ id: deletedDocId, title: 'Gone', uploaderId: userId, deletedAt: now });
      await db.insert(versions).values({
        id: versionId, documentId: aliveDocId, versionNumber: 1,
        storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
      });
      await insertThread({
        id: threadId, versionId,
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({ id: aliveCommentId, threadId, authorId: userId, body: 'kept' });
      await db.insert(comments).values({ id: tombstonedCommentId, threadId, authorId: userId, body: 'gone', deletedAt: now });

      const after = await snapshot(app);
      expect(after.documents.total - before.documents.total).toBe(1);
      expect(after.comments.total - before.comments.total).toBe(1);
    });
  });

  it('includes rows in last7d only when newer than 7 days; total counts both', async () => {
    await withApp(async (app) => {
      const before = await snapshot(app);

      const userId = `admin-test-user-${uuidv7()}`;
      await db.insert(users).values({ id: userId, email: 'c@p.t', displayName: 'C' });

      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      const oldDocId = uuidv7();
      const newDocId = uuidv7();
      await db.insert(documents).values({ id: oldDocId, title: 'Old', uploaderId: userId, createdAt: oldDate });
      await db.insert(documents).values({ id: newDocId, title: 'New', uploaderId: userId });

      const oldVersionId = uuidv7();
      const newVersionId = uuidv7();
      await db.insert(versions).values({
        id: oldVersionId, documentId: newDocId, versionNumber: 1,
        storageKey: `v1/${oldVersionId}.html`, sizeBytes: 0, versionNote: null,
        createdAt: oldDate,
      });
      await db.insert(versions).values({
        id: newVersionId, documentId: newDocId, versionNumber: 2,
        storageKey: `v1/${newVersionId}.html`, sizeBytes: 0, versionNote: null,
      });

      const oldThreadId = uuidv7();
      const newThreadId = uuidv7();
      await insertThread({
        id: oldThreadId, versionId: newVersionId,
        anchor: { type: 'text-range', selectorText: 'a', prefix: '', suffix: '', containerPath: 'body' },
        createdAt: oldDate,
      });
      await insertThread({
        id: newThreadId, versionId: newVersionId,
        anchor: { type: 'text-range', selectorText: 'b', prefix: '', suffix: '', containerPath: 'body' },
      });

      await db.insert(comments).values({
        id: uuidv7(), threadId: newThreadId, authorId: userId, body: 'old', createdAt: oldDate,
      });
      await db.insert(comments).values({
        id: uuidv7(), threadId: newThreadId, authorId: userId, body: 'new',
      });

      await db.insert(documentViews).values({
        userId, documentId: oldDocId, viewedAt: oldDate,
      });
      // Same (userId, newDocId) pair as primary key — only one row per pair, so this is the "new" view.
      await db.insert(documentViews).values({ userId, documentId: newDocId });

      const after = await snapshot(app);

      // Totals see both rows.
      expect(after.documents.total - before.documents.total).toBe(2);
      expect(after.versions.total - before.versions.total).toBe(2);
      expect(after.threads.total - before.threads.total).toBe(2);
      expect(after.comments.total - before.comments.total).toBe(2);
      expect(after.documentViews.total - before.documentViews.total).toBe(2);

      // last7d sees only the new one.
      expect(after.documents.last7d - before.documents.last7d).toBe(1);
      expect(after.versions.last7d - before.versions.last7d).toBe(1);
      expect(after.threads.last7d - before.threads.last7d).toBe(1);
      expect(after.comments.last7d - before.comments.last7d).toBe(1);
      expect(after.documentViews.last7d - before.documentViews.last7d).toBe(1);

      // users.last7d should also see the newly inserted (default-timestamped) user.
      expect(after.users.last7d - before.users.last7d).toBe(1);
    });
  });

  it('returns the expanded admin shape with 30-entry daily series and 6 histogram buckets', async () => {
    await withApp(async (app) => {
      const body = await snapshot(app);
      expect(body.rangeDays).toBe(30);
      expect(body.adoption.createdPerDay).toHaveLength(30);
      expect(body.adoption.activeUsersPerDay).toHaveLength(30);
      expect(body.adoption.cumulativeUsers).toHaveLength(30);
      expect(body.engagement.viewersPerDocHistogram).toHaveLength(6);
      expect(body.engagement.viewersPerDocHistogram.map((b) => b.bucket)).toEqual([
        '0', '1-2', '3-5', '6-10', '11-25', '26+',
      ]);
      expect(body.operational.storageBytesPerDay).toHaveLength(30);
      expect(body.operational.threadsOpenedVsResolved).toHaveLength(30);
      expect(body.operational.openThreadsAgingOver14d.sparkline).toHaveLength(30);
      // Spine is sorted ascending.
      for (let i = 1; i < body.adoption.createdPerDay.length; i++) {
        expect(body.adoption.createdPerDay[i].date >
          body.adoption.createdPerDay[i - 1].date).toBe(true);
      }
    });
  });
});
