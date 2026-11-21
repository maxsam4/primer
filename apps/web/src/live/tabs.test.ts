import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { addTab, deleteTab, readTabs, renameTab } from './tabs.ts';

/** Two peers that have synced once; changes then merge in both directions. */
function peers(): [Y.Doc, Y.Doc, () => void] {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  };
  return [a, b, sync];
}

describe('tabs', () => {
  it('concurrent add, rename and delete merge without duplicates or resurrection', () => {
    const [a, b, sync] = peers();
    const keep = addTab(a, 'Keep');
    const gone = addTab(a, 'Gone');
    sync();
    // A adds a tab and renames Keep while B deletes Gone.
    const added = addTab(a, 'Added');
    renameTab(a, keep.id, 'Kept');
    deleteTab(b, gone.id);
    sync();
    const titles = (doc: Y.Doc) => readTabs(doc).map((t) => t.title);
    expect(titles(a)).toEqual(titles(b));
    expect(titles(a)).toEqual(['', 'Kept', 'Added']);
    expect(readTabs(a).map((t) => t.id)).toContain(added.id);
  });
});
