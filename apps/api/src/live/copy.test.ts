import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import type { Storage } from '../storage/types.ts';
import { proposeBranch } from './branch.ts';
import { copyDocument } from './copy.ts';
import { commentedThreadIds, fragmentDoc, presentThreadIds } from './marks.ts';
import { comment, createLiveDoc, makeAgent, markdownOf, ops, paragraph, seedBlocks, versions, withLiveDoc } from './live.testlib.ts';
import { createLiveThread } from '../lib/liveThreads.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { publishDocument } from '../lib/publish.ts';
import { versions as versionsTable, widgets } from '../db/schema.ts';
import { currentPageHtml } from '../page/publish.ts';
import { readPidText, setPidText } from '../page/text.ts';
import { readBundleFile } from './bundle.ts';
import { createCheckpoint } from './checkpoint.ts';
import { originFor } from './origin.ts';
import { applyPlan } from './pipeline.ts';
import { widgetAnchorProblem } from '../widgets/anchors.ts';
import { draftWidget, publishWidget } from '../widgets/store.ts';
import { pageBlocks } from './reach.ts';
import { decideChangeSet, decideSuggestion, listSuggestions } from './suggest.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };
const main = (blockId: string) => ({ tabId: 'main', blockId });

async function withStorage<T>(fn: (storage: Storage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-copy-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A parent with three paragraphs, a commented one and an image, and a
 *  branch of it made by the owner. */
async function branched(storage: Storage) {
  const parent = await createLiveDoc();
  const fileId = uuidv7();
  await storage.put(`files/${parent}/${fileId}`, new TextEncoder().encode('png'));
  await db.execute(sql`
    INSERT INTO doc_files (id, document_id, storage_key, content_type, size_bytes, uploaded_by)
    VALUES (${fileId}, ${parent}, ${`files/${parent}/${fileId}`}, 'image/png', 3, 'mock-user-1')
  `);
  await seedBlocks(parent, [
    paragraph('a', 'Alpha'),
    paragraph('b', 'Beta'),
    paragraph('c', 'Gamma'),
    { id: 'img', type: 'image', props: { url: `primer-blob://${fileId}` } } as never,
  ]);
  const threadId = await comment(parent, 'b', 'Beta');
  const out = await copyDocument(storage, owner, parent, 'branch');
  if (!out.ok) throw new Error(out.refusal.message);
  return { parent, branch: out.documentId, threadId, fileId };
}

async function propose(storage: Storage, branch: string) {
  const out = await proposeBranch(storage, owner, branch);
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

async function openSuggestions(documentId: string) {
  const out = await listSuggestions(owner, documentId);
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

describe('branches', () => {
  it('branch proposal arrives as one change set and accepting applies all', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      const v = await versions(branch, agent);
      await ops(branch, agent, {
        ops: [
          { op: 'update', target: main('a'), block: 'Alpha, on the branch', expectVersion: v.a },
          { op: 'add', at: main('c'), position: 'after', blocks: ['Delta', 'Epsilon'] },
        ],
      });

      const proposal = await propose(storage, branch);
      expect(proposal.changeSetId).toBe(branch);
      expect(proposal.outcomes.every((o) => o.status === 'suggested')).toBe(true);
      const open = await openSuggestions(parent);
      expect(open).toHaveLength(2);
      expect(open.every((s) => s.changeSetId === branch && !s.conflict)).toBe(true);
      // The parent is untouched until someone decides.
      expect(await markdownOf(parent, agent)).toEqual(['Alpha', 'Beta', 'Gamma', expect.any(String)]);

      const accepted = await decideChangeSet(branch, owner, 'accept');
      expect(accepted.ok && accepted.value.outcomes.map((o) => o.status)).toEqual(['applied', 'applied']);
      expect((await markdownOf(parent, agent)).filter((m) => !m.startsWith('!'))).toEqual(['Alpha, on the branch', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
      expect(await openSuggestions(parent)).toEqual([]);
    });
  });

  it('a parent-only edit is never proposed for reversal', async () => {
    await withStorage(async (storage) => {
      const { parent, branch, threadId } = await branched(storage);
      const agent = await makeAgent();
      // An untouched branch (with its comment and image) proposes nothing.
      expect((await propose(storage, branch)).outcomes).toEqual([]);

      const pv = await versions(parent, agent);
      await ops(parent, agent, { ops: [{ op: 'update', target: main('c'), block: 'Gamma, edited on the parent', expectVersion: pv.c }] });
      await ops(parent, agent, { ops: [{ op: 'delete', target: main('a'), expectVersion: pv.a }] });
      const bv = await versions(branch, agent);
      await ops(branch, agent, { ops: [{ op: 'update', target: main('b'), block: 'Beta, on the branch', expectVersion: bv.b }] });

      const proposal = await propose(storage, branch);
      expect(proposal.outcomes).toHaveLength(1);
      const [only] = await openSuggestions(parent);
      expect(only!.edits.map((e) => e.target.blockId)).toEqual(['b']);
      expect(await decideSuggestion(only!.id, owner, 'accept')).toMatchObject({ ok: true });
      expect((await markdownOf(parent, agent)).slice(0, 2)).toEqual(['Beta, on the branch', 'Gamma, edited on the parent']);
      // The parent's own thread is still on its text; the branch's copy isn't.
      expect(await withLiveDoc(parent, (doc) => commentedThreadIds(fragmentDoc(doc.getXmlFragment('document-store'))))).toEqual([threadId]);
    });
  });

  it('a block changed on both sides is a conflict', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      const pv = await versions(parent, agent);
      await ops(parent, agent, { ops: [{ op: 'update', target: main('a'), block: 'Alpha, the parent\'s', expectVersion: pv.a }] });
      const bv = await versions(branch, agent);
      await ops(branch, agent, {
        ops: [
          { op: 'update', target: main('a'), block: 'Alpha, the branch\'s', expectVersion: bv.a },
          { op: 'update', target: main('c'), block: 'Gamma, the branch\'s', expectVersion: bv.c },
        ],
      });

      await propose(storage, branch);
      const open = await openSuggestions(parent);
      const conflict = open.find((s) => s.conflict)!;
      expect(conflict.edits[0]).toMatchObject({ target: main('a'), current: { markdown: 'Alpha, the parent\'s' }, proposed: { markdown: 'Alpha, the branch\'s' } });
      expect(open.filter((s) => !s.conflict).map((s) => s.edits[0]!.target.blockId)).toEqual(['c']);

      // Accepting the set leaves the conflict to be decided on its own.
      await decideChangeSet(branch, owner, 'accept');
      expect((await markdownOf(parent, agent)).slice(0, 3)).toEqual(['Alpha, the parent\'s', 'Beta', 'Gamma, the branch\'s']);
      expect((await openSuggestions(parent)).map((s) => s.id)).toEqual([conflict.id]);

      // Proposing again replaces the open set instead of adding to it.
      await propose(storage, branch);
      const again = await openSuggestions(parent);
      expect(again).toHaveLength(1);
      expect(again[0]!.conflict).toBe(true);
    });
  });
  it('a moved block is proposed as one move that keeps the branch order', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      const bv = await versions(branch, agent);
      await ops(branch, agent, { ops: [{ op: 'move', target: main('c'), at: main('a'), position: 'before', expectVersion: bv.c }] });

      await propose(storage, branch);
      const open = await openSuggestions(parent);
      expect(open.flatMap((s) => s.edits.map((e) => [e.kind, e.target.blockId]))).toEqual([['move', 'c']]);
      await decideSuggestion(open[0]!.id, owner, 'accept');
      expect((await markdownOf(parent, agent)).slice(0, 3)).toEqual(['Gamma', 'Alpha', 'Beta']);
    });
  });
});

