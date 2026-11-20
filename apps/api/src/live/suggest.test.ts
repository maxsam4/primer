import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { AuthUser } from '../app.ts';
import { createApp } from '../app.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { asUserJson } from '../test/harness.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { createLiveDoc, makeAgent, markdownOf, ops, paragraph, seedBlocks, until, versions } from './live.testlib.ts';
import { decideSuggestion, listSuggestions } from './suggest.ts';
import { claimRun, finishRun, requestRun } from './runs.ts';
import { undoRun } from './undo.ts';
import { createCheckpoint, restoreCheckpoint } from './checkpoint.ts';
import { publishDocument } from '../lib/publish.ts';
import { versions as versionsTable } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };
const main = (blockId: string) => ({ tabId: 'main', blockId });

async function person(id: string): Promise<AuthUser> {
  await db.execute(sql`INSERT INTO users (id, email, display_name) VALUES (${id}, ${`${id}@example.com`}, ${id}) ON CONFLICT DO NOTHING`);
  return { id, email: `${id}@example.com`, displayName: id, kind: 'person', viaUserId: null };
}

async function grant(documentId: string, userId: string, role: 'editor' | 'commenter') {
  await db.execute(sql`
    INSERT INTO document_collaborators (id, document_id, user_id, role, granted_by)
    VALUES (gen_random_uuid(), ${documentId}, ${userId}, ${role}, 'mock-user-1')
  `);
}

/** A document owned by mock-user-1, and an editor's agent on it: someone
 *  else's document for the agent, so it suggests (agent mode `auto`). */
async function setup() {
  const editor = await person('collab-editor');
  const agent = await makeAgent(editor.id);
  const id = await createLiveDoc();
  await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta'), paragraph('c', 'Gamma')]);
  await grant(id, editor.id, 'editor');
  return { id, agent, editor };
}

