import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../app.ts';
import { createLiveDoc, paragraph, seedBlocks } from './live.testlib.ts';
import { applyPlan } from './pipeline.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { serverEditor } from './editor.ts';
import { getLiveDoc } from './read.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };
const main = (blockId: string) => ({ tabId: 'main', blockId });

async function read(id: string, opts: Parameters<typeof getLiveDoc>[2]) {
  const out = await getLiveDoc(id, owner, opts);
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

describe('getLiveDoc', () => {
  it('layout blocks have versions and are not reported deleted', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [
      {
        id: 'cols',
        type: 'columnList',
        children: [
          { id: 'c1', type: 'column', children: [paragraph('a', 'Left')] },
          { id: 'c2', type: 'column', children: [paragraph('b', 'Right')] },
        ],
      } as never,
    ]);
    const first = await read(id, { format: 'json' });
    expect(first.blocks.map((b) => b.target.blockId)).toEqual(['cols', 'c1', 'a', 'c2', 'b']);
    expect(first.blocks.every((b) => /^[0-9a-f]{16}$/.test(b.version))).toBe(true);

    const since = await read(id, { format: 'json', since: 0 });
    expect(since.deletedIds).toEqual([]);
  });

  it('json read returns ids, versions and flattened depth', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [
      paragraph('a', 'Alpha'),
      { id: 'l1', type: 'bulletListItem', content: 'One', children: [{ id: 'l2', type: 'bulletListItem', content: 'Two' }] },
    ]);

    const doc = await read(id, { format: 'json' });

    expect(doc.docVersion).toBeGreaterThan(0);
    expect(doc.blocks.map((b) => [b.target.blockId, b.depth, b.parentId])).toEqual([
      ['a', 0, null],
      ['l1', 0, null],
      ['l2', 1, 'l1'],
    ]);
    expect(doc.blocks.every((b) => /^[0-9a-f]{16}$/.test(b.version))).toBe(true);
    expect(doc.blocks[0]!.json).toMatchObject({ id: 'a', type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] });

    const md = await read(id, { format: 'markdown', range: { from: main('l1'), to: main('l2') } });
    expect(md.blocks.map((b) => b.markdown)).toEqual(['* One', '* Two']);
  });

  it('since returns only changed and deleted blocks', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta'), paragraph('c', 'Gamma')]);
    const before = await read(id, { format: 'markdown' });

    const schema = serverEditor().editor.pmSchema;
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        {
          target: main('b'),
          inverse: false,
          build: (tr, at) => {
            tr.insert(at!.pos + 2 + 'Beta'.length, schema.text(' edited'));
          },
        },
        {
          target: main('c'),
          inverse: false,
          build: (tr, at) => {
            tr.delete(at!.pos, at!.pos + at!.node.nodeSize);
          },
        },
      ],
    });

    const delta = await read(id, { format: 'markdown', since: before.docVersion });
    expect(delta.docVersion).toBeGreaterThan(before.docVersion);
    expect(delta.blocks.map((b) => [b.target.blockId, b.markdown])).toEqual([['b', 'Beta edited']]);
    expect(delta.deletedIds).toEqual(['c']);
  });
});
