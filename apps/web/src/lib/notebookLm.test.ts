// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ThreadDTO, CommentDTO } from '@polygonlabs/primer-api-types';
import {
  buildNotebookLmSource,
  countLiveComments,
  countWords,
  htmlToSourceMarkdown,
} from './notebookLm.ts';

const NOW = new Date('2026-11-18T12:00:00Z');

function comment(over: Partial<CommentDTO> = {}): CommentDTO {
  return {
    id: 'c-1',
    threadId: 't-1',
    authorId: 'u1',
    authorDisplayName: 'Mock Reviewer',
    body: 'Why not sponsor gas per app?',
    createdAt: '2026-11-17T10:00:00.000Z',
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
    anchor: { type: 'text-range', selectorText: 'paymaster', containerPath: 'body > p' },
    contextChanged: false,
    resolvedAt: null,
    resolvedBy: null,
    resolvedByDisplayName: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    comments: [comment()],
    ...over,
  };
}

describe('htmlToSourceMarkdown', () => {
  it('returns an empty string for empty input', () => {
    expect(htmlToSourceMarkdown('')).toBe('');
    expect(htmlToSourceMarkdown('   ')).toBe('');
  });

  it('separates paragraphs with a blank line and collapses whitespace', () => {
    expect(htmlToSourceMarkdown('<p>First\n   line.</p><p>Second.</p>')).toBe(
      'First line.\n\nSecond.',
    );
  });

  it('shifts headings down one level under the title', () => {
    expect(htmlToSourceMarkdown('<h1>Overview</h1><p>Body.</p><h2>Risks</h2>')).toBe(
      '## Overview\n\nBody.\n\n### Risks',
    );
  });

  it('caps heading depth at six', () => {
    expect(htmlToSourceMarkdown('<h6>Deep</h6>')).toBe('###### Deep');
  });

  it('renders unordered and ordered lists with markers', () => {
    expect(htmlToSourceMarkdown('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n- Two');
    expect(htmlToSourceMarkdown('<ol start="3"><li>C</li><li>D</li></ol>')).toBe('3. C\n4. D');
  });

  it('indents nested lists', () => {
    const html = '<ul><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ul>';
    expect(htmlToSourceMarkdown(html)).toBe('- Parent\n  - Child\n- Next');
  });

  it('keeps paragraphs inside list items on the marker line', () => {
    const html = '<ol><li><p>First point.</p></li><li><p>Second point.</p></li></ol>';
    expect(htmlToSourceMarkdown(html)).toBe('1. First point.\n2. Second point.');
  });

  it('spaces a top-level list from the paragraphs around it', () => {
    expect(htmlToSourceMarkdown('<p>Intro:</p><ul><li>A</li></ul><p>Outro.</p>')).toBe(
      'Intro:\n\n- A\n\nOutro.',
    );
  });

  it('keeps list items on one line when the markup is indented', () => {
    const html = '<ul>\n  <li>\n    Spaced item\n  </li>\n</ul>';
    expect(htmlToSourceMarkdown(html)).toBe('- Spaced item');
  });

  it('renders tables as pipe rows with a header separator', () => {
    const html =
      '<table><tr><th>Chain</th><th>Cost</th></tr><tr><td>PoS</td><td>$0.01</td></tr></table>';
    expect(htmlToSourceMarkdown(html)).toBe('| Chain | Cost |\n| --- | --- |\n| PoS | $0.01 |');
  });

  it('pads ragged table rows and escapes pipes in cells', () => {
    const html = '<table><tr><td>a|b</td><td>c</td></tr><tr><td>d</td></tr></table>';
    expect(htmlToSourceMarkdown(html)).toBe('| a\\|b | c |\n| --- | --- |\n| d | |');
  });

  it('escapes backslashes in cells so a "\\|" stays inside its cell', () => {
    const html = '<table><tr><td>C:\\dir\\|x</td><td>y</td></tr></table>';
    expect(htmlToSourceMarkdown(html)).toBe('| C:\\\\dir\\\\\\|x | y |\n| --- | --- |');
  });

  it('fences preformatted code and keeps its indentation', () => {
    const html = '<pre><code>fn main() {\n    run();\n}</code></pre>';
    expect(htmlToSourceMarkdown(html)).toBe('```\nfn main() {\n    run();\n}\n```');
  });

  it('drops scripts, styles and noscript blocks', () => {
    const html =
      '<p>before</p><script>var x = 1</script><style>p{}</style><noscript>enable JS</noscript><p>after</p>';
    expect(htmlToSourceMarkdown(html)).toBe('before\n\nafter');
  });

  it('marks diagrams, keeping an accessible label when present', () => {
    expect(htmlToSourceMarkdown('<svg><g><text>x</text></g></svg>')).toBe('[diagram]');
    expect(htmlToSourceMarkdown('<svg><title>Flow of funds</title></svg>')).toBe(
      '[diagram: Flow of funds]',
    );
    expect(htmlToSourceMarkdown('<svg aria-label="Sequence"></svg>')).toBe('[diagram: Sequence]');
  });

  it('keeps image alt text and skips images without it', () => {
    expect(htmlToSourceMarkdown('<p>See <img alt="architecture"> and <img src="x.png"></p>')).toBe(
      'See [image: architecture] and',
    );
  });

  it('turns <hr> into a Markdown rule', () => {
    expect(htmlToSourceMarkdown('<p>A</p><hr><p>B</p>')).toBe('A\n\n---\n\nB');
  });
});

describe('buildNotebookLmSource', () => {
  const base = {
    title: 'Fixing the Wallet Gas Sponsorship Bottleneck',
    description: 'Proposal for a shared paymaster.',
    url: 'https://primer.example/d/doc-1/v/2',
    versionNumber: 2,
    html: '<h1>Problem</h1><p>Every app runs its own paymaster.</p>',
    now: NOW,
  };

  it('puts title, description and provenance before the body', () => {
    expect(buildNotebookLmSource(base)).toBe(
      [
        '# Fixing the Wallet Gas Sponsorship Bottleneck',
        'Proposal for a shared paymaster.',
        'Source: https://primer.example/d/doc-1/v/2 (version 2, exported 2026-11-18)',
        '---',
        '## Problem\n\nEvery app runs its own paymaster.',
      ].join('\n\n') + '\n',
    );
  });

  it('omits an empty description', () => {
    const out = buildNotebookLmSource({ ...base, description: '  ' });
    expect(out).toMatch(/^# Fixing the Wallet Gas Sponsorship Bottleneck\n\nSource: /);
  });

  it('appends comment threads when there are live comments', () => {
    const out = buildNotebookLmSource({ ...base, threads: [thread()] });
    expect(out).toContain('# Comments on "Fixing the Wallet Gas Sponsorship Bottleneck" (v2)');
    expect(out).toContain('> Why not sponsor gas per app?');
  });

  it('leaves the comments section out when every comment is deleted', () => {
    const deleted = thread({ comments: [comment({ deletedAt: '2026-11-17T11:00:00.000Z' })] });
    expect(buildNotebookLmSource({ ...base, threads: [deleted] })).not.toContain('Comments on');
  });
});

describe('countLiveComments', () => {
  it('counts comments that are not deleted across threads', () => {
    const threads = [
      thread({ comments: [comment(), comment({ deletedAt: '2026-11-17T11:00:00.000Z' })] }),
      thread({ id: 't-2', comments: [comment(), comment()] }),
    ];
    expect(countLiveComments(threads)).toBe(3);
  });
});

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('  one two\nthree  ')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});
