import { describe, expect, it } from 'vitest';
import { draftOps, type DraftBlock } from './SuggestDraft.tsx';

const p = (id: string, text: string): DraftBlock => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] });

describe('draftOps', () => {
  it('turns a draft into updates, adds after the block before, and deletes', () => {
    const base = [p('a', 'Alpha'), p('b', 'Beta'), p('c', 'Gamma')];
    const draft = [p('a', 'Alpha, reworded'), p('b', 'Beta'), p('n1', 'New one'), p('n2', 'New two')];
    const versions = new Map([['a', 'va'], ['b', 'vb'], ['c', 'vc']]);
    const ops = draftOps(base, draft, versions, 'main');
    expect(ops.map((o) => o.op)).toEqual(['update', 'add', 'delete']);
    expect(ops[0]).toMatchObject({ target: { tabId: 'main', blockId: 'a' }, expectVersion: 'va' });
    expect(ops[1]).toMatchObject({ at: { blockId: 'b' }, position: 'after' });
    expect((ops[1] as { blocks: unknown[] }).blocks).toHaveLength(2);
    expect(ops[2]).toMatchObject({ target: { blockId: 'c' }, expectVersion: 'vc' });
    expect(draftOps(base, base, versions, 'main')).toEqual([]);
  });
});
