// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as Y from 'yjs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { BlockNoteEditor } from '@blocknote/core';
import { blocksToYXmlFragment } from '@blocknote/core/yjs';
import { primerSchema } from '@primer/blocks';
import type { LiveProvider } from './provider.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The editor's block services follow the document's event stream; jsdom has no EventSource.
vi.stubGlobal('EventSource', class { close() {} });

// A provider that never connects, over a document that already holds a
// heading: the editor must show what the Y.Doc holds.
vi.mock('./provider.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./provider.ts')>()),
  createLiveProvider: (documentId: string): LiveProvider => {
    const doc = new Y.Doc();
    const seed = BlockNoteEditor.create({ schema: primerSchema });
    blocksToYXmlFragment(seed, [{ type: 'heading', content: 'Seeded from the Y.Doc' }] as never, doc.getXmlFragment('document-store'));
    blocksToYXmlFragment(seed, [{ type: 'paragraph', content: 'Notes tab text' }] as never, doc.getXmlFragment('tab/notes'));
    doc.getArray('tabs').push([{ id: 'main', title: '' }, { id: 'notes', title: 'Notes' }]);
    const provider = new HocuspocusProvider({
      websocketProvider: new HocuspocusProviderWebsocket({ url: 'ws://127.0.0.1:9/collab', autoConnect: false }),
      name: `doc:${documentId}`,
      document: doc,
    });
    return { provider, doc, destroy: () => provider.destroy() };
  },
}));

// jsdom lacks these; BlockNote's menus measure the page.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
})) as unknown as typeof window.matchMedia;

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, node)));
  return host;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(check()).toBe(true);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  vi.useRealTimers();
});

describe('LiveEditor', () => {
  it('live document renders the editor and legacy renders the iframe', async () => {
    const { DocumentSurface } = await import('../routes/document.tsx');
    const frame = () => createElement('iframe', { title: 'legacy-frame' });
    const props = { documentId: 'doc-1', readOnly: false, canVote: true, theme: 'light' as const, userName: 'Ana', userId: 'u-ana', role: 'owner' as const, frame };

    const live = await render(createElement(DocumentSurface, { ...props, live: true }));
    await until(() => live.querySelector('[contenteditable="true"].bn-editor')?.textContent?.includes('Seeded from the Y.Doc') === true);
    expect(live.querySelector('iframe[title="legacy-frame"]')).toBeNull();
    expect(live.textContent).toContain('History');
    // Each tab opens its own fragment.
    const notes = live.querySelector<HTMLButtonElement>('[role="tab"][data-tab-id="notes"]')!;
    expect(notes.textContent).toBe('Notes');
    await act(async () => notes.click());
    await until(() => live.querySelector('.bn-editor')?.textContent?.includes('Notes tab text') === true);
    expect(live.querySelector('.bn-editor')!.textContent).not.toContain('Seeded from the Y.Doc');
    await act(async () => root!.unmount());

    const legacy = await render(createElement(DocumentSurface, { ...props, live: false }));
    expect(legacy.querySelector('iframe[title="legacy-frame"]')).not.toBeNull();
    expect(legacy.querySelector('.bn-editor')).toBeNull();
  });

  it('one editor surface: one toolbar, each panel toggle once, in order', async () => {
    const { DocumentSurface } = await import('../routes/document.tsx');
    const props = { documentId: 'doc-1', readOnly: false, canVote: true, userName: 'Ana', userId: 'u-ana', role: 'owner' as const, frame: () => null, live: true, theme: 'light' as const };
    const live = await render(createElement(DocumentSurface, props));
    await until(() => live.querySelector('.bn-editor') !== null);
    const toggles = [...live.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent);
    expect(toggles).toEqual(['Comments', 'Suggestions', 'Decisions', 'Changes since checkpoint', 'History']);
    expect(live.querySelectorAll('[data-live-editor]')).toHaveLength(1);
    expect(live.querySelectorAll('.bn-editor')).toHaveLength(1);
  });

  it('editor uses the dark theme when Primer is dark', async () => {
    const { DocumentSurface } = await import('../routes/document.tsx');
    const props = { documentId: 'doc-1', readOnly: false, canVote: true, userName: 'Ana', userId: 'u-ana', role: 'owner' as const, frame: () => null, live: true };
    const dark = await render(createElement(DocumentSurface, { ...props, theme: 'dark' as const }));
    await until(() => dark.querySelector('.bn-editor') !== null);
    expect(dark.querySelector('.bn-container')!.getAttribute('data-color-scheme')).toBe('dark');
    await act(async () => root!.unmount());
    const light = await render(createElement(DocumentSurface, { ...props, theme: 'light' as const }));
    await until(() => light.querySelector('.bn-editor') !== null);
    expect(light.querySelector('.bn-container')!.getAttribute('data-color-scheme')).toBe('light');
  });

  it('connection indicator shows reconnecting, unsaved and save-failed states', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { ConnectionStatus } = await import('./ConnectionStatus.tsx');
    const handlers = new Map<string, ((data: never) => void)[]>();
    const connect = vi.fn();
    const provider = {
      on: (event: string, fn: (data: never) => void) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
      off: () => undefined,
      connect,
    };
    const emit = (event: string, data: unknown) => act(() => handlers.get(event)!.forEach((fn) => fn(data as never)));
    const el = await render(createElement(ConnectionStatus, { provider: provider as never }));
    const shown = () => el.querySelector('[role="status"]')?.getAttribute('data-connection') ?? 'ok';

    expect(shown()).toBe('reconnecting');
    await emit('status', { status: 'connected' });
    expect(shown()).toBe('ok');
    expect(el.textContent).toContain('Live');

    // Unacknowledged changes are only "unsaved" after five seconds.
    await emit('unsyncedChanges', { number: 2 });
    expect(shown()).toBe('ok');
    await act(async () => vi.advanceTimersByTime(5_100));
    expect(shown()).toBe('unsaved');
    expect(el.textContent).toContain('Unsaved changes');
    await emit('unsyncedChanges', { number: 0 });
    expect(shown()).toBe('ok');

    await emit('status', { status: 'disconnected' });
    expect(el.textContent).toContain('Reconnecting…');
    // Down for more than ten seconds: offline, not a blip.
    await act(async () => vi.advanceTimersByTime(10_100));
    expect(shown()).toBe('offline');

    // The server couldn't store an update: say so, and offer to retry.
    await emit('close', { event: { code: 4500 } });
    expect(shown()).toBe('save-failed');
    expect(el.textContent).toContain('Changes not saved');
    const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => retry.click());
    expect(connect).toHaveBeenCalled();
    expect(shown()).toBe('reconnecting');
  });
});