describe('forks', () => {
  it('fork keeps content and block ids but strips marks and threads', async () => {
    await withStorage(async (storage) => {
      const { parent, fileId } = await branched(storage);
      await db.execute(sql`
        INSERT INTO doc_records (document_id, collection, record_id, scope, owner_user_id, data, contributors, version, updated_by)
        VALUES (${parent}, 'votes', 'shared-1', 'shared', NULL, '{"n":1}', '{mock-user-1}', 1, 'mock-user-1'),
               (${parent}, 'votes', 'mine-1', 'personal', 'mock-user-1', '{"n":2}', '{mock-user-1}', 1, 'mock-user-1')
      `);
      const out = await copyDocument(storage, owner, parent, 'fork', 'Remix');
      if (!out.ok) throw new Error(out.refusal.message);
      const fork = out.documentId;
      const agent = await makeAgent();

      expect(Object.keys(await versions(fork, agent))).toEqual(Object.keys(await versions(parent, agent)));
      expect((await markdownOf(fork, agent)).slice(0, 3)).toEqual(['Alpha', 'Beta', 'Gamma']);
      const content = await withLiveDoc(fork, (doc) => fragmentDoc(doc.getXmlFragment('document-store')));
      expect(commentedThreadIds(content)).toEqual([]);
      const threads = (await db.execute(sql`SELECT id FROM threads WHERE document_id = ${fork}`)) as unknown as unknown[];
      expect(threads).toEqual([]);

      // Its file is its own copy.
      const [file] = (await db.execute(sql`SELECT id, copied_from AS "from" FROM doc_files WHERE document_id = ${fork}`)) as unknown as { id: string; from: string }[];
      expect(file!.from).toBe(fileId);
      expect(JSON.stringify(content.toJSON())).toContain(`primer-blob://${file!.id}`);
      // Shared records come along; personal ones don't.
      const records = (await db.execute(sql`SELECT record_id AS id FROM doc_records WHERE document_id = ${fork}`)) as unknown as { id: string }[];
      expect(records.map((r) => r.id)).toEqual(['shared-1']);
      // A checkpoint to share and compare from.
      const [v] = (await db.execute(sql`SELECT version_number AS n FROM versions WHERE document_id = ${fork}`)) as unknown as { n: number }[];
      expect(v!.n).toBe(1);
    });
  });
});

