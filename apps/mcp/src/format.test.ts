import { describe, expect, it } from 'vitest';
import type { ThreadsListResponse } from '@polygonlabs/primer-api-types';
import { formatComments } from './format.ts';

const baseAnchor = {
  type: 'text-range' as const,
  prefix: '',
  suffix: '',
  containerPath: 'body',
};

describe('formatComments', () => {
  it('renders header with title + version when both provided, counts, blockquote, badges, and comments', () => {
    const threads: ThreadsListResponse = {
      asOf: '2026-06-05T12:00:00.000Z',
      threads: [
        {
          id: 't1',
          versionId: 'v1',
          versionNumber: 1,
          contextChanged: false,
          anchor: { ...baseAnchor, selectorText: 'the cake is a lie' },
          resolvedAt: null,
          resolvedBy: null,
          resolvedByDisplayName: null,
          createdAt: '2026-06-05T10:00:00.000Z',
          comments: [
            {
              id: 'c1',
              threadId: 't1',
              authorId: 'u1',
              authorDisplayName: 'Alice',
              body: 'I disagree with this framing.',
              createdAt: '2026-06-05T10:00:00.000Z',
              updatedAt: null,
              deletedAt: null,
              mentions: [],
            },
            {
              id: 'c2',
              threadId: 't1',
              authorId: 'u2',
              authorDisplayName: 'Bob',
              body: 'Fair point.',
              createdAt: '2026-06-05T10:05:00.000Z',
              updatedAt: null,
              deletedAt: null,
              mentions: [],
            },
          ],
        },
        {
          id: 't2',
          versionId: 'v1',
          versionNumber: 1,
          contextChanged: false,
          anchor: { ...baseAnchor, selectorText: 'resolved selection' },
          resolvedAt: '2026-06-05T11:00:00.000Z',
          resolvedBy: 'u3',
          resolvedByDisplayName: 'Carol',
          createdAt: '2026-06-05T10:30:00.000Z',
          comments: [
            {
              id: 'c3',
              threadId: 't2',
              authorId: 'u3',
              authorDisplayName: 'Carol',
              body: 'Resolved.',
              createdAt: '2026-06-05T10:30:00.000Z',
              updatedAt: null,
              deletedAt: null,
              mentions: [],
            },
          ],
        },
      ],
    };

    const out = formatComments(threads, 'Cake Manifesto', 3);

    expect(out).toContain('# Comments on Cake Manifesto (v3)');
    expect(out).toContain('Threads: 2 (open: 1, resolved: 1)');
    // The exact selectorText must appear as a markdown blockquote line.
    expect(out).toContain('> the cake is a lie');
    expect(out).toContain('[open]');
    expect(out).toContain('[resolved]');
    expect(out).toContain('**Alice** — I disagree with this framing. (2026-06-05T10:00:00.000Z)');
    expect(out).toContain('**Bob** — Fair point. (2026-06-05T10:05:00.000Z)');
    expect(out).toContain('**Carol** — Resolved. (2026-06-05T10:30:00.000Z)');
  });

  it('renders tombstoned comments as (deleted) with no body', () => {
    const threads: ThreadsListResponse = {
      asOf: '2026-06-05T12:00:00.000Z',
      threads: [
        {
          id: 't1',
          versionId: 'v1',
          versionNumber: 1,
          contextChanged: false,
          anchor: { ...baseAnchor, selectorText: 'snippet' },
          resolvedAt: null,
          resolvedBy: null,
          resolvedByDisplayName: null,
          createdAt: '2026-06-05T10:00:00.000Z',
          comments: [
            {
              id: 'c1',
              threadId: 't1',
              authorId: 'u1',
              authorDisplayName: 'Alice',
              body: '',
              createdAt: '2026-06-05T10:00:00.000Z',
              updatedAt: null,
              deletedAt: '2026-06-05T10:10:00.000Z',
              mentions: [],
            },
            {
              id: 'c2',
              threadId: 't1',
              authorId: 'u2',
              authorDisplayName: 'Bob',
              body: 'Still here.',
              createdAt: '2026-06-05T10:15:00.000Z',
              updatedAt: null,
              deletedAt: null,
              mentions: [],
            },
          ],
        },
      ],
    };

    const out = formatComments(threads);

    expect(out).toContain('(deleted)');
    // The tombstoned comment must NOT spill the (empty) body or author into a
    // normal-looking comment line.
    expect(out).not.toMatch(/\*\*Alice\*\* —/);
    // The live comment still renders normally.
    expect(out).toContain('**Bob** — Still here.');
  });

  it('handles the empty case with a clear message', () => {
    const threads: ThreadsListResponse = {
      asOf: '2026-06-05T12:00:00.000Z',
      threads: [],
    };

    const out = formatComments(threads, 'Empty Doc', 1);
    expect(out).toContain('No comments on this version.');
  });

  it('omits doc-title qualifier from header when title/version not provided', () => {
    const threads: ThreadsListResponse = {
      asOf: '2026-06-05T12:00:00.000Z',
      threads: [
        {
          id: 't1',
          versionId: 'v1',
          versionNumber: 1,
          contextChanged: false,
          anchor: { ...baseAnchor, selectorText: 'x' },
          resolvedAt: null,
          resolvedBy: null,
          resolvedByDisplayName: null,
          createdAt: '2026-06-05T10:00:00.000Z',
          comments: [
            {
              id: 'c1',
              threadId: 't1',
              authorId: 'u1',
              authorDisplayName: 'Alice',
              body: 'hi',
              createdAt: '2026-06-05T10:00:00.000Z',
              updatedAt: null,
              deletedAt: null,
              mentions: [],
            },
          ],
        },
      ],
    };

    const out = formatComments(threads);
    // Header line should be the bare form when title/version absent.
    expect(out.split('\n')[0]).toBe('# Comments');
  });

  it('falls back to innerText / placeholder when anchor is element-path', () => {
    const threads: ThreadsListResponse = {
      asOf: '2026-06-05T12:00:00.000Z',
      threads: [
        {
          id: 't1',
          versionId: 'v1',
          versionNumber: 1,
          contextChanged: false,
          anchor: {
            type: 'element-path',
            path: 'body>div',
            innerHash: 'h',
            innerText: 'Picked element label',
          },
          resolvedAt: null,
          resolvedBy: null,
          resolvedByDisplayName: null,
          createdAt: '2026-06-05T10:00:00.000Z',
          comments: [
            {
              id: 'c1',
              threadId: 't1',
              authorId: 'u1',
              authorDisplayName: 'Alice',
              body: 'note',
              createdAt: '2026-06-05T10:00:00.000Z',
              updatedAt: null,
              deletedAt: null,
              mentions: [],
            },
          ],
        },
      ],
    };

    const out = formatComments(threads);
    expect(out).toContain('> Picked element label');
  });
});
