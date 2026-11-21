import * as Y from 'yjs';

/** A document's tab (the Y.Doc's `tabs` array; apps/api/src/live/reach.ts). */
export type Tab = { id: string; title: string };

export const MAIN_TAB = 'main';

/** The Y.XmlFragment a tab's content lives in. */
export function tabFragmentName(tabId: string): string {
  return tabId === MAIN_TAB ? 'document-store' : `tab/${tabId}`;
}

/** The tabs in order, `main` first, read as the server reads them. */
export function readTabs(doc: Y.Doc): Tab[] {
  const tabs: Tab[] = [{ id: MAIN_TAB, title: '' }];
  const seen = new Set([MAIN_TAB]);
  for (const entry of doc.getArray<unknown>('tabs').toArray()) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, title } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || typeof title !== 'string') continue;
    if (id === MAIN_TAB) tabs[0] = { id, title: title.slice(0, 200) };
    else if (!seen.has(id)) {
      seen.add(id);
      tabs.push({ id, title: title.slice(0, 200) });
    }
  }
  return tabs;
}

// Each change touches only its own entry of the shared array, so concurrent
// adds, renames and deletes by different people merge instead of one person's
// whole-list rewrite resurrecting or duplicating the other's tabs.

const idOf = (entry: unknown): unknown => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined);

export function addTab(doc: Y.Doc, title: string): Tab {
  const tab = { id: crypto.randomUUID(), title };
  doc.getArray<Tab>('tabs').push([tab]);
  return tab;
}

export function renameTab(doc: Y.Doc, id: string, title: string): void {
  const array = doc.getArray<unknown>('tabs');
  const at = array.toArray().findIndex((entry) => idOf(entry) === id);
  doc.transact(() => {
    if (at === -1) {
      // `main` has no entry until it is first renamed.
      if (id === MAIN_TAB) array.push([{ id, title }]);
      return;
    }
    array.delete(at, 1);
    array.insert(at, [{ id, title }]);
  });
}

/** Deletes a tab (never `main`). Its content stays in the Y.Doc, unreachable. */
export function deleteTab(doc: Y.Doc, id: string): void {
  if (id === MAIN_TAB) return;
  const array = doc.getArray<unknown>('tabs');
  doc.transact(() => {
    for (let i = array.length - 1; i >= 0; i--) if (idOf(array.get(i)) === id) array.delete(i, 1);
  });
}
