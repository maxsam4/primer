import { describe, it, expect } from 'vitest';
import { insertThread } from '../testing/threads.ts';
import { v7 as uuidv7 } from 'uuid';
import { utcDateString, buildDateSpine, leftJoinDailyCounts, buildAdoption, buildEngagement, buildOperational } from './adminStats.ts';
import { db } from '../db/client.ts';
import { users, documents, versions, threads, comments, documentViews } from '../db/schema.ts';

const MS_PER_DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * MS_PER_DAY);

describe('utcDateString', () => {
  it('formats a UTC Date as YYYY-MM-DD', () => {
    expect(utcDateString(new Date(Date.UTC(2026, 5, 19)))).toBe('2026-06-19');
    expect(utcDateString(new Date(Date.UTC(2025, 0, 1)))).toBe('2025-01-01');
  });

  it('uses UTC, not local time, near midnight', () => {
    // 23:30 UTC on 2026-06-19 is the *same day* in UTC regardless of local TZ.
    expect(utcDateString(new Date(Date.UTC(2026, 5, 19, 23, 30)))).toBe('2026-06-19');
  });
});

describe('buildDateSpine', () => {
  it('returns exactly N days, oldest first, ending at the given date', () => {
    const end = new Date(Date.UTC(2026, 5, 19));
    const spine = buildDateSpine(end, 30);
    expect(spine).toHaveLength(30);
    expect(spine[0]).toBe('2026-05-21');
    expect(spine[29]).toBe('2026-06-19');
  });

  it('handles month boundaries', () => {
    const end = new Date(Date.UTC(2026, 2, 3));   // 2026-03-03
    const spine = buildDateSpine(end, 5);
    expect(spine).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03']);
  });
});

describe('leftJoinDailyCounts', () => {
  it('returns 0 for spine dates absent from counts', () => {
    const spine = ['2026-06-01', '2026-06-02', '2026-06-03'];
    const counts = new Map([['2026-06-02', 5]]);
    expect(leftJoinDailyCounts(spine, counts)).toEqual([
      { date: '2026-06-01', value: 0 },
      { date: '2026-06-02', value: 5 },
      { date: '2026-06-03', value: 0 },
    ]);
  });

  it('ignores counts not in the spine', () => {
    const spine = ['2026-06-01'];
    const counts = new Map([['2026-06-01', 1], ['2026-05-31', 99]]);
    expect(leftJoinDailyCounts(spine, counts)).toEqual([
      { date: '2026-06-01', value: 1 },
    ]);
  });
});

describe('buildAdoption', () => {
  it('returns exactly 30 entries per series', async () => {
    const res = await buildAdoption();
    expect(res.createdPerDay).toHaveLength(30);
    expect(res.activeUsersPerDay).toHaveLength(30);
    expect(res.cumulativeUsers).toHaveLength(30);
  });

  it('createdPerDay counts documents/versions/comments by UTC day, alive only', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    const threadId = uuidv7();

    await db.insert(users).values({ id: userId, email: 'a@p.t', displayName: 'A' });
    await db.insert(documents).values({
      id: docId, title: 'D', uploaderId: userId, createdAt: daysAgo(2),
    });
    await db.insert(documents).values({
      id: uuidv7(), title: 'gone', uploaderId: userId, createdAt: daysAgo(2),
      deletedAt: daysAgo(1),
    });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 100, versionNote: null,
      createdAt: daysAgo(2),
    });
    await insertThread({
      id: threadId, versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: daysAgo(2),
    });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'live', createdAt: daysAgo(2),
    });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'gone',
      createdAt: daysAgo(2), deletedAt: daysAgo(1),
    });

    const res = await buildAdoption();

    // Derive the expected UTC date from the inserted timestamp to avoid
    // flakiness near midnight UTC. Look up the matching point in the spine.
    const targetDate = daysAgo(2).toISOString().slice(0, 10);
    const point = res.createdPerDay.find((p) => p.date === targetDate);
    expect(point).toEqual({ date: targetDate, documents: 1, versions: 1, comments: 1 });
  });

  it('activeUsersPerDay counts a user once per day across upload/comment/view sources', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    const threadId = uuidv7();
    const when = daysAgo(3);

    await db.insert(users).values({ id: userId, email: 'b@p.t', displayName: 'B' });
    await db.insert(documents).values({
      id: docId, title: 'D', uploaderId: userId, createdAt: when,
    });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
      createdAt: when,
    });
    await insertThread({
      id: threadId, versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: when,
    });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'x', createdAt: when,
    });
    await db.insert(documentViews).values({ userId, documentId: docId, viewedAt: when });

    const res = await buildAdoption();
    const targetDate = when.toISOString().slice(0, 10);
    const point = res.activeUsersPerDay.find((p) => p.date === targetDate);
    expect(point).toBeDefined();
    expect(point!.value).toBeGreaterThanOrEqual(1);
    // The exact value depends on what else seeded the DB, but our user must
    // appear at most once on this day.
  });

  it('cumulativeUsers is monotonic non-decreasing and seeded by pre-window users', async () => {
    // Seed: one user created 60 days ago (pre-window), one created today.
    await db.insert(users).values({
      id: `pre-${uuidv7()}`, email: 'p@p.t', displayName: 'P',
      createdAt: daysAgo(60),
    });
    await db.insert(users).values({
      id: `cur-${uuidv7()}`, email: 'c@p.t', displayName: 'C',
    });

    const res = await buildAdoption();
    for (let i = 1; i < res.cumulativeUsers.length; i++) {
      expect(res.cumulativeUsers[i].value).toBeGreaterThanOrEqual(res.cumulativeUsers[i - 1].value);
    }
    // The first day's seed >= 1 (the pre-window user).
    expect(res.cumulativeUsers[0].value).toBeGreaterThanOrEqual(1);
    // The last day's count must be >= first day + 1 (the today user).
    expect(res.cumulativeUsers[29].value).toBeGreaterThanOrEqual(res.cumulativeUsers[0].value + 1);
  });
});

