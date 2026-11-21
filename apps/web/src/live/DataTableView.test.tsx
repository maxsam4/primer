// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import type { RecordDTO } from '@polygonlabs/primer-api-types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The document's shared records, as the server holds them.
const store = new Map<string, RecordDTO>();
const record = (recordId: string, data: Record<string, unknown>, version = 1): RecordDTO => ({
  collection: 'pipeline', recordId, scope: 'shared', data, version, updatedAt: '2026-11-20T00:00:00.000Z', updatedBy: 'u1', writtenBy: 'Ana',
});
store.set('acme', record('acme', { company: 'Acme', stage: 'Lead', value: 1200 }));
const calls: { path: string; body: Record<string, unknown> }[] = [];

vi.mock('../lib/fetch.ts', () => ({
  api: async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body });
    if (path.endsWith('/threads')) return new Response(JSON.stringify({ threads: [] }));
    if (path.endsWith('/records/list')) return new Response(JSON.stringify({ records: [...store.values()], nextCursor: null }));
    if (path.endsWith('/records/update')) {
      const current = store.get(body.recordId as string)!;
      if (current.version !== body.expectVersion) return new Response(JSON.stringify({ refusal: { code: 'record_conflict' } }), { status: 409 });
      const next = record(current.recordId, { ...current.data, ...(body.data as object) }, current.version + 1);
      store.set(next.recordId, next);
      return new Response(JSON.stringify({ record: next }));
    }
    return new Response('{}', { status: 404 });
  },
}));

// One event stream per document, as the browser would open it.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor() {
    FakeEventSource.last = this;
  }
  close() {}
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe('DataTableView', () => {
  it('editing a cell writes a record and other viewers refresh', async () => {
    const { DataTableView } = await import('./DataTableView.tsx');
    const columns = JSON.stringify([
      { key: 'company', label: 'Company', type: 'text' },
      { key: 'stage', label: 'Stage', type: 'select', options: ['Lead', 'Won'] },
      { key: 'value', label: 'Value', type: 'number' },
    ]);
    const view = (name: string) => {
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      const props = {
        doc: new Y.Doc(), documentId: 'd1', tabId: 'main', blockId: 'b1', canEdit: true, theme: 'light' as const,
        viewer: { id: name, isOwner: false, canComment: true, name },
        props: { collection: 'pipeline', columns, scope: 'shared' as const },
        canWrite: true,
        update: () => undefined,
      };
      return { host, root, render: () => act(async () => root.render(createElement(DataTableView, props))) };
    };
    const a = view('ana');
    const b = view('ben');
    await a.render();
    await b.render();
    await settle();
    const cell = (host: HTMLElement, column: string) => host.querySelector<HTMLTableCellElement>(`tr[data-record-id="acme"] td[data-column="${column}"]`)!;
    expect(cell(b.host, 'value').textContent).toBe('1200');

    // Ana edits a number cell: one update of that key, at the version she read.
    await act(async () => cell(a.host, 'value').click());
    const input = cell(a.host, 'value').querySelector('input')!;
    expect(input.type).toBe('number');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1500');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    const update = calls.find((c) => c.path === '/api/documents/d1/records/update')!;
    expect(update.body).toEqual({ collection: 'pipeline', scope: 'shared', recordId: 'acme', data: { value: 1500 }, expectVersion: 1 });
    expect(cell(a.host, 'value').textContent).toBe('1500');
    // The server never echoes Ana's own write, so the other table on the page reads again at once.
    expect(cell(b.host, 'value').textContent).toBe('1500');

    // Someone else's write reaches both through the coalesced data.changed for the collection.
    store.set('acme', record('acme', { company: 'Acme', stage: 'Lead', value: 1700 }, 3));
    const lists = calls.filter((c) => c.path.endsWith('/records/list')).length;
    await act(async () =>
      FakeEventSource.last!.onmessage!({ data: JSON.stringify({ namespace: 'primer', type: 'data.changed', payload: { collections: ['other'] } }) }),
    );
    expect(calls.filter((c) => c.path.endsWith('/records/list')).length).toBe(lists);
    await act(async () =>
      FakeEventSource.last!.onmessage!({ data: JSON.stringify({ namespace: 'primer', type: 'data.changed', payload: { collections: ['pipeline'] } }) }),
    );
    await settle();
    expect(cell(b.host, 'value').textContent).toBe('1700');

    await act(async () => a.root.unmount());
    await act(async () => b.root.unmount());
  });

  it('a query collection is read-only', async () => {
    const { DataTableView } = await import('./DataTableView.tsx');
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(DataTableView, {
          doc: new Y.Doc(), documentId: 'd1', tabId: 'main', blockId: 'b2', canEdit: true, theme: 'light',
          viewer: { id: 'ana', isOwner: true, canComment: true, name: 'ana' },
          props: { collection: 'query:weekly_signups', columns: '[]', scope: 'shared' },
          canWrite: true,
          update: () => undefined,
        }),
      ),
    );
    await settle();
    expect(host.querySelector('.primer-data-table-editable')).toBeNull();
    expect(host.textContent).toContain('Query results (read-only)');
    await act(async () => root.unmount());
  });
});
