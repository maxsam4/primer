import { describe, it, expect } from 'vitest';
import type { ThreadDTO, CommentDTO } from '@polygonlabs/primer-api-types';
import {
  commentsFilename,
  formatThreadsAsMarkdown,
  htmlFilename,
  markdownFilename,
} from './exportComments.ts';

const NOW = new Date('2026-05-21T12:00:00Z');

function comment(over: Partial<CommentDTO> = {}): CommentDTO {
  return {
    id: 'c-' + Math.random().toString(36).slice(2, 8),
    threadId: 't-1',
    authorId: 'u1',
    authorDisplayName: 'Taylan Pince',
    body: 'looks good',
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
    anchor: { type: 'text-range', selectorText: 'hello world', prefix: 'say ', suffix: ' loud', containerPath: 'body > p' },
    contextChanged: false,
    resolvedAt: null,
    resolvedBy: null,
    resolvedByDisplayName: null,
    createdAt: '2026-05-20T10:00:00.000Z',
    comments: [comment()],
    ...over,
  };
}

const doc = { title: 'Agglayer DVN Paths' };
const version = { versionNumber: 3 };

describe('formatThreadsAsMarkdown', () => {
  it('renders the header with counts and date', () => {
    const md = formatThreadsAsMarkdown(doc, version, [thread()], NOW);
    expect(md).toContain('# Comments on "Agglayer DVN Paths" (v3)');
    expect(md).toContain('Exported 2026-05-21');
    expect(md).toContain('1 open thread · 1 comment');
  });

  it('uses plural when counts > 1', () => {
    const md = formatThreadsAsMarkdown(doc, version, [thread(), thread()], NOW);
    expect(md).toContain('2 open threads · 2 comments');
  });

  it('renders a text-range anchor with selectorText and context', () => {
    const t = thread({
      anchor: {
        type: 'text-range',
        selectorText: 'the throughput should be 5000 tps',
        prefix: 'benchmarks show ',
        suffix: ' on the bridge',
        containerPath: 'body > p',
      },
    });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).toContain('**Anchored on:** "the throughput should be 5000 tps"');
    expect(md).toContain(
      '**Context:** "…benchmarks show the throughput should be 5000 tps on the bridge…"',
    );
  });

  it('renders a position-based text-range anchor without a Context line', () => {
    const t = thread({
      anchor: {
        type: 'text-range',
        selectorText: 'Hello World',
        start: 42,
        end: 53,
      },
    });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).toContain('**Anchored on:** "Hello World"');
    expect(md).not.toContain('**Context:**');
    expect(md).not.toContain('undefined');
  });

  it('renders an element-path anchor with innerText when present', () => {
    const t = thread({
      anchor: { type: 'element-path', path: 'body > div > h2:nth-of-type(1)', innerHash: 'abc', innerText: 'Performance' },
    });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).toContain('**Anchored on element:** "Performance"');
  });

  it('renders an element-path anchor falling back to CSS path when innerText is missing', () => {
    const t = thread({
      anchor: { type: 'element-path', path: 'body > div > h2:nth-of-type(1)', innerHash: 'abc' },
    });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).toContain('**Anchored on element:** `body > div > h2:nth-of-type(1)`');
  });

  it('marks resolved threads in the header', () => {
    const t = thread({ resolvedAt: '2026-05-20T11:00:00.000Z', resolvedBy: 'u2' });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).toContain('## Thread 1 — resolved');
    expect(md).toContain('0 open threads');
    expect(md).toContain('1 comment');
  });

  it('numbers threads in chronological order', () => {
    const t1 = thread({ createdAt: '2026-05-20T10:00:00.000Z', comments: [comment({ body: 'first' })] });
    const t2 = thread({ createdAt: '2026-05-20T11:00:00.000Z', comments: [comment({ body: 'second' })] });
    const md = formatThreadsAsMarkdown(doc, version, [t2, t1], NOW);
    const idx1 = md.indexOf('## Thread 1');
    const idx2 = md.indexOf('## Thread 2');
    const idxFirst = md.indexOf('first');
    const idxSecond = md.indexOf('second');
    expect(idx1).toBeLessThan(idx2);
    expect(idxFirst).toBeLessThan(idxSecond);
  });

  it('excludes tombstoned comments but keeps the thread if any survive', () => {
    const t = thread({
      comments: [
        comment({ body: 'kept', deletedAt: null }),
        comment({ body: 'gone', deletedAt: '2026-05-20T10:30:00.000Z' }),
      ],
    });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).toContain('kept');
    expect(md).not.toContain('gone');
    expect(md).toContain('1 comment');
  });

  it('omits threads whose every comment is tombstoned', () => {
    const t = thread({
      comments: [comment({ body: 'gone', deletedAt: '2026-05-20T10:30:00.000Z' })],
    });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).not.toContain('## Thread');
    expect(md).toContain('0 open threads · 0 comments');
  });

  it('marks edited comments', () => {
    const t = thread({
      comments: [comment({ body: 'fixed', updatedAt: '2026-05-20T11:00:00.000Z' })],
    });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).toContain('(edited)');
  });

  it('quotes multi-line bodies correctly', () => {
    const t = thread({ comments: [comment({ body: 'line one\nline two' })] });
    const md = formatThreadsAsMarkdown(doc, version, [t], NOW);
    expect(md).toContain('> line one');
    expect(md).toContain('> line two');
  });

  it('renders a meaningful document with zero threads', () => {
    const md = formatThreadsAsMarkdown(doc, version, [], NOW);
    expect(md).toContain('# Comments on "Agglayer DVN Paths" (v3)');
    expect(md).toContain('0 open threads · 0 comments');
    expect(md).not.toContain('## Thread');
  });
});

