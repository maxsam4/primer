import { describe, it, expect } from 'vitest';
import type { ThreadDTO, CommentDTO } from '@polygonlabs/primer-api-types';
import { liveComments, hasLiveComments, hasAnyComments } from './liveComments.ts';

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
    id: 't-' + Math.random().toString(36).slice(2, 8),
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

describe('liveComments', () => {
  it('returns all comments when none are tombstoned', () => {
    const t = thread({
      comments: [comment({ body: 'a' }), comment({ body: 'b' })],
    });
    expect(liveComments(t).map((c) => c.body)).toEqual(['a', 'b']);
  });

  it('excludes tombstoned comments', () => {
    const t = thread({
      comments: [
        comment({ body: 'kept', deletedAt: null }),
        comment({ body: 'gone', deletedAt: '2026-05-20T11:00:00.000Z' }),
      ],
    });
    expect(liveComments(t).map((c) => c.body)).toEqual(['kept']);
  });

  it('returns an empty array when every comment is tombstoned', () => {
    const t = thread({
      comments: [comment({ deletedAt: '2026-05-20T11:00:00.000Z' })],
    });
    expect(liveComments(t)).toEqual([]);
  });

  it('preserves comment order', () => {
    const t = thread({
      comments: [
        comment({ body: '1', createdAt: '2026-05-20T10:00:00.000Z' }),
        comment({ body: '2', createdAt: '2026-05-20T10:01:00.000Z', deletedAt: '2026-05-20T11:00:00.000Z' }),
        comment({ body: '3', createdAt: '2026-05-20T10:02:00.000Z' }),
      ],
    });
    expect(liveComments(t).map((c) => c.body)).toEqual(['1', '3']);
  });
});

describe('hasLiveComments', () => {
  it('is true when at least one comment survives', () => {
    const t = thread({
      comments: [
        comment({ deletedAt: '2026-05-20T11:00:00.000Z' }),
        comment({ deletedAt: null }),
      ],
    });
    expect(hasLiveComments(t)).toBe(true);
  });

  it('is false when every comment is tombstoned', () => {
    const t = thread({
      comments: [
        comment({ deletedAt: '2026-05-20T11:00:00.000Z' }),
        comment({ deletedAt: '2026-05-20T11:01:00.000Z' }),
      ],
    });
    expect(hasLiveComments(t)).toBe(false);
  });

  it('is false when the comments array is empty', () => {
    const t = thread({ comments: [] });
    expect(hasLiveComments(t)).toBe(false);
  });
});

describe('hasAnyComments', () => {
  it('is true for a thread whose only comment is tombstoned', () => {
    const t = thread({ comments: [comment({ deletedAt: '2026-05-20T11:00:00.000Z' })] });
    expect(hasAnyComments(t)).toBe(true);
  });

  it('is true for a thread with live comments', () => {
    expect(hasAnyComments(thread())).toBe(true);
  });

  it('is false when the comments array is empty', () => {
    expect(hasAnyComments(thread({ comments: [] }))).toBe(false);
  });
});