async function open(documentId: string, actor: AuthUser = owner) {
  const out = await listSuggestions(actor, documentId);
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

describe('suggestions', () => {
  it("agent on someone else's document produces suggestions, not edits", async () => {
    const { id, agent } = await setup();
    const v = await versions(id, agent);
    const result = await ops(id, agent, {
      ops: [
        { op: 'update', target: main('a'), block: 'Alpha, reworded', expectVersion: v.a },
        { op: 'delete', target: main('c'), expectVersion: v.c },
      ],
    });
    expect(result.outcomes.map((o) => o.status)).toEqual(['suggested', 'suggested']);
    expect(await markdownOf(id, owner)).toEqual(['Alpha', 'Beta', 'Gamma']);

    // The owner sees each with the block now and as proposed.
    const list = await open(id);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ authorId: agent.id, conflict: false, stale: false });
    expect(list[0]!.edits[0]).toMatchObject({ kind: 'replace', current: { markdown: 'Alpha' }, proposed: { markdown: 'Alpha, reworded' } });
    expect(list[1]!.edits[0]).toMatchObject({ kind: 'delete', current: { markdown: 'Gamma' }, proposed: null });
    // The same suggestions reach an agent fenced, without JSON.
    const fenced = await open(id, agent);
    expect(fenced[0]!.edits[0]!.proposed!.markdown).toMatch(/^<(untrusted-content-[0-9a-f]{16})>\nAlpha, reworded\n<\/\1>$/);

    expect(await decideSuggestion(list[0]!.id, owner, 'accept')).toMatchObject({ ok: true, value: { outcomes: [{ status: 'applied' }] } });
    expect(await decideSuggestion(list[1]!.id, owner, 'reject')).toMatchObject({ ok: true });
    expect(await markdownOf(id, owner)).toEqual(['Alpha, reworded', 'Beta', 'Gamma']);
    expect(await open(id)).toEqual([]);
  });

  it('a person suggests with mode suggest: the owner as well as a commenter, who may not edit', async () => {
    const { id } = await setup();
    const commenter = await person('collab-commenter');
    await grant(id, commenter.id, 'commenter');
    const v = await versions(id, owner);
    await expect(ops(id, commenter, { ops: [{ op: 'update', target: main('b'), block: 'Beta, edited', expectVersion: v.b }] })).rejects.toThrow(/forbidden/);
    const mine = await ops(id, owner, { mode: 'suggest', ops: [{ op: 'update', target: main('a'), block: 'Alpha, suggested', expectVersion: v.a }] });
    const theirs = await ops(id, commenter, { mode: 'suggest', ops: [{ op: 'update', target: main('b'), block: 'Beta, suggested', expectVersion: v.b }] });
    expect([mine.outcomes[0]!.status, theirs.outcomes[0]!.status]).toEqual(['suggested', 'suggested']);
    expect(await markdownOf(id, owner)).toEqual(['Alpha', 'Beta', 'Gamma']);
    const list = await open(id);
    expect(list.map((s) => s.authorId).sort()).toEqual([commenter.id, owner.id].sort());
    const fromCommenter = list.find((s) => s.authorId === commenter.id)!;
    expect(await decideSuggestion(fromCommenter.id, owner, 'accept')).toMatchObject({ ok: true });
    expect(await markdownOf(id, owner)).toEqual(['Alpha', 'Beta, suggested', 'Gamma']);
  });

  it('an agent in suggest mode gets suggestions, not direct edits, from apply_ops', async () => {
    const { id, agent } = await setup();
    const v = await versions(id, agent);
    const out = await ops(id, agent, { ops: [{ op: 'move', target: main('a'), at: main('c'), position: 'after', expectVersion: v.a }] });
    expect(out.outcomes[0]).toMatchObject({ status: 'suggested' });
    expect(await markdownOf(id, owner)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('an agent in suggest mode gets suggestions, not direct edits, from undo-run', async () => {
    const { id, agent, editor } = await setup();
    await db.execute(sql`UPDATE documents SET agent_mode = 'edit' WHERE id = ${id}`);
    const asked = await requestRun(editor, id, {
      agentId: agent.id,
      request: { kind: 'send', prompt: 'edit', viewer: { tabId: 'main', selectedBlockIds: [], cursorBlockId: null } },
    });
    if (!asked.ok) throw new Error(asked.refusal.message);
    await claimRun(agent, asked.value.id);
    const v = await versions(id, agent);
    await ops(id, agent, { runId: asked.value.id, ops: [{ op: 'update', target: main('a'), block: 'Alpha by agent', expectVersion: v.a }] });
    await finishRun(agent, asked.value.id, {});

    // Back to suggest mode: the agent's undo is only a suggestion.
    await db.execute(sql`UPDATE documents SET agent_mode = 'suggest' WHERE id = ${id}`);
    const undone = await undoRun(asked.value.id, agent);
    expect(undone).toMatchObject({ ok: true, value: { outcomes: [{ status: 'suggested' }] } });
    expect(await markdownOf(id, owner)).toEqual(['Alpha by agent', 'Beta', 'Gamma']);
  });

  it('an agent in suggest mode gets suggestions, not direct edits, from a checkpoint restore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-suggest-'));
    try {
      const storage = new FilesystemStorage(root);
      const { id, agent } = await setup();
      const checkpoint = await createCheckpoint(storage, id, owner, null);
      const v = await versions(id, owner);
      await ops(id, owner, { ops: [{ op: 'update', target: main('b'), block: 'Beta, later', expectVersion: v.b }] });

      const [row] = await db.select({ bundleKey: versionsTable.bundleKey }).from(versionsTable).where(eq(versionsTable.id, checkpoint.versionId));
      const restored = await restoreCheckpoint(storage, { documentId: id, bundleKey: row!.bundleKey! }, agent);
      expect(restored.outcomes.map((o) => o.status)).toEqual(['suggested']);
      expect(await markdownOf(id, owner)).toEqual(['Alpha', 'Beta, later', 'Gamma']);
      expect((await open(id))[0]!.edits).toMatchObject([{ kind: 'replace', proposed: { markdown: 'Beta' } }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an agent in suggest mode republishing creates suggestions only, with no new version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-suggest-'));
    try {
      const storage = new FilesystemStorage(root);
      const md = (source: string) => ({ content: new TextEncoder().encode(source), filename: 'doc.md', format: 'markdown' as const });
      const first = await publishDocument(storage, { actor: owner, title: 'Doc', ...md('The quarterly numbers grew in every region we track.\n\nBeta.\n') });
      if (!first.ok) throw new Error(first.refusal.message);
      const editor = await person('collab-editor');
      const agent = await makeAgent(editor.id);
      await grant(first.documentId, editor.id, 'editor');

      const out = await publishDocument(storage, { actor: agent, documentId: first.documentId, ...md('The quarterly numbers grew in nearly every region we track.\n\nBeta.\n\nGamma is new.\n') });
      if (!out.ok) throw new Error(out.refusal.message);
      expect(out.versionId).toBeUndefined();
      expect(out.versionNumber).toBeUndefined();
      expect(out.reconciliation!.outcomes.map((o) => o.status)).toEqual(['suggested', 'suggested']);

      // The live document and its published versions are as they were; the
      // changes wait as suggestions, and no original was stored.
      expect(await markdownOf(first.documentId, owner)).toEqual(['The quarterly numbers grew in every region we track.', 'Beta.']);
      const rows = await db.select({ n: versionsTable.versionNumber }).from(versionsTable).where(eq(versionsTable.documentId, first.documentId));
      expect(rows.map((r) => r.n)).toEqual([1]);
      expect((await readdir(join(root, 'v1'))).filter((f) => f.endsWith('.orig'))).toHaveLength(1);
      expect((await open(first.documentId)).flatMap((s) => s.edits.map((e) => e.kind)).sort()).toEqual(['insert', 'replace']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a batch that only suggests is charged nothing against its run's budget", async () => {
    const { id, agent, editor } = await setup();
    await seedBlocks(id, Array.from({ length: 25 }, (_, k) => paragraph(`p${k}`, `Para ${k}`)));
    const asked = await requestRun(editor, id, {
      agentId: agent.id,
      request: { kind: 'send', prompt: 'trim', viewer: { tabId: 'main', selectedBlockIds: [], cursorBlockId: null } },
    });
    if (!asked.ok) throw new Error(asked.refusal.message);
    await claimRun(agent, asked.value.id);
    const v = await versions(id, agent);
    // More removals than a run may make without an approved plan.
    const out = await ops(id, agent, {
      runId: asked.value.id,
      ops: Array.from({ length: 24 }, (_, k) => ({ op: 'delete', target: main(`p${k}`), expectVersion: v[`p${k}`] })),
    });
    expect(out.outcomes.every((o) => o.status === 'suggested')).toBe(true);
    const [run] = (await db.execute(sql`SELECT edits_applied AS e, blocks_removed AS r FROM agent_runs WHERE id = ${asked.value.id}`)) as unknown as { e: number; r: number }[];
    expect(run).toEqual({ e: 0, r: 0 });
  });

  it('owner flips agent mode to edit', async () => {
    const { id, agent, editor } = await setup();
    const app = createApp({ storage: new FilesystemStorage('/nonexistent-primer-test'), notifier: new NoopNotifier(), userResolver: mockMultiResolver });
    const patch = (userId: string, agentMode: string) =>
      app.request(`/api/documents/${id}`, { method: 'PATCH', headers: asUserJson(userId), body: JSON.stringify({ agentMode }) });

    // An editor can't; the owner can.
    expect((await patch(editor.id, 'edit')).status).toBe(403);
    const res = await patch(owner.id, 'edit');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agentMode: 'edit' });

    const v = await versions(id, agent);
    const result = await ops(id, agent, { ops: [{ op: 'update', target: main('b'), block: 'Beta, edited', expectVersion: v.b }] });
    expect(result.outcomes[0]!.status).toBe('applied');
    expect(await markdownOf(id, owner)).toEqual(['Alpha', 'Beta, edited', 'Gamma']);

    // `suggest` makes even the owner's own agent suggest.
    expect((await patch(owner.id, 'suggest')).status).toBe(200);
    const own = await makeAgent(owner.id);
    const w = await versions(id, own);
    expect((await ops(id, own, { ops: [{ op: 'update', target: main('c'), block: 'No', expectVersion: w.c }] })).outcomes[0]!.status).toBe('suggested');
  });

  it('agent withdraws its own suggestion and cannot accept or reject any', async () => {
    const { id, agent } = await setup();
    const other = await makeAgent((await person('collab-two')).id);
    await grant(id, other.viaUserId!, 'editor');
    const v = await versions(id, agent);
    const mine = (await ops(id, agent, { ops: [{ op: 'update', target: main('a'), block: 'Mine', expectVersion: v.a }] })).outcomes[0]!.suggestionId!;
    const theirs = (await ops(id, other, { ops: [{ op: 'update', target: main('b'), block: 'Theirs', expectVersion: v.b }] })).outcomes[0]!.suggestionId!;

    for (const decision of ['accept', 'reject'] as const) {
      expect(await decideSuggestion(mine, agent, decision)).toMatchObject({ ok: false, status: 403, refusal: { code: 'forbidden' } });
      expect(await decideSuggestion(theirs, agent, decision)).toMatchObject({ ok: false, status: 403 });
    }
    expect(await decideSuggestion(theirs, agent, 'withdraw')).toMatchObject({ ok: false, status: 403 });
    expect(await decideSuggestion(mine, agent, 'withdraw')).toMatchObject({ ok: true });
    expect(await decideSuggestion(mine, agent, 'withdraw')).toMatchObject({ ok: false, status: 409, refusal: { code: 'suggestion_closed' } });
    expect((await open(id)).map((s) => s.id)).toEqual([theirs]);
    expect(await markdownOf(id, owner)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('suggestions survive a server restart', async () => {
    const { id, agent } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, { ops: [{ op: 'add', at: main('c'), position: 'after', blocks: ['- one\n  - nested'] }] });
    await ops(id, agent, { ops: [{ op: 'move', target: main('a'), at: main('c'), position: 'after', expectVersion: v.a }] });

    await until(async () => {
      const document = liveInstance().documents.get(liveDocName(id));
      if (document) await liveInstance().unloadDocument(document);
      return !liveInstance().documents.has(liveDocName(id));
    }, 10_000);

    const list = await open(id);
    expect(list.map((s) => s.edits.map((e) => e.kind))).toEqual([['insert'], ['move']]);
    for (const s of list) expect(await decideSuggestion(s.id, owner, 'accept')).toMatchObject({ ok: true });
    expect(await markdownOf(id, owner)).toEqual(['Beta', 'Gamma', 'Alpha', '* one', '* nested']);
  }, 15_000);

  it('accepting a stale suggestion is refused and it stays open', async () => {
    const { id, agent } = await setup();
    const v = await versions(id, agent);
    const sid = (await ops(id, agent, { ops: [{ op: 'update', target: main('b'), block: 'Beta by agent', expectVersion: v.b }] })).outcomes[0]!.suggestionId!;
    await ops(id, owner, { ops: [{ op: 'update', target: main('b'), block: 'Beta by person', expectVersion: v.b }] });

    expect((await open(id))[0]).toMatchObject({ id: sid, stale: true });
    expect(await decideSuggestion(sid, owner, 'accept')).toMatchObject({ ok: false, status: 409, refusal: { code: 'target_changed' } });
    expect(await markdownOf(id, owner)).toEqual(['Alpha', 'Beta by person', 'Gamma']);
    expect((await open(id)).map((s) => s.id)).toEqual([sid]);
  });

  it('a stale op with onConflict suggest becomes a suggestion against the current text', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha')]);
    const agent = await makeAgent();
    const v = await versions(id, agent);
    await ops(id, owner, { ops: [{ op: 'update', target: main('a'), block: 'Alpha by person', expectVersion: v.a }] });
    const out = await ops(id, agent, { onConflict: 'suggest', ops: [{ op: 'update', target: main('a'), block: 'Alpha by agent', expectVersion: v.a }] });
    expect(out.outcomes[0]).toMatchObject({ status: 'suggested' });
    const [s] = await open(id);
    expect(s).toMatchObject({ conflict: true, stale: false, edits: [{ current: { markdown: 'Alpha by person' }, proposed: { markdown: 'Alpha by agent' } }] });
  });

  it("a suggestion of another document is never revealed or decided through this one", async () => {
    // Document A is shared with the stranger; document B, with a suggestion, is not.
    const stranger = await person('stranger');
    const { id: b, agent } = await setup();
    const v = await versions(b, agent);
    const sid = (await ops(b, agent, { ops: [{ op: 'update', target: main('a'), block: 'Secret', expectVersion: v.a }] })).outcomes[0]!.suggestionId!;
    const a = await createLiveDoc();
    await seedBlocks(a, [paragraph('x', 'Public')]);
    await grant(a, stranger.id, 'editor');

    expect(await open(a, stranger)).toEqual([]);
    for (const decision of ['accept', 'reject', 'withdraw'] as const) {
      expect(await decideSuggestion(sid, stranger, decision)).toMatchObject({ ok: false, status: 404 });
    }
    const app = createApp({ storage: new FilesystemStorage('/nonexistent-primer-test'), notifier: new NoopNotifier(), userResolver: mockMultiResolver });
    const res = await app.request(`/api/suggestions/${sid}/accept`, { method: 'POST', headers: asUserJson(stranger.id), body: '{}' });
    expect(res.status).toBe(404);
    expect((await app.request(`/api/documents/${b}/suggestions`, { headers: asUserJson(stranger.id) })).status).toBe(404);

    // A row moved onto A (as if its id came from A's content) is listed under
    // A only, and accepting it writes A, never B.
    await db.execute(sql`UPDATE suggestions SET document_id = ${a} WHERE id = ${sid}`);
    expect(await decideSuggestion(sid, stranger, 'accept')).toMatchObject({ ok: false, status: 409 });
    expect(await markdownOf(b, owner)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(await markdownOf(a, owner)).toEqual(['Public']);
  });
});
