// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { SuggestionDTO } from '@polygonlabs/primer-api-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let open = true;
const calls: string[] = [];
const suggestion: SuggestionDTO = {
  id: 's1', documentId: 'd1', authorId: 'a1', authorDisplayName: 'Claude (via Ana)', runId: null, changeSetId: null,
  status: 'open', conflict: false, stale: false, createdAt: '2026-11-19T10:00:00.000Z',
  edits: [{ kind: 'replace', target: { tabId: 'main', blockId: 'b1' }, current: { markdown: 'Ship on Friday' }, proposed: { markdown: 'Ship on Monday' }, place: null }],
};
vi.mock('../lib/fetch.ts', () => ({
  api: async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path.endsWith('/accept')) open = false;
    return new Response(JSON.stringify({ suggestions: open ? [suggestion] : [] }));
  },
}));

describe('SuggestionsPanel', () => {
  it('shows a suggestion as a diff and accepts it', async () => {
    const { SuggestionsPanel } = await import('./SuggestionsPanel.tsx');
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(createElement(SuggestionsPanel, { documentId: 'd1', tabId: 'main', canDecide: true })));
    expect(host.querySelector('del')?.textContent).toBe('Fri');
    expect(host.querySelector('ins')?.textContent).toBe('Mon');
    const accept = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Accept')!;
    await act(async () => accept.click());
    expect(calls).toContain('POST /api/suggestions/s1/accept');
    expect(host.textContent).toContain('No open suggestions.');
    await act(async () => root.unmount());
  });
});
