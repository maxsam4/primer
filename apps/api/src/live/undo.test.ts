import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../app.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { comment, createLiveDoc, makeAgent, markdownOf, ops, paragraph, seedBlocks, until, versions } from './live.testlib.ts';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { claimRun, finishRun, requestRun } from './runs.ts';
import { undoRun } from './undo.ts';
import { decideSuggestion } from './suggest.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };
const main = (blockId: string) => ({ tabId: 'main', blockId });

const agents = new Map<string, AuthUser>();

async function run(documentId: string, agent: AuthUser, by: AuthUser = owner): Promise<string> {
  const out = await requestRun(by, documentId, {
    agentId: agent.id,
    request: { kind: 'send', prompt: `edit ${Math.random()}`, viewer: { tabId: 'main', selectedBlockIds: [], cursorBlockId: null } },
  });
  if (!out.ok) throw new Error(out.refusal.message);
  await claimRun(agent, out.value.id);
  agents.set(out.value.id, agent);
  return out.value.id;
}

/** Finishes the run (undo needs a stopped run), then undoes it as the owner. */
async function undo(runId: string) {
  await finishRun(agents.get(runId)!, runId, {});
  const out = await undoRun(runId, owner);
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

async function setup() {
  const agent = await makeAgent();
  const id = await createLiveDoc();
  await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta'), paragraph('c', 'Gamma'), paragraph('d', 'Delta')]);
  return { agent, id, runId: await run(id, agent) };
}

describe('undoRun', () => {
  it("undo removes the run's edits and keeps a person's later edit in another block", async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, {
      runId,
      ops: [
        { op: 'update', target: main('a'), block: 'Alpha by agent', expectVersion: v.a },
        { op: 'replaceRange', from: main('b'), to: main('c'), blocks: ['X\n\nY\n\nZ'], expectVersions: { b: v.b, c: v.c } },
      ],
    });
    // A person edits another block afterwards.
    await ops(id, owner, { ops: [{ op: 'update', target: main('d'), block: 'Delta by person', expectVersion: v.d }] });

    const result = await undo(runId);
    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta by person']);
  });

  it('undo of an add that moved existing blocks in puts them back', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, {
      runId,
      ops: [{ op: 'add', at: main('a'), position: 'before', blocks: [{ json: { type: 'paragraph', content: 'New', children: [{ existing: 'a' }, { existing: 'b' }] } }], expectVersions: { a: v.a, b: v.b } }],
    });
    expect(await markdownOf(id, agent)).toEqual(['New', 'Alpha', 'Beta', 'Gamma', 'Delta']);

    const result = await undo(runId);
    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(Object.keys(await versions(id, agent))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('undo after a restart works', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, { runId, ops: [{ op: 'update', target: main('b'), block: 'Beta by agent', expectVersion: v.b }] });

    // Drop the in-memory document (as a restart would), once its pending store is done.
    await until(async () => {
      const document = liveInstance().documents.get(liveDocName(id));
      if (document) await liveInstance().unloadDocument(document);
      return !liveInstance().documents.has(liveDocName(id));
    }, 10_000);

    await undo(runId);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  }, 15_000);

  it('a block changed since the run becomes a restore suggestion', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, {
      runId,
      ops: [
        { op: 'update', target: main('a'), block: 'Alpha by agent', expectVersion: v.a },
        { op: 'update', target: main('b'), block: 'Beta by agent', expectVersion: v.b },
      ],
    });
    const w = await versions(id, agent);
    await ops(id, owner, { ops: [{ op: 'update', target: main('b'), block: 'Beta by person', expectVersion: w.b }] });

    const result = await undo(runId);
    const byBlock = Object.fromEntries(result.outcomes.map((o) => [o.target.blockId, o]));
    expect(byBlock.a).toMatchObject({ status: 'applied' });
    expect(byBlock.b).toMatchObject({ status: 'suggested', suggestionId: expect.any(String) });
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta by person', 'Gamma', 'Delta']);

    // Accepting the restore puts the block back as it was before the run.
    expect(await decideSuggestion(byBlock.b!.suggestionId!, owner, 'accept')).toMatchObject({ ok: true });
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  it('blocks and fragments the run created are removed', async () => {
    const { agent, id, runId } = await setup();
    await ops(id, agent, {
      runId,
      ops: [
        { op: 'add', at: main('a'), position: 'after', blocks: ['- one\n  - nested\n- two'] },
        { op: 'add', at: main('d'), position: 'after', blocks: ['Tail'] },
      ],
    });
    expect((await markdownOf(id, agent)).length).toBe(8);

    await undo(runId);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  it("undo keeps a person's later edit inside a block the run created", async () => {
    const { agent, id, runId } = await setup();
    const added = await ops(id, agent, { runId, ops: [{ op: 'add', at: main('a'), position: 'after', blocks: ['- one\n  - nested'] }] });
    const one = added.outcomes[0]!.blocks![0]!.target.blockId;
    const v = await versions(id, agent);
    const nested = Object.keys(v).find((k) => !['a', 'b', 'c', 'd', one].includes(k))!;
    await ops(id, owner, { ops: [{ op: 'update', target: main(nested), block: '- nested, by a person', expectVersion: v[nested] }] });

    const result = await undo(runId);
    expect(result.outcomes[0]).toMatchObject({ status: 'suggested' });
    expect(await markdownOf(id, agent)).toContain('* nested, by a person');
  });

  it('undo of a delete puts the blocks back in place', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, {
      runId,
      ops: [
        { op: 'delete', target: main('b'), expectVersion: v.b },
        { op: 'delete', target: main('c'), expectVersion: v.c },
      ],
    });
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Delta']);

    await undo(runId);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(Object.keys(await versions(id, agent))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('undo of a move puts the block back', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, { runId, ops: [{ op: 'move', target: main('a'), at: main('c'), position: 'after', expectVersion: v.a }] });
    expect(await markdownOf(id, agent)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta']);

    await undo(runId);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  it('undo of a whole-tab replacement restores the blocks', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, {
      runId,
      ops: [{ op: 'replaceRange', from: main('a'), to: main('d'), blocks: ['Only'], expectVersions: { a: v.a, b: v.b, c: v.c, d: v.d } }],
    });
    expect(await markdownOf(id, agent)).toEqual(['Only']);

    const result = await undo(runId);
    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  it('undo leaves a block a comment was added to since the run', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, { runId, ops: [{ op: 'update', target: main('b'), block: 'Beta by agent', expectVersion: v.b }] });
    await comment(id, 'b', 'Beta by agent');

    // Like any block changed since, it becomes a restore suggestion, which
    // can't be accepted while the comment is on it.
    const result = await undo(runId);
    expect(result.outcomes[0]).toMatchObject({ status: 'suggested', suggestionId: expect.any(String) });
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta by agent', 'Gamma', 'Delta']);
    expect(await decideSuggestion(result.outcomes[0]!.suggestionId!, owner, 'accept')).toMatchObject({ ok: false });
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta by agent', 'Gamma', 'Delta']);
  });

  it('undo of a move leaves a block a person moved since', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, { runId, ops: [{ op: 'move', target: main('a'), at: main('c'), position: 'after', expectVersion: v.a }] });
    const w = await versions(id, agent);
    await ops(id, owner, { ops: [{ op: 'move', target: main('a'), at: main('d'), position: 'after', expectVersion: w.a }] });
    expect(await markdownOf(id, agent)).toEqual(['Beta', 'Gamma', 'Delta', 'Alpha']);

    const result = await undo(runId);
    expect(result.outcomes[0]).toMatchObject({ status: 'conflict', refusal: { code: 'target_changed' } });
    expect(await markdownOf(id, agent)).toEqual(['Beta', 'Gamma', 'Delta', 'Alpha']);
  });

  it("a requester demoted to commenter can't undo", async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha')]);
    await db.execute(sql`INSERT INTO users (id, email, display_name) VALUES ('collab-user', 'c@example.com', 'Collab') ON CONFLICT DO NOTHING`);
    await db.execute(sql`
      INSERT INTO document_collaborators (id, document_id, user_id, role, granted_by)
      VALUES (gen_random_uuid(), ${id}, 'collab-user', 'editor', 'mock-user-1'),
             (gen_random_uuid(), ${id}, ${agent.id}, 'editor', 'mock-user-1')
    `);
    const editor: AuthUser = { id: 'collab-user', email: 'c@example.com', displayName: 'Collab', kind: 'person', viaUserId: null };
    const runId = await run(id, agent, editor);
    const v = await versions(id, agent);
    await ops(id, agent, { runId, ops: [{ op: 'update', target: main('a'), block: 'Alpha by agent', expectVersion: v.a }] });

    // Undo waits for the run to stop.
    expect(await undoRun(runId, editor)).toMatchObject({ ok: false, status: 409 });
    await finishRun(agent, runId, {});

    await db.execute(sql`UPDATE document_collaborators SET role = 'commenter' WHERE document_id = ${id} AND user_id = 'collab-user'`);
    expect(await undoRun(runId, editor)).toMatchObject({ ok: false, status: 403 });
    expect(await markdownOf(id, agent)).toEqual(['Alpha by agent']);
  });
});