const CHART = `export default function render({ rows, tokens }) {
  return (
    <svg viewBox="0 0 300 120">
      <text data-text-id="title" x="10" y="20" fill={tokens.fg}>Signups</text>
      <g data-anchor="bars">{rows.map((r, i) => <rect data-row={r.id} data-col="signups" x={10 + i * 40} y={110 - r.signups / 5} width="30" height={r.signups / 5} fill={tokens.accent1} />)}</g>
    </svg>
  );
}`;

/** A document with a published chart and three comments on it: on a label's words, on a part and on a data point. */
async function withWidget() {
  const doc = await createLiveDoc();
  await seedBlocks(doc, [paragraph('intro', 'Intro')]);
  const draft = await draftWidget(owner, doc, { source: CHART, rows: [{ id: 'w1', signups: 240 }, { id: 'w2', signups: 410 }], afterBlockId: 'intro' });
  if (!draft.ok) throw new Error(draft.refusal.message);
  const published = await publishWidget(owner, draft.value.widgetId, draft.value.previewHash);
  if (!published.ok) throw new Error(published.refusal.message);
  const { blockId, widgetId } = draft.value;
  const target = { tabId: 'main', blockId };
  const thread = async (anchor: Record<string, unknown>) => {
    const out = await createLiveThread(new NoopNotifier(), owner, doc, { anchor, body: 'Why?' });
    if (!out.ok) throw new Error(out.refusal.message);
    return out.value.id;
  };
  const label = await thread({ type: 'prose', target: { ...target, textId: 'title' }, quote: 'Signups' });
  const part = await thread({ type: 'widget-part', target, anchor: 'bars' });
  const point = await thread({ type: 'data-point', target, row: 'w2', column: 'signups' });
  return { doc, blockId, widgetId, label, part, point, hash: published.value.publishedHash };
}

const widgetRows = (documentId: string) => db.select().from(widgets).where(eq(widgets.documentId, documentId));

/** The widget block's props in a document. */
const widgetProps = (documentId: string) =>
  withLiveDoc(documentId, (doc) => {
    const props = fragmentDoc(doc.getXmlFragment('document-store'));
    let found: Record<string, unknown> | null = null;
    props.descendants((node) => {
      if (node.type.name === 'widget') found = node.attrs;
      return true;
    });
    return found as unknown as { widgetId: string; hash: string; textIds: string };
  });

