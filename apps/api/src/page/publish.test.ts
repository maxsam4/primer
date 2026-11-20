import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { AuthUser } from '../app.ts';
import { createApp } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, suggestions, threadPlacements, versions } from '../db/schema.ts';
import { createLiveThread } from '../lib/liveThreads.ts';
import { createCheckpoint } from '../live/checkpoint.ts';
import { publishDocument, type PublishInput } from '../lib/publish.ts';
import { makeAgent, withLiveDoc } from '../live/live.testlib.ts';
import { applyOps } from '../live/ops.ts';
import { getLiveDoc } from '../live/read.ts';
import { originFor } from '../live/origin.ts';
import { applyPlan } from '../live/pipeline.ts';
import { fragmentFor, pageBlocks, reachableFragments } from '../live/reach.ts';
import { serverEditor } from '../live/editor.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import type { Storage } from '../storage/types.ts';
import { createLegacyDocument } from '../testing/legacy.ts';
import { readPidText, setPidText } from './text.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };

const PAGE = `<!doctype html><html><head><title>Plan</title></head><body>
<h1>Roadmap</h1>
<p>Ship the editor in May.</p>
<p>Pricing stays the same.</p>
<canvas id="chart"></canvas>
<script>document.getElementById('chart').dataset.drawn = '1';</script>
</body></html>`;

