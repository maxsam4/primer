import { describe, it, expect } from 'vitest';
import type { ThreadDTO, CommentDTO } from '@polygonlabs/primer-api-types';
import { COMMENT_UNDO_WINDOW_MS } from '@polygonlabs/primer-api-types';
import { canUndoDelete, commentRowModels } from './commentRows.ts';

const NOW = Date.parse('2026-05-20T12:00:00.000Z');

function comment(over: Partial<CommentDTO> = {}): CommentDTO {
  return {
    id: 'c-' + Math.random().toString(36).slice(2, 8),
    threadId: 't-1',
    authorId: 'u1',
    authorDisplayName: 'Author',
    body: 'hi',
    createdAt: '2026-05-20T10:00:00.000Z',
    updatedAt: null,
    deletedAt: null,
    mentions: [],
    ...over,
  };
}

function thread(over: Partial<ThreadDTO> = {}): ThreadDTO {
  return {
    id: 't-1',
    versionId: 'v-1',
    versionNumber: 1,
    anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
    contextChanged: false,
    resolvedAt: null,
    resolvedBy: null,
    resolvedByDisplayName: null,
    createdAt: '2026-05-20T10:00:00.000Z',
    comments: [comment()],
    ...over,
  };
}

/** An ISO timestamp `ms` milliseconds before NOW. */
function agoIso(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('canUndoDelete', () => {
  it('is false for a comment that is not deleted', () => {
    expect(canUndoDelete(comment({ deletedAt: null }), 'u1', NOW)).toBe(false);
  });

  it('is true for the author inside the undo window', () => {
    const c = comment({ authorId: 'u1', deletedAt: agoIso(60_000) });
    expect(canUndoDelete(c, 'u1', NOW)).toBe(true);
  });

  it('is false for anyone who is not the author', () => {
    const c = comment({ authorId: 'u1', deletedAt: agoIso(60_000) });
    expect(canUndoDelete(c, 'u2', NOW)).toBe(false);
  });

  it('is false once the undo window has elapsed', () => {
    const c = comment({ authorId: 'u1', deletedAt: agoIso(COMMENT_UNDO_WINDOW_MS + 1) });
    expect(canUndoDelete(c, 'u1', NOW)).toBe(false);
  });

  it('is true exactly at the window boundary', () => {
    const c = comment({ authorId: 'u1', deletedAt: agoIso(COMMENT_UNDO_WINDOW_MS) });
    expect(canUndoDelete(c, 'u1', NOW)).toBe(true);
  });

  it('is true when the clock skews the deletion slightly into the future', () => {
    const c = comment({ authorId: 'u1', deletedAt: new Date(NOW + 5_000).toISOString() });
    expect(canUndoDelete(c, 'u1', NOW)).toBe(true);
  });

  it('is false for an unparseable deletedAt rather than throwing', () => {
    const c = comment({ authorId: 'u1', deletedAt: 'not-a-date' });
    expect(canUndoDelete(c, 'u1', NOW)).toBe(false);
  });
});

describe('commentRowModels', () => {
  it('marks live comments as live and never offers undo on them', () => {
    const t = thread({ comments: [comment({ body: 'a' })] });
    expect(commentRowModels(t, 'u1', NOW)).toEqual([
      { comment: t.comments[0], mode: 'live', canUndo: false },
    ]);
  });

  it('keeps tombstoned comments as deleted rows instead of dropping them', () => {
    const gone = comment({ body: '', deletedAt: agoIso(60_000) });
    const t = thread({ comments: [gone] });
    const rows = commentRowModels(t, 'u1', NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('deleted');
  });

  it('offers undo on a freshly deleted row to its author only', () => {
    const gone = comment({ authorId: 'u1', deletedAt: agoIso(60_000) });
    const t = thread({ comments: [gone] });
    expect(commentRowModels(t, 'u1', NOW)[0].canUndo).toBe(true);
    expect(commentRowModels(t, 'u2', NOW)[0].canUndo).toBe(false);
  });

  it('shows a stale deleted row with no undo', () => {
    const gone = comment({ authorId: 'u1', deletedAt: agoIso(COMMENT_UNDO_WINDOW_MS + 1) });
    const t = thread({ comments: [gone] });
    const rows = commentRowModels(t, 'u1', NOW);
    expect(rows[0].mode).toBe('deleted');
    expect(rows[0].canUndo).toBe(false);
  });

  it('preserves order and position so a deleted first comment stays first', () => {
    const t = thread({
      comments: [
        comment({ body: '', createdAt: '2026-05-20T10:00:00.000Z', deletedAt: agoIso(60_000) }),
        comment({ body: '2', createdAt: '2026-05-20T10:01:00.000Z' }),
        comment({ body: '3', createdAt: '2026-05-20T10:02:00.000Z' }),
      ],
    });
    const rows = commentRowModels(t, 'u1', NOW);
    expect(rows.map((r) => r.mode)).toEqual(['deleted', 'live', 'live']);
    expect(rows.map((r) => r.comment.body)).toEqual(['', '2', '3']);
  });

  it('returns an empty list for a thread with no comments', () => {
    expect(commentRowModels(thread({ comments: [] }), 'u1', NOW)).toEqual([]);
  });
});