describe('widgets in copies (C12)', () => {
  it('a branch copies the widget under a new id and re-creates its label, part and data-point threads', async () => {
    await withStorage(async (storage) => {
      const src = await withWidget();
      const out = await copyDocument(storage, owner, src.doc, 'branch');
      if (!out.ok) throw new Error(out.refusal.message);
      const branch = out.documentId;

      const [row] = await widgetRows(branch);
      expect(row).toMatchObject({ blockId: src.blockId, documentId: branch });
      expect(row!.id).not.toBe(src.widgetId);
      expect(row!.rows).toEqual([{ id: 'w1', signups: 240 }, { id: 'w2', signups: 410 }]);
      expect(row!.publishedSvgLight).toContain('data-anchor="bars"');
      // The source keeps its own row and the block now names the copy, with the copy's hash.
      expect((await widgetRows(src.doc)).map((r) => r.id)).toEqual([src.widgetId]);
      expect(await widgetProps(branch)).toEqual({ widgetId: row!.id, hash: row!.publishedHash, textIds: 'title' });
      expect(await widgetProps(src.doc)).toMatchObject({ widgetId: src.widgetId, hash: src.hash });

      // Three threads copied with their comments; the label's mark follows its copy.
      const copied = (await db.execute(sql`SELECT id, copied_from AS "from", anchor FROM threads WHERE document_id = ${branch}`)) as unknown as { id: string; from: string; anchor: { type: string } }[];
      expect(copied.map((t) => t.from).sort()).toEqual([src.label, src.part, src.point].sort());
      expect(copied.map((t) => t.anchor.type).sort()).toEqual(['data-point', 'prose', 'widget-part']);
      const labelCopy = copied.find((t) => t.from === src.label)!.id;
      const present = await withLiveDoc(branch, (doc) => presentThreadIds(doc));
      expect([...present]).toEqual([labelCopy]);
      // The part and data-point threads resolve against the branch's own row.
      for (const anchor of [
        { type: 'widget-part' as const, target: { tabId: 'main', blockId: src.blockId }, anchor: 'bars' },
        { type: 'data-point' as const, target: { tabId: 'main', blockId: src.blockId }, row: 'w2', column: 'signups' },
      ]) expect(await widgetAnchorProblem(branch, anchor)).toBeNull();
    });
  });

  it('a fork copies the widget under a new id and strips its marks and threads', async () => {
    await withStorage(async (storage) => {
      const src = await withWidget();
      const out = await copyDocument(storage, owner, src.doc, 'fork');
      if (!out.ok) throw new Error(out.refusal.message);
      const [row] = await widgetRows(out.documentId);
      expect(row!.id).not.toBe(src.widgetId);
      expect(await widgetProps(out.documentId)).toMatchObject({ widgetId: row!.id, hash: row!.publishedHash });
      expect([...(await withLiveDoc(out.documentId, (doc) => presentThreadIds(doc)))]).toEqual([]);
      expect(await withLiveDoc(out.documentId, (doc) => doc.getXmlFragment(`widget/${src.blockId}/title`).length)).toBeGreaterThan(0);
      expect(await db.execute(sql`SELECT id FROM threads WHERE document_id = ${out.documentId}`)).toHaveLength(0);
    });
  });

  it('only a widget row under the block that names it is copied', async () => {
    await withStorage(async (storage) => {
      const src = await withWidget();
      // The block names a widget whose row sits under another block: ids from the Y.Doc prove nothing.
      await db.execute(sql`UPDATE widgets SET block_id = 'other' WHERE document_id = ${src.doc}`);
      const out = await copyDocument(storage, owner, src.doc, 'fork');
      if (!out.ok) throw new Error(out.refusal.message);
      expect(await widgetRows(out.documentId)).toHaveLength(0);
    });
  });
});

