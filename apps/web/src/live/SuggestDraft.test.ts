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

describe('draftOps keeps structure', () => {
  const versions = new Map([['a', 'va'], ['b', 'vb'], ['c', 'vc'], ['x', 'vx']]);
  const at = (blockId: string) => ({ tabId: 'main', blockId });
  const nest = (block: DraftBlock, ...children: DraftBlock[]): DraftBlock => ({ ...block, children });
  const a = p('a', 'Alpha');
  const b = p('b', 'Beta');
  const c = p('c', 'Gamma');
  const x = p('x', 'Child');
  const n = p('n', 'New');

  it('a reorder is a move after the block now before it', () => {
    expect(draftOps([a, b], [b, a], versions, 'main')).toEqual([{ op: 'move', target: at('a'), at: at('b'), position: 'after', expectVersion: 'va' }]);
  });

  it('blocks dragged to the top are placed before a block that stays', () => {
    const d = p('d', 'Delta');
    const v = new Map([...versions, ['d', 'vd']]);
    expect(draftOps([a, b, c, d], [d, c, a, b], v, 'main')).toEqual([
      { op: 'move', target: at('d'), at: at('a'), position: 'before', expectVersion: 'vd' },
      { op: 'move', target: at('c'), at: at('d'), position: 'after', expectVersion: 'vc' },
    ]);
  });

  it('an indent moves the block to be the first child of its new parent', () => {
    expect(draftOps([a, b, c], [nest(a, b), c], versions, 'main')).toEqual([
      { op: 'move', target: at('b'), at: at('a'), position: 'firstChild', expectVersion: 'vb' },
    ]);
  });

  it('an outdent moves the child after its old parent', () => {
    expect(draftOps([nest(a, b), c], [a, b, c], versions, 'main')).toEqual([{ op: 'move', target: at('b'), at: at('a'), position: 'after', expectVersion: 'vb' }]);
  });

  it('a new child goes under its parent, and a new block after a nested one stays at its level', () => {
    expect(draftOps([a, b], [nest(a, n), b], versions, 'main')).toEqual([
      { op: 'add', at: at('a'), position: 'firstChild', blocks: [{ json: { type: 'paragraph', props: {}, content: n.content, children: [] } }] },
    ]);
    expect(draftOps([nest(a, x)], [nest(a, x, n)], versions, 'main')).toMatchObject([{ op: 'add', at: at('x'), position: 'after' }]);
    expect(draftOps([nest(a, x), b], [nest(a, x), n, b], versions, 'main')).toMatchObject([{ op: 'add', at: at('a'), position: 'after' }]);
  });

  it('adds and deletes around blocks are not moves', () => {
    expect(draftOps([a, b, c], [a, n, c], versions, 'main').map((o) => o.op)).toEqual(['add', 'delete']);
    expect(draftOps([a, b, c], [n, b, a], versions, 'main')).toMatchObject([
      { op: 'add', at: at('b'), position: 'before' },
      { op: 'move', target: at('a'), at: at('b'), position: 'after' },
      { op: 'delete', target: at('c') },
    ]);
  });
});