async function withStorage<T>(fn: (storage: Storage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-page-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const html = (content: string, actor: AuthUser, extra: Partial<PublishInput> = {}): PublishInput => ({
  actor,
  title: 'Plan',
  content: new TextEncoder().encode(content),
  filename: 'plan.html',
  format: 'html',
  ...extra,
});

async function publishPage(storage: Storage, content: string, actor: AuthUser = owner, extra: Partial<PublishInput> = {}) {
  const r = await publishDocument(storage, html(content, actor, extra));
  if (!r.ok) throw new Error(`publish refused: ${r.refusal.message}`);
  return r;
}

async function pageOf(documentId: string) {
  return withLiveDoc(documentId, (doc) => pageBlocks(doc)[0]!);
}

async function text(documentId: string, pid: string) {
  const page = await pageOf(documentId);
  return withLiveDoc(documentId, (doc) => readPidText(doc, { tabId: page.tabId, blockId: page.blockId, pid }));
}

/** A person types into a pid (as the overlay would, through the pipeline). */
async function type(documentId: string, pid: string, value: string, actor: AuthUser = owner) {
  const page = await pageOf(documentId);
  await applyPlan(documentId, originFor(actor), { onConflict: 'refuse', edits: [setPidText({ tabId: page.tabId, blockId: page.blockId, pid }, value)] });
}

describe('page documents', () => {
  it('HTML upload creates a live page document with one page block', async () => {
    await withStorage(async (storage) => {
      const r = await publishPage(storage, PAGE);
      const [doc] = await db.select().from(documents).where(eq(documents.id, r.documentId));
      expect(doc!.format).toBe('html');
      const page = await pageOf(r.documentId);
      expect(page).toMatchObject({ tabId: 'main', pids: ['p1', 'p2', 'p3'], embeds: [], title: 'Plan' });
      expect(page.sourceKey).toBe(`pages/${r.documentId}/${r.versionId}.html`);
      expect(await text(r.documentId, 'p2')).toBe('Ship the editor in May.');
      expect(await withLiveDoc(r.documentId, (d) => reachableFragments(d))).toEqual([
        'document-store',
        `page/${page.blockId}/p1`,
        `page/${page.blockId}/p2`,
        `page/${page.blockId}/p3`,
      ]);
      // The checkpoint's static rendering is the page itself.
      const [v] = await db.select().from(versions).where(eq(versions.id, r.versionId!));
      const served = await new Response(await storage.get(v!.storageKey)).text();
      expect(served).toContain('<h1 data-pid="p1">Roadmap</h1>');
    });
  });

  it('page content is served with the artifact CSP and sandbox unchanged', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const r = await publishPage(storage, PAGE);
      const page = await pageOf(r.documentId);
      await type(r.documentId, 'p2', 'Ship the editor in June.');

      const res = await app.request(`/api/documents/${r.documentId}/pages/${page.blockId}/content`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
      const body = await res.text();
      // The stamped source is served; people's text arrives over the bridge.
      expect(body).toContain('<p data-pid="p2">Ship the editor in May.</p>');
      expect(body).toContain('/companion/v1.js');

      const info = (await (await app.request(`/api/documents/${r.documentId}/pages/${page.blockId}`)).json()) as { texts: Record<string, string> };
      expect(info.texts).toEqual({ p1: 'Roadmap', p2: 'Ship the editor in May.', p3: 'Pricing stays the same.' });

      // Export splices people's text into the original, byte for byte elsewhere.
      const exported = await (await app.request(`/api/documents/${r.documentId}/export`)).text();
      expect(exported).toBe(PAGE.replace('<h1>', '<h1 data-pid="p1">').replace('<p>Ship the editor in May.', '<p data-pid="p2">Ship the editor in June.').replace('<p>Pricing', '<p data-pid="p3">Pricing'));
      // Someone else's block can't point the page at another document's source.
      expect((await app.request(`/api/documents/${r.documentId}/pages/not-a-block/content`)).status).toBe(404);
    });
  });

  it("people's text survives an agent republish; both changed becomes their suggestion", async () => {
    await withStorage(async (storage) => {
      const agent = await makeAgent(owner.id);
      const r = await publishPage(storage, PAGE, agent);
      await type(r.documentId, 'p1', 'Roadmap 2027');
      await type(r.documentId, 'p2', 'Ship the editor in June.');

      // The agent rewrites p2 and adds a paragraph; p1 is unchanged on its side.
      const next = PAGE.replace('Ship the editor in May.', 'Ship the editor in April.').replace('</body>', '<p>New section.</p>\n</body>');
      const v2 = await publishDocument(storage, html(next, agent, { documentId: r.documentId }));
      expect(v2.ok && v2.versionNumber).toBe(2);
      expect(await text(r.documentId, 'p1')).toBe('Roadmap 2027');
      expect(await text(r.documentId, 'p2')).toBe('Ship the editor in April.');
      expect(await text(r.documentId, 'p4')).toBe('New section.');

      const open = await db.select().from(suggestions).where(eq(suggestions.documentId, r.documentId));
      expect(open).toHaveLength(1);
      expect(open[0]!.authorId).toBe(owner.id);
      const page = await pageOf(r.documentId);
      expect(open[0]!.edits).toEqual([expect.objectContaining({ kind: 'replace', target: { tabId: 'main', blockId: page.blockId, pid: 'p2' } })]);
      expect(JSON.stringify(open[0]!.edits)).toContain('Ship the editor in June.');
    });
  });

  it('removed element orphans its thread', async () => {
    await withStorage(async (storage) => {
      const r = await publishPage(storage, PAGE);
      const page = await pageOf(r.documentId);
      const comment = serverEditor().editor.pmSchema.marks.comment!.create({ threadId: 't-pricing' });
      await applyPlan(r.documentId, originFor(owner), {
        onConflict: 'refuse',
        annotation: true,
        edits: [{ target: { tabId: 'main', blockId: page.blockId, pid: 'p3' }, inverse: false, build: (tr, at) => void tr.addMark(at!.pos + 2, at!.pos + 9, comment) }],
      });
      await publishPage(storage, PAGE.replace('<p>Pricing stays the same.</p>\n', ''), owner, { documentId: r.documentId });
      await withLiveDoc(r.documentId, (doc) => {
        expect(reachableFragments(doc)).not.toContain(`page/${page.blockId}/p3`);
        // The mark is still in its (now unreachable) fragment, so the thread orphans, never vanishes.
        expect(fragmentFor(doc, { tabId: 'main', blockId: page.blockId, pid: 'p3' }).toString()).toContain('t-pricing');
      });
    });
  });

  it('a checkpoint keeps the placement of threads on unchanged page text and blocks', async () => {
    await withStorage(async (storage) => {
      const r = await publishPage(storage, PAGE.replace('<canvas', '<primer-code data-embed-id="snippet" lang="ts">const answer = 42;</primer-code>\n<canvas'));
      const page = await pageOf(r.documentId);
      const start = async (anchor: unknown) => {
        const out = await createLiveThread(new NoopNotifier(), owner, r.documentId, { anchor, body: 'Note' });
        if (!out.ok) throw new Error(out.refusal.message);
        return out.value.id;
      };
      const onText = await start({ type: 'prose', target: { tabId: 'main', blockId: page.blockId, pid: 'p2' }, quote: 'editor' });
      const onEmbed = await start({ type: 'prose', target: { tabId: 'main', blockId: page.blockId, embedId: 'snippet' }, quote: 'answer' });
      const onBlock = await start({ type: 'block', target: { tabId: 'main', blockId: page.blockId } });
      const onGone = await start({ type: 'block', target: { tabId: 'main', blockId: 'gone' } });

      const checkpoint = await createCheckpoint(storage, r.documentId, owner, null);
      const placed = await db
        .select({ threadId: threadPlacements.threadId, anchor: threadPlacements.anchor })
        .from(threadPlacements)
        .where(eq(threadPlacements.versionId, checkpoint.versionId));
      const anchorOf = (id: string) => placed.find((p) => p.threadId === id)?.anchor;
      expect(anchorOf(onText)).toMatchObject({ type: 'prose', target: { pid: 'p2' } });
      expect(anchorOf(onEmbed)).toMatchObject({ type: 'prose', target: { embedId: 'snippet' } });
      expect(anchorOf(onBlock)).toMatchObject({ type: 'block' });
      expect(anchorOf(onGone)).toBeNull();
    });
  });

  it('agent edits a pid through ops and the thread on it survives', async () => {
    await withStorage(async (storage) => {
      const agent = await makeAgent(owner.id);
      const r = await publishPage(storage, PAGE, agent);
      const page = await pageOf(r.documentId);
      const target = { tabId: 'main', blockId: page.blockId, pid: 'p2' };
      const comment = serverEditor().editor.pmSchema.marks.comment!.create({ threadId: 't-ship' });
      await applyPlan(r.documentId, originFor(owner), {
        onConflict: 'refuse',
        annotation: true,
        edits: [{ target, inverse: false, build: (tr, at) => void tr.addMark(at!.pos + 2, at!.pos + 6, comment) }],
      });
      // The agent reads its page: the source with pids, and each pid's text (fenced) and version.
      const read = await getLiveDoc(r.documentId, agent, { format: 'markdown', storage });
      if (!read.ok) throw new Error(read.refusal.message);
      const listed = read.value.pages![0]!;
      expect(listed.source).toContain('<p data-pid="p2">Ship the editor in May.</p>');
      const p2 = listed.texts.find((t) => t.target.pid === 'p2')!;
      expect(p2.text).toMatch(/^<untrusted-pagetext-[0-9a-f]{16}>\nShip the editor in May.\n<\/untrusted-pagetext-[0-9a-f]{16}>$/);
      const version = p2.version;
      const out = await applyOps(r.documentId, agent, { ops: [{ op: 'update', target, expectVersion: version, block: 'Ship the editor in early May.' }] });
      expect(out.ok && out.value.outcomes[0]!.status).toBe('applied');
      expect(await text(r.documentId, 'p2')).toBe('Ship the editor in early May.');
      await withLiveDoc(r.documentId, (doc) => expect(fragmentFor(doc, target).toString()).toContain('t-ship'));
    });
  });

  it("a suggest-mode agent's HTML republish only suggests, and it can't make a legacy document live", async () => {
    await withStorage(async (storage) => {
      const r = await publishPage(storage, PAGE);
      await db.execute(sql`UPDATE documents SET agent_mode = 'suggest' WHERE id = ${r.documentId}`);
      const agent = await makeAgent(owner.id);
      const out = await publishDocument(storage, html(PAGE.replace('in May.', 'in June.').replace('</body>', '<p>Extra.</p></body>'), agent, { documentId: r.documentId }));
      expect(out.ok).toBe(true);
      expect(out.ok && 'versionId' in out && out.versionId).toBeFalsy();
      expect(await text(r.documentId, 'p2')).toBe('Ship the editor in May.');
      expect((await pageOf(r.documentId)).pids).toEqual(['p1', 'p2', 'p3']);
      const open = await db.select().from(suggestions).where(eq(suggestions.documentId, r.documentId));
      expect(open.map((s) => s.authorId)).toEqual([agent.id]);
      expect(await db.select().from(versions).where(eq(versions.documentId, r.documentId))).toHaveLength(1);

      const legacy = await createLegacyDocument(storage, '<html><body><p>Old.</p></body></html>');
      await db.execute(sql`UPDATE documents SET agent_mode = 'suggest' WHERE id = ${legacy.documentId}`);
      const refused = await publishDocument(storage, html('<html><body><p>New.</p></body></html>', agent, { documentId: legacy.documentId }));
      expect(!refused.ok && refused.refusal.code).toBe('forbidden');
    });
  });

  it("a page block with a bogus sourceKey doesn't break reading the document", async () => {
    await withStorage(async (storage) => {
      const r = await publishPage(storage, PAGE);
      const page = await pageOf(r.documentId);
      const bogus = `pages/${r.documentId}/01a1f557-0000-7000-8000-000000000000.html`;
      await applyPlan(r.documentId, originFor(owner), {
        onConflict: 'refuse',
        edits: [
          {
            target: { tabId: 'main', blockId: page.blockId },
            inverse: false,
            build: (tr, at) => void tr.setNodeMarkup(at!.pos + 1, undefined, { ...at!.node.firstChild!.attrs, sourceKey: bogus }),
          },
        ],
      });
      const read = await getLiveDoc(r.documentId, owner, { format: 'markdown', storage });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.blocks).toHaveLength(1);
      expect(read.value.pages).toEqual([{ target: { tabId: 'main', blockId: page.blockId }, source: null, texts: [] }]);
    });
  });
});
