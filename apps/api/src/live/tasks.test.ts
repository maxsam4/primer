import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { docTasks, documents, events } from '../db/schema.ts';
import { AGENT, OWNER, READER, seedRecordsDoc } from '../records/records.testlib.ts';
import { readBlocks } from './editor.ts';
import { paragraph, seedBlocks, versions, withLiveDoc } from './live.testlib.ts';
import { applyOps } from './ops.ts';
import { addChoice } from './choices.ts';
import { requestRun } from './runs.ts';
import { addTask, flushTaskSync, listDocumentTasks, listMyTasks, rebuildTaskIndex, updateTask } from './tasks.ts';

async function liveDoc(): Promise<string> {
  const id = await seedRecordsDoc();
  await db.update(documents).set({ format: 'markdown' }).where(eq(documents.id, id));
  return id;
}

async function taskEvents(doc: string) {
  const rows = await db.select().from(events).where(eq(events.documentId, doc)).orderBy(events.id);
  return rows.filter((r) => r.type.startsWith('task.')).map((r) => ({ type: r.type, author: r.authorId, payload: r.payload }));
}

describe('block writes', () => {
  it('an agent with an active run must write through it, and an unknown tab is refused', async () => {
    const doc = await liveDoc();
    expect(await addTask(OWNER, doc, { title: 'Elsewhere', tabId: 'nope' })).toMatchObject({ ok: false, refusal: { code: 'not_found' } });

    const asked = await requestRun(OWNER, doc, {
      agentId: AGENT.id,
      request: { kind: 'send', prompt: 'work', viewer: { tabId: 'main', selectedBlockIds: [], cursorBlockId: null } },
    });
    if (!asked.ok) throw new Error(asked.refusal.message);
    expect(await addTask(AGENT, doc, { title: 'Sneaked in' })).toMatchObject({ ok: false, refusal: { code: 'run_required' } });
  });

  it('a block can be added after a choice', async () => {
    const doc = await liveDoc();
    const choice = await addChoice(OWNER, doc, { question: 'Which?', options: ['A', 'B'] });
    if (!choice.ok) throw new Error(choice.refusal.message);
    const task = await addTask(OWNER, doc, { title: 'After the choice', afterBlockId: choice.value.target.blockId });
    expect(task.ok).toBe(true);
  });
});