describe('page text in copies (C12)', () => {
  const PAGE = '<!doctype html><html><head><title>Plan</title></head><body><h1>Roadmap</h1><p>Ship the editor in May.</p></body></html>';

  async function commentedPage(storage: Storage) {
    const made = await publishDocument(storage, { actor: owner, title: 'Plan', content: new TextEncoder().encode(PAGE), filename: 'plan.html', format: 'html' });
    if (!made.ok) throw new Error(made.refusal.message);
    const doc = made.documentId;
    const page = await withLiveDoc(doc, (d) => pageBlocks(d)[0]!);
    const out = await createLiveThread(new NoopNotifier(), owner, doc, {
      anchor: { type: 'prose', target: { tabId: page.tabId, blockId: page.blockId, pid: page.pids[1]! }, quote: 'editor' },
      body: 'Which editor?',
    });
    if (!out.ok) throw new Error(out.refusal.message);
    return { doc, thread: out.value.id };
  }

  it('a branch re-points the comment mark in the page text at its thread copy; a fork strips it', async () => {
    await withStorage(async (storage) => {
      const { doc, thread } = await commentedPage(storage);
      expect([...(await withLiveDoc(doc, (d) => presentThreadIds(d)))]).toEqual([thread]);

      const branch = await copyDocument(storage, owner, doc, 'branch');
      if (!branch.ok) throw new Error(branch.refusal.message);
      const [copy] = (await db.execute(sql`SELECT id FROM threads WHERE document_id = ${branch.documentId} AND copied_from = ${thread}`)) as unknown as { id: string }[];
      expect([...(await withLiveDoc(branch.documentId, (d) => presentThreadIds(d)))]).toEqual([copy!.id]);
      // The page block and its text fragments came along.
      const pages = await withLiveDoc(branch.documentId, (d) => pageBlocks(d));
      expect(pages[0]!.pids).toHaveLength(2);
      // The page's stamped source is the branch's own copy, keyed by its checkpoint 1 (where a purge looks).
      const [v1] = (await db.execute(sql`SELECT id FROM versions WHERE document_id = ${branch.documentId}`)) as unknown as { id: string }[];
      expect(pages[0]!.sourceKey).toBe(`pages/${branch.documentId}/${v1!.id}.html`);
      expect(await new Response(await storage.get(pages[0]!.sourceKey)).text()).toContain('Ship the editor in May.');

      const fork = await copyDocument(storage, owner, doc, 'fork');
      if (!fork.ok) throw new Error(fork.refusal.message);
      expect([...(await withLiveDoc(fork.documentId, (d) => presentThreadIds(d)))]).toEqual([]);
      expect((await withLiveDoc(fork.documentId, (d) => pageBlocks(d)))[0]!.pids).toHaveLength(2);
    });
  });
});