describe('commentsFilename', () => {
  it('produces a sluggified filename', () => {
    expect(commentsFilename({ title: 'Agglayer DVN Paths' }, { versionNumber: 3 })).toBe(
      'agglayer-dvn-paths-v3-comments.md',
    );
  });

  it('handles titles with special characters', () => {
    expect(commentsFilename({ title: "Carol's Notes (draft)" }, { versionNumber: 1 })).toBe(
      'carol-s-notes-draft-v1-comments.md',
    );
  });

  it('falls back to "document" for an empty slug', () => {
    expect(commentsFilename({ title: '!!!' }, { versionNumber: 2 })).toBe('document-v2-comments.md');
  });
});

describe('htmlFilename', () => {
  it('produces a sluggified filename ending in -v{n}.html', () => {
    expect(htmlFilename({ title: 'Agglayer DVN Paths' }, { versionNumber: 3 })).toBe(
      'agglayer-dvn-paths-v3.html',
    );
  });

  it('handles titles with special characters the same way commentsFilename does', () => {
    expect(htmlFilename({ title: "Carol's Notes (draft)" }, { versionNumber: 1 })).toBe(
      'carol-s-notes-draft-v1.html',
    );
  });

  it('falls back to "document" for an empty slug', () => {
    expect(htmlFilename({ title: '!!!' }, { versionNumber: 2 })).toBe('document-v2.html');
  });

  it('truncates long titles to 60 chars of slug before the suffix', () => {
    const longTitle = 'a'.repeat(120);
    const name = htmlFilename({ title: longTitle }, { versionNumber: 7 });
    expect(name).toBe(`${'a'.repeat(60)}-v7.html`);
  });

  it('uses the same slug as commentsFilename for the same title', () => {
    const title = 'Mixed CASE  with — punctuation!';
    const html = htmlFilename({ title }, { versionNumber: 4 });
    const md = commentsFilename({ title }, { versionNumber: 4 });
    const htmlSlug = html.replace(/-v4\.html$/, '');
    const mdSlug = md.replace(/-v4-comments\.md$/, '');
    expect(htmlSlug).toBe(mdSlug);
  });
});

describe('markdownFilename', () => {
  it('uses the shared slug rule with a -v{n}.md suffix', () => {
    expect(markdownFilename({ title: "Carol's Notes (draft)" }, { versionNumber: 4 })).toBe(
      'carol-s-notes-draft-v4.md',
    );
  });

  it('falls back to "document" for an empty slug', () => {
    expect(markdownFilename({ title: '!!!' }, { versionNumber: 1 })).toBe('document-v1.md');
  });
});