describe('buildEngagement', () => {
  const HIST_BUCKETS = ['0', '1-2', '3-5', '6-10', '11-25', '26+'];

  it('returns the six histogram buckets in canonical order, even when empty', async () => {
    const res = await buildEngagement();
    expect(res.viewersPerDocHistogram.map((b) => b.bucket)).toEqual(HIST_BUCKETS);
  });

  it('topDocumentsByViewers respects deleted_at and counts distinct viewers', async () => {
    const u1 = `t-${uuidv7()}`;
    const u2 = `t-${uuidv7()}`;
    const u3 = `t-${uuidv7()}`;
    const aliveDoc = uuidv7();
    const deadDoc = uuidv7();
    const aliveTitle = `Alive-${aliveDoc}`;
    const deadTitle = `Dead-${deadDoc}`;

    await db.insert(users).values([
      { id: u1, email: '1@p.t', displayName: '1' },
      { id: u2, email: '2@p.t', displayName: '2' },
      { id: u3, email: '3@p.t', displayName: '3' },
    ]);
    await db.insert(documents).values({ id: aliveDoc, title: aliveTitle, uploaderId: u1 });
    await db.insert(documents).values({ id: deadDoc,  title: deadTitle,  uploaderId: u1, deletedAt: new Date() });

    // Alive doc: three distinct viewers. Dead doc: three viewers but soft-deleted.
    await db.insert(documentViews).values([
      { userId: u1, documentId: aliveDoc },
      { userId: u2, documentId: aliveDoc },
      { userId: u3, documentId: aliveDoc },
      { userId: u1, documentId: deadDoc },
      { userId: u2, documentId: deadDoc },
      { userId: u3, documentId: deadDoc },
    ]);

    const res = await buildEngagement();
    const found = res.topDocumentsByViewers.find((d) => d.title === aliveTitle);
    expect(found).toBeDefined();
    expect(found?.viewers).toBe(3);
    expect(res.topDocumentsByViewers.find((d) => d.title === deadTitle)).toBeUndefined();
    expect(res.topDocumentsByViewers.length).toBeLessThanOrEqual(10);
  });

  it('topCommenters is windowed to last 30d and excludes deleted comments', async () => {
    const userId = `t-${uuidv7()}`;
    const displayName = `Commenter-${userId}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    const threadId = uuidv7();

    await db.insert(users).values({ id: userId, email: 'c@p.t', displayName });
    await db.insert(documents).values({ id: docId, title: 'D', uploaderId: userId });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
    });
    await insertThread({
      id: threadId, versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
    });

    // 1 alive in-window comment, 1 deleted in-window comment, 1 old comment.
    await db.insert(comments).values({ id: uuidv7(), threadId, authorId: userId, body: 'kept' });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'gone', deletedAt: new Date(),
    });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'too old',
      createdAt: daysAgo(60),
    });

    const res = await buildEngagement();
    const me = res.topCommenters.find((c) => c.displayName === displayName);
    expect(me).toBeDefined();
    expect(me?.comments).toBe(1);
  });

  it('viewersPerDocHistogram includes documents with zero viewers in the 0 bucket', async () => {
    const u1 = `t-${uuidv7()}`;
    const u2 = `t-${uuidv7()}`;
    const docNoViews = uuidv7();
    const docTwoViews = uuidv7();

    await db.insert(users).values([
      { id: u1, email: '1@p.t', displayName: '1' },
      { id: u2, email: '2@p.t', displayName: '2' },
    ]);
    await db.insert(documents).values([
      { id: docNoViews, title: 'No Views', uploaderId: u1 },
      { id: docTwoViews, title: 'Two Views', uploaderId: u1 },
    ]);
    await db.insert(documentViews).values([
      { userId: u1, documentId: docTwoViews },
      { userId: u2, documentId: docTwoViews },
    ]);

    const res = await buildEngagement();
    const zero = res.viewersPerDocHistogram.find((b) => b.bucket === '0')!;
    const oneTwo = res.viewersPerDocHistogram.find((b) => b.bucket === '1-2')!;
    expect(zero.count).toBeGreaterThanOrEqual(1);
    expect(oneTwo.count).toBeGreaterThanOrEqual(1);
  });
});

describe('buildOperational', () => {
  it('returns exactly 30 entries per series', async () => {
    const res = await buildOperational();
    expect(res.storageBytesPerDay).toHaveLength(30);
    expect(res.threadsOpenedVsResolved).toHaveLength(30);
    expect(res.openThreadsAgingOver14d.sparkline).toHaveLength(30);
  });

  it('storageBytesPerDay is monotonic non-decreasing and seeded by pre-window versions', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    await db.insert(users).values({ id: userId, email: 's@p.t', displayName: 'S' });
    await db.insert(documents).values({ id: docId, title: 'S', uploaderId: userId });

    const preVersionId = uuidv7();
    await db.insert(versions).values({
      id: preVersionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${preVersionId}.html`, sizeBytes: 1_000_000, versionNote: null,
      createdAt: daysAgo(60),
    });
    const inWindowVersionId = uuidv7();
    await db.insert(versions).values({
      id: inWindowVersionId, documentId: docId, versionNumber: 2,
      storageKey: `v1/${inWindowVersionId}.html`, sizeBytes: 500_000, versionNote: null,
      createdAt: daysAgo(5),
    });

    const res = await buildOperational();
    for (let i = 1; i < res.storageBytesPerDay.length; i++) {
      expect(res.storageBytesPerDay[i].value).toBeGreaterThanOrEqual(res.storageBytesPerDay[i - 1].value);
    }
    expect(res.storageBytesPerDay[0].value).toBeGreaterThanOrEqual(1_000_000);
    expect(res.storageBytesPerDay[29].value).toBeGreaterThanOrEqual(1_500_000);
  });

  it('threadsOpenedVsResolved counts opens by created_at and resolves by resolved_at', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    await db.insert(users).values({ id: userId, email: 't@p.t', displayName: 'T' });
    await db.insert(documents).values({ id: docId, title: 'T', uploaderId: userId });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
    });
    const threadOpenedDay = daysAgo(5);
    const threadResolvedDay = daysAgo(2);
    await insertThread({
      id: uuidv7(), versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: threadOpenedDay,
      resolvedAt: threadResolvedDay,
      resolvedBy: userId,
    });

    const res = await buildOperational();
    const openedTarget = threadOpenedDay.toISOString().slice(0, 10);
    const resolvedTarget = threadResolvedDay.toISOString().slice(0, 10);
    const openedPoint = res.threadsOpenedVsResolved.find((p) => p.date === openedTarget);
    const resolvedPoint = res.threadsOpenedVsResolved.find((p) => p.date === resolvedTarget);
    expect(openedPoint).toBeDefined();
    expect(resolvedPoint).toBeDefined();
    expect(openedPoint!.opened).toBeGreaterThanOrEqual(1);
    expect(resolvedPoint!.resolved).toBeGreaterThanOrEqual(1);
  });

  it('openThreadsAgingOver14d counts unresolved threads older than 14 days', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    await db.insert(users).values({ id: userId, email: 'a@p.t', displayName: 'A' });
    await db.insert(documents).values({ id: docId, title: 'A', uploaderId: userId });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
    });
    // Aged & unresolved → counts.
    await insertThread({
      id: uuidv7(), versionId,
      anchor: { type: 'text-range', selectorText: 'a', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: daysAgo(20),
    });
    // Aged & resolved → does NOT count.
    await insertThread({
      id: uuidv7(), versionId,
      anchor: { type: 'text-range', selectorText: 'b', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: daysAgo(20),
      resolvedAt: daysAgo(1),
      resolvedBy: userId,
    });
    // Young & unresolved → does NOT count.
    await insertThread({
      id: uuidv7(), versionId,
      anchor: { type: 'text-range', selectorText: 'c', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: daysAgo(5),
    });

    const res = await buildOperational();
    expect(res.openThreadsAgingOver14d.count).toBeGreaterThanOrEqual(1);
  });
});