describe('task blocks', () => {
  it('a due date PostgreSQL cannot store is refused', async () => {
    const doc = await liveDoc();
    expect((await addTask(OWNER, doc, { title: 'Year zero', due: '0000-01-01' })).ok).toBe(false);
  });

  it('adding a task block creates a tracked task and emits task.created', async () => {
    const doc = await liveDoc();
    const added = await addTask(OWNER, doc, { title: 'Draft the launch note', assigneeId: AGENT.id, due: '2026-12-01' });
    if (!added.ok) throw new Error(added.refusal.message);
    await flushTaskSync();

    const listed = await listDocumentTasks(READER, doc);
    expect(listed.ok && listed.value.tasks).toEqual([
      expect.objectContaining({
        target: added.value.target,
        title: 'Draft the launch note',
        assigneeId: AGENT.id,
        due: '2026-12-01',
        status: 'open',
        createdBy: OWNER.id,
      }),
    ]);
    const [task] = listed.ok ? listed.value.tasks : [];
    expect(await taskEvents(doc)).toEqual([
      {
        type: 'task.created',
        author: OWNER.id,
        payload: { document_id: doc, task_id: task!.id, block_id: added.value.target.blockId, assignee_id: AGENT.id, status: 'open' },
      },
    ]);
    // The assignee finds it across documents, fenced: people wrote the title.
    const mine = await listMyTasks(AGENT);
    expect(mine.ok && mine.value.tasks.map((t) => [t.id, t.untrusted])).toEqual([[task!.id, true]]);
    // ...and the title is fenced for the agent, plain for a person.
    expect(mine.ok && mine.value.tasks[0]!.title).toMatch(/^<untrusted-content-[0-9a-f]+>\nDraft the launch note\n<\/untrusted-content-[0-9a-f]+>$/);
    expect(listed.ok && listed.value.tasks[0]!.title).toBe('Draft the launch note');
  });

  it('checking it off updates status', async () => {
    const doc = await liveDoc();
    const added = await addTask(OWNER, doc, { title: 'Collect numbers', assigneeId: AGENT.id });
    if (!added.ok) throw new Error(added.refusal.message);
    await flushTaskSync();

    // The agent reports progress inline: shown in the block, no event.
    expect((await updateTask(AGENT, doc, added.value.target.blockId, { progress: 'Pulled Q3, Q4 next' })).ok).toBe(true);
    await flushTaskSync();
    expect(await taskEvents(doc)).toHaveLength(1);

    // A person ticks the box.
    expect((await updateTask(OWNER, doc, added.value.target.blockId, { status: 'done' })).ok).toBe(true);
    await flushTaskSync();
    const [row] = await db.select().from(docTasks).where(eq(docTasks.documentId, doc));
    expect(row!.status).toBe('done');
    const all = await taskEvents(doc);
    expect(all[1]).toEqual({
      type: 'task.updated',
      author: OWNER.id,
      payload: expect.objectContaining({ assignee_id: AGENT.id, status: 'done', changed: ['status'] }),
    });
    await withLiveDoc(doc, (d) => {
      const block = readBlocks(d, 'main').find((b) => b.id === added.value.target.blockId)!;
      expect(block.props).toMatchObject({ status: 'done', progress: 'Pulled Q3, Q4 next' });
    });
    // A reader can't tick it.
    expect(await updateTask(READER, doc, added.value.target.blockId, { status: 'open' })).toMatchObject({
      ok: false,
      refusal: { code: 'forbidden' },
    });
  });

  it('a malformed task block does not stop the others from indexing', async () => {
    const doc = await liveDoc();
    // Written straight into the (client-writable) document, by the system.
    await seedBlocks(doc, [
      { id: 'task-1', type: 'task', props: { assigneeId: 'ghost', due: '2026-02-30' }, content: 'Bad\u0000title' } as never,
      { id: 'bad/../id', type: 'task', content: 'Skipped' } as never,
      { id: 'task-2', type: 'task', props: { assigneeId: 'x\u0000y', due: '2026-12-31' }, content: 'Fine' } as never,
      { id: 'task-3', type: 'task', props: { assigneeId: AGENT.id }, content: 'Assigned' } as never,
    ]);
    await flushTaskSync();
    const indexed = async () =>
      (await db.select().from(docTasks).where(eq(docTasks.documentId, doc)))
        .map((r) => [r.blockId, r.title, r.assigneeId, r.dueDate])
        .sort();
    const expected = [
      ['task-1', 'Bad title', null, null],
      ['task-2', 'Fine', null, '2026-12-31'],
      ['task-3', 'Assigned', AGENT.id, null],
    ];
    expect(await indexed()).toEqual(expected);
    // The system made the change: indexed, announced to nobody, pinned on nobody.
    expect(await taskEvents(doc)).toEqual([]);
    await rebuildTaskIndex(doc);
    expect(await indexed()).toEqual(expected);
  });

  it('changes by two actors in one window are each attributed to their own author', async () => {
    const doc = await liveDoc();
    const a = await addTask(OWNER, doc, { title: 'Owner task' });
    const b = await addTask(AGENT, doc, { title: 'Agent task' });
    if (!a.ok || !b.ok) throw new Error('add failed');
    await flushTaskSync();
    expect((await taskEvents(doc)).map((e) => [e.type, e.author, (e.payload as { block_id: string }).block_id]).sort()).toEqual(
      [
        ['task.created', AGENT.id, b.value.target.blockId],
        ['task.created', OWNER.id, a.value.target.blockId],
      ].sort(),
    );
    const rows = await db.select().from(docTasks).where(eq(docTasks.documentId, doc));
    expect(Object.fromEntries(rows.map((r) => [r.blockId, r.createdBy]))).toEqual({
      [a.value.target.blockId]: OWNER.id,
      [b.value.target.blockId]: AGENT.id,
    });

    // Both change one task in the same window: one event from each.
    await updateTask(OWNER, doc, a.value.target.blockId, { status: 'done' });
    await updateTask(AGENT, doc, a.value.target.blockId, { progress: 'checked' });
    await updateTask(AGENT, doc, a.value.target.blockId, { status: 'open' });
    await updateTask(OWNER, doc, a.value.target.blockId, { status: 'done' });
    await flushTaskSync();
    const updated = (await taskEvents(doc)).filter((e) => e.type === 'task.updated');
    expect(updated.map((e) => e.author).sort()).toEqual([AGENT.id, OWNER.id].sort());
  });
});

describe('tasks through apply_ops', () => {
  it('an agent adds a task block and reports on it with ordinary ops', async () => {
    const doc = await liveDoc();
    await seedBlocks(doc, [paragraph('intro', 'Intro')]);
    const added = await applyOps(doc, AGENT, {
      ops: [
        {
          op: 'add',
          at: { tabId: 'main', blockId: 'intro' },
          position: 'after',
          blocks: [{ json: { type: 'task', props: { assigneeId: AGENT.id, due: '2026-12-01', status: 'open' }, content: 'Collect numbers' } }],
        },
      ],
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
    await flushTaskSync();
    const listed = await listDocumentTasks(OWNER, doc);
    const task = listed.ok ? listed.value.tasks.find((t) => t.title === 'Collect numbers') : undefined;
    expect(task).toMatchObject({ assigneeId: AGENT.id, due: '2026-12-01', status: 'open' });

    const target = task!.target;
    const version = (await versions(doc, AGENT))[target.blockId];
    const done = await applyOps(doc, AGENT, {
      ops: [{ op: 'update', target, expectVersion: version, block: { json: { type: 'task', props: { progress: 'Pulled Q3', status: 'done' }, content: 'Collect numbers' } } }],
    });
    expect(done.ok && done.value.outcomes[0]?.status).toBe('applied');
    await flushTaskSync();
    const after = await listDocumentTasks(OWNER, doc);
    expect(after.ok && after.value.tasks.find((t) => t.title === 'Collect numbers')).toMatchObject({ status: 'done', assigneeId: AGENT.id });
  });
});