describe('proposing a branch of a page or widget', () => {
  const PAGE =
    '<!doctype html><html><head><title>Plan</title></head><body><h1>Roadmap</h1><p>Ship the editor in May.</p>' +
    '<primer-code data-embed-id="snippet" lang="ts">const a = 1;</primer-code></body></html>';

  it('accepting an edited page branch keeps the parent page its own and carries the edited text', async () => {
    await withStorage(async (storage) => {
      const made = await publishDocument(storage, { actor: owner, title: 'Plan', content: new TextEncoder().encode(PAGE), filename: 'plan.html', format: 'html' });
      if (!made.ok) throw new Error(made.refusal.message);
      const parent = made.documentId;
      const before = await withLiveDoc(parent, (d) => pageBlocks(d)[0]!);
      const out = await copyDocument(storage, owner, parent, 'branch');
      if (!out.ok) throw new Error(out.refusal.message);
      const branch = out.documentId;
      const page = await withLiveDoc(branch, (d) => pageBlocks(d)[0]!);
      // The untouched embed is compared too, and proposes nothing.
      expect(page.embeds).toEqual(['snippet']);
      await applyPlan(branch, originFor(owner), {
        onConflict: 'refuse',
        edits: [setPidText({ tabId: page.tabId, blockId: page.blockId, pid: page.pids[1]! }, 'Ship the editor in June.')],
      });

      const proposal = await propose(storage, branch);
      expect(proposal.outcomes.map((o) => o.status)).toEqual(['suggested']);
      expect((await openSuggestions(parent))[0]!.edits.map((e) => e.target)).toEqual([{ tabId: 'main', blockId: page.blockId, pid: page.pids[1] }]);
      const accepted = await decideChangeSet(branch, owner, 'accept');
      expect(accepted.ok && accepted.value.outcomes.map((o) => o.status)).toEqual(['applied']);

      const after = await withLiveDoc(parent, (d) => pageBlocks(d)[0]!);
      expect(after.sourceKey).toBe(before.sourceKey);
      const html = await withLiveDoc(parent, (d) => currentPageHtml(storage, parent, d));
      expect(html).toContain('Ship the editor in June.');
      const checkpoint = await createCheckpoint(storage, parent, owner, null);
      const [v] = await db.select({ bundleKey: versionsTable.bundleKey }).from(versionsTable).where(eq(versionsTable.id, checkpoint.versionId));
      expect(new TextDecoder().decode(await readBundleFile(storage, v!.bundleKey!, 'export.html'))).toContain('Ship the editor in June.');
    });
  });

  it('accepting a widget branch keeps the parent widget its own and carries the edited label', async () => {
    await withStorage(async (storage) => {
      const src = await withWidget();
      const out = await copyDocument(storage, owner, src.doc, 'branch');
      if (!out.ok) throw new Error(out.refusal.message);
      const label = { tabId: 'main', blockId: src.blockId, textId: 'title' };
      await applyPlan(out.documentId, originFor(owner), { onConflict: 'refuse', edits: [setPidText(label, 'Weekly signups')] });

      const proposal = await propose(storage, out.documentId);
      expect(proposal.outcomes.map((o) => [o.status, o.target])).toEqual([['suggested', label]]);
      const accepted = await decideChangeSet(out.documentId, owner, 'accept');
      expect(accepted.ok && accepted.value.outcomes.map((o) => o.status)).toEqual(['applied']);
      expect(await widgetProps(src.doc)).toMatchObject({ widgetId: src.widgetId, hash: src.hash });
      expect(await withLiveDoc(src.doc, (d) => readPidText(d, label))).toBe('Weekly signups');
    });
  });

  it('a widget republished on the branch is refused and the parent widget stays as it was', async () => {
    await withStorage(async (storage) => {
      const src = await withWidget();
      const out = await copyDocument(storage, owner, src.doc, 'branch');
      if (!out.ok) throw new Error(out.refusal.message);
      const [row] = await widgetRows(out.documentId);
      const draft = await draftWidget(owner, out.documentId, { widgetId: row!.id, source: CHART, rows: [{ id: 'w1', signups: 300 }] });
      if (!draft.ok) throw new Error(draft.refusal.message);
      const published = await publishWidget(owner, draft.value.widgetId, draft.value.previewHash);
      if (!published.ok) throw new Error(published.refusal.message);

      const proposal = await propose(storage, out.documentId);
      expect(proposal.outcomes.map((o) => [o.status, o.target.blockId])).toEqual([['conflict', src.blockId]]);
      expect(await openSuggestions(src.doc)).toEqual([]);
      expect(await widgetProps(src.doc)).toMatchObject({ widgetId: src.widgetId, hash: src.hash });
    });
  });

  it('a widget added on the branch is refused, even after a new paragraph', async () => {
    await withStorage(async (storage) => {
      const { parent, branch } = await branched(storage);
      const agent = await makeAgent();
      await ops(branch, agent, { ops: [{ op: 'add', at: main('c'), position: 'after', blocks: ['Delta'] }] });
      // Top-level blocks: Alpha, Beta, Gamma, Delta, then the image.
      const blocks = await withLiveDoc(branch, (d) => {
        const ids: string[] = [];
        fragmentDoc(d.getXmlFragment('document-store')).descendants((n) => {
          if (n.type.name === 'blockContainer') ids.push(n.attrs.id as string);
          return true;
        });
        return ids;
      });
      const draft = await draftWidget(owner, branch, { source: CHART, rows: [{ id: 'w1', signups: 240 }], afterBlockId: blocks[3]! });
      if (!draft.ok) throw new Error(draft.refusal.message);
      const published = await publishWidget(owner, draft.value.widgetId, draft.value.previewHash);
      if (!published.ok) throw new Error(published.refusal.message);

      const proposal = await propose(storage, branch);
      const widget = proposal.outcomes.find((o) => o.target.blockId === draft.value.blockId);
      expect(widget?.status).toBe('conflict');
      const open = await openSuggestions(parent);
      expect(JSON.stringify(open)).not.toContain(draft.value.widgetId);
    });
  });
});
