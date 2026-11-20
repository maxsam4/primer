import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flushAutoCheckpoints } from './autoCheckpoint.ts';
import { eq } from 'drizzle-orm';
import type { CheckpointResponse, Reconciliation } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { MOCK_USER } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { docUpdates, versions } from '../db/schema.ts';
import { publishDocument, type PublishInput } from '../lib/publish.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import type { Storage } from '../storage/types.ts';
import { CSRF_HEADERS } from '../test/harness.ts';
import { readBundleFile, type BundleThread } from './bundle.ts';
import { captureState, writeCheckpoint } from './checkpoint.ts';
import { readBlocks, serverEditor } from './editor.ts';
import { exportMarkdown } from './export.ts';
import { withLiveDoc } from './live.testlib.ts';
import { originFor } from './origin.ts';
import { applyPlan, type PlannedEdit } from './pipeline.ts';
import { createLegacyDocument } from '../testing/legacy.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const SOURCE = '# Plan\n\nShip the editor first.\n\nThen tabs.\n';

async function withStorage<T>(fn: (storage: FilesystemStorage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-checkpoint-test-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function publish(storage: Storage, input: Omit<Partial<PublishInput>, 'content'> & { content: string; format: PublishInput['format'] }) {
  const r = await publishDocument(storage, {
    actor: MOCK_USER,
    title: 'Plan',
    filename: input.format === 'html' ? 'plan.html' : 'plan.md',
    ...input,
    content: enc(input.content),
  });
  if (!r.ok) throw new Error(`publish refused: ${r.refusal.code}`);
  return r;
}

async function setText(documentId: string, from: string, to: string): Promise<void> {
  const blockId = await withLiveDoc(documentId, (doc) => readBlocks(doc, 'main').find((b) => JSON.stringify(b.content).includes(from))!.id);
  const edit: PlannedEdit = {
    target: { tabId: 'main', blockId },
    inverse: false,
    build: (tr, at) => {
      tr.replaceWith(at!.pos + 2, at!.pos + at!.node.firstChild!.nodeSize, tr.doc.type.schema.text(to));
    },
  };
  await applyPlan(documentId, originFor(MOCK_USER), { onConflict: 'refuse', edits: [edit] });
}

const bundleOf = async (versionId: string) =>
  (await db.select({ k: versions.bundleKey }).from(versions).where(eq(versions.id, versionId)))[0]!.k!;
const liveExport = (documentId: string) => withLiveDoc(documentId, (doc) => exportMarkdown(doc, documentId));

describe('checkpoints', () => {
  it('checkpoint bundle is frozen at one docVersion while edits continue', async () => {
    await withStorage(async (storage) => {
      const { documentId } = await publish(storage, { content: SOURCE, format: 'markdown' });
      const captured = await captureState(documentId, MOCK_USER);
      // An edit lands while the bundle is still to be rendered.
      await setText(documentId, 'Then tabs.', 'Then tabs, and comments.');
      const checkpoint = await writeCheckpoint(storage, documentId, MOCK_USER, null, captured);

      expect(checkpoint.versionNumber).toBe(2);
      expect(dec(await readBundleFile(storage, await bundleOf(checkpoint.versionId), 'export.md'))).toBe(SOURCE);
      const [row] = await db.select().from(versions).where(eq(versions.id, checkpoint.versionId));
      expect(row!.docVersion).toBe(captured.docVersion);
      const updates = await db.select().from(docUpdates).where(eq(docUpdates.documentId, documentId));
      expect(Math.max(...updates.map((u) => u.id))).toBeGreaterThan(captured.docVersion);
      expect(await liveExport(documentId)).toContain('Then tabs, and comments.');
    });
  });

  it('restore is a new edit that keeps later history', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const v1 = await publish(storage, { content: SOURCE, format: 'markdown' });
      await setText(v1.documentId, 'Ship the editor first.', 'Ship the editor and the export first.');
      const res = await app.request(`/api/documents/${v1.documentId}/checkpoints`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ note: 'after review' }),
      });
      expect(res.status).toBe(201);
      const v2 = (await res.json()) as CheckpointResponse;
      const before = (await db.select().from(docUpdates).where(eq(docUpdates.documentId, v1.documentId))).length;

      const restored = await app.request(`/api/versions/${v1.versionId}/restore`, { method: 'POST', headers: CSRF_HEADERS });
      expect(restored.status).toBe(200);
      const result = (await restored.json()) as Reconciliation;
      expect(result.outcomes.map((o) => o.status)).toEqual(['applied']);

      // The live document is v1 again (exported byte for byte), as a new update.
      expect(await liveExport(v1.documentId)).toBe(SOURCE);
      const after = await db.select().from(docUpdates).where(eq(docUpdates.documentId, v1.documentId));
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)!.actorId).toBe(MOCK_USER.id);
      // Later history is kept: checkpoint 2 still holds the edit.
      expect(dec(await readBundleFile(storage, await bundleOf(v2.versionId), 'export.md'))).toContain('and the export first');
    });
  });

  it('edits that settle save one automatic checkpoint; an unchanged document saves none', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const v1 = await publish(storage, { content: SOURCE, format: 'markdown' });
      const listed = async () => (await db.select().from(versions).where(eq(versions.documentId, v1.documentId))).sort((a, b) => a.versionNumber - b.versionNumber);
      const save = () => app.request(`/api/documents/${v1.documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS });

      // Nothing changed since the upload: a save still checkpoints, and says so.
      const unchanged = await save();
      expect(unchanged.status).toBe(201);
      expect(await unchanged.json()).toMatchObject({ versionNumber: 2, unchangedSince: 1 });

      await setText(v1.documentId, 'Then tabs.', 'Then tabs, and comments.');
      await flushAutoCheckpoints();
      const auto = (await listed()).at(-1);
      expect(auto).toMatchObject({ versionNumber: 3, automatic: true, versionNote: null });
      expect(dec(await readBundleFile(storage, auto!.bundleKey!, 'export.md'))).toContain('Then tabs, and comments.');

      // No edit since: a flush adds nothing.
      await flushAutoCheckpoints();
      expect(await listed()).toHaveLength(3);

      // A save after an edit is a checkpoint by hand, which leaves the
      // automatic one nothing to save.
      await setText(v1.documentId, 'Ship the editor first.', 'Ship the editor now.');
      const saved = await save();
      expect(await saved.json()).not.toHaveProperty('unchangedSince');
      expect((await listed()).at(-1)).toMatchObject({ versionNumber: 4, automatic: false });
      await flushAutoCheckpoints();
      expect(await listed()).toHaveLength(4);
    });
  });

  it('checkpoint view keeps its discussion context', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const legacy = await createLegacyDocument(storage, '<!doctype html><html><body><p>Ship the editor first.</p></body></html>');
      const created = await app.request(`/api/versions/${legacy.versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'the editor', prefix: '', suffix: '', containerPath: 'body' },
          body: 'Which editor?',
        }),
      });
      const thread = (await created.json()) as { id: string };
      await publish(storage, { content: SOURCE, format: 'markdown', documentId: legacy.documentId });

      const res = await app.request(`/api/documents/${legacy.documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS });
      const checkpoint = (await res.json()) as CheckpointResponse;
      // Resolving later changes the live discussion, not the checkpoint's.
      await app.request(`/api/threads/${thread.id}/resolve`, { method: 'POST', headers: CSRF_HEADERS });

      const kept = JSON.parse(dec(await readBundleFile(storage, await bundleOf(checkpoint.versionId), 'threads.json'))) as BundleThread[];
      expect(kept).toEqual([expect.objectContaining({ threadId: thread.id, quote: 'the editor', commentCount: 1 })]);
      // The thread is listed on the checkpoint, anchored by its comment mark.
      const listed = await app.request(`/api/versions/${checkpoint.versionId}/threads`);
      const body = (await listed.json()) as { threads: { id: string; contextChanged: boolean }[] };
      expect(body.threads).toEqual([expect.objectContaining({ id: thread.id, contextChanged: false })]);
    });
  });

  it('versions from before the document went live are listed as not bundled', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const legacy = await createLegacyDocument(storage, '<!doctype html><html><body><p>Before live.</p></body></html>');
      const live = await publish(storage, { content: SOURCE, format: 'markdown', documentId: legacy.documentId });
      const list = (await (await app.request(`/api/documents/${legacy.documentId}/versions`)).json()) as {
        versions: { id: string; versionNumber: number; bundled?: boolean }[];
      };
      const byNumber = new Map(list.versions.map((v) => [v.versionNumber, v]));
      expect(byNumber.get(legacy.versionNumber!)!.bundled).toBe(false);
      expect(byNumber.get(live.versionNumber!)!.bundled).toBe(true);
      // The old version has no Y.Doc to preview, but its HTML still renders.
      expect((await app.request(`/api/versions/${legacy.versionId}/ydoc`)).status).toBe(404);
      const html = await app.request(`/api/versions/${legacy.versionId}/content`);
      expect(await html.text()).toContain('Before live.');
    });
  });

  it('print renders the checkpoint or the live state, light and sandboxed', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const { documentId } = await publish(storage, { content: SOURCE, format: 'markdown' });
      const checkpoint = (await (await app.request(`/api/documents/${documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS })).json()) as CheckpointResponse;
      await setText(documentId, 'Then tabs.', 'Then tabs, and comments.');

      const frozen = await app.request(`/api/documents/${documentId}/print?version=${checkpoint.versionNumber}`);
      expect(frozen.status).toBe(200);
      const frozenHtml = await frozen.text();
      expect(frozenHtml).toContain('Then tabs.');
      expect(frozenHtml).not.toContain('and comments');
      expect(frozenHtml).toContain('window.print()');
      expect(frozenHtml).toContain('@page');
      expect(frozen.headers.get('content-security-policy')).toContain("connect-src 'none'");

      const live = await (await app.request(`/api/documents/${documentId}/print`)).text();
      expect(live).toContain('Then tabs, and comments.');

      expect((await app.request(`/api/documents/${documentId}/print?version=99`)).status).toBe(404);
    });
  });

  it('compare diffs the Markdown exports', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const v1 = await publish(storage, { content: SOURCE, format: 'markdown' });
      await setText(v1.documentId, 'Then tabs.', 'Then tabs and comments.');
      await app.request(`/api/documents/${v1.documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS });
      const exported = async (n: number) => {
        const res = await app.request(`/api/documents/${v1.documentId}/export?version=${n}`);
        expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
        return res.text();
      };
      const [a, b] = [await exported(1), await exported(2)];
      expect(a).toBe(SOURCE);
      expect(b).toBe(SOURCE.replace('Then tabs.', 'Then tabs and comments.'));
      // The checkpoint's frozen state is what BlockNote's version preview loads.
      const ydoc = await app.request(`/api/versions/${v1.versionId}/ydoc`);
      expect(ydoc.headers.get('content-type')).toBe('application/octet-stream');
      expect((await ydoc.arrayBuffer()).byteLength).toBeGreaterThan(0);
    });
  });

  it('files are served by the document read check and never run', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const { documentId } = await publish(storage, { content: SOURCE, format: 'markdown' });
      const upload = async (name: string, type: string, body: string) => {
        const fd = new FormData();
        fd.append('file', new Blob([body], { type }), name);
        const res = await app.request(`/api/documents/${documentId}/files`, { method: 'POST', headers: CSRF_HEADERS, body: fd });
        expect(res.status).toBe(201);
        return (await res.json()) as { fileId: string; url: string };
      };
      const png = await upload('a.png', 'image/png', 'png-bytes');
      expect(png.url).toBe(`primer-blob://${png.fileId}`);
      const image = await app.request(`/api/files/${png.fileId}?doc=${documentId}`);
      expect(image.headers.get('content-type')).toBe('image/png');
      expect(image.headers.get('content-security-policy')).toContain('sandbox');
      const page = await upload('x.html', 'text/html', '<script>alert(1)</script>');
      const served = await app.request(`/api/files/${page.fileId}?doc=${documentId}`);
      expect(served.headers.get('content-type')).toBe('application/octet-stream');
      expect(served.headers.get('content-disposition')).toBe('attachment');
      expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  it("a file id from another document is neither served nor bundled", async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const a = await publish(storage, { content: SOURCE, format: 'markdown' });
      const b = await publish(storage, { content: SOURCE, format: 'markdown' });
      const upload = async (documentId: string) => {
        const fd = new FormData();
        fd.append('file', new Blob(['png'], { type: 'image/png' }), 'a.png');
        const res = await app.request(`/api/documents/${documentId}/files`, { method: 'POST', headers: CSRF_HEADERS, body: fd });
        return (await res.json()) as { fileId: string; url: string };
      };
      const own = await upload(a.documentId);
      const foreign = await upload(b.documentId);

      // An editor of A plants both ids in A's content (block props are theirs to write).
      const image = (id: string, url: string) => ({ id, type: 'image', props: { url } });
      await applyPlan(a.documentId, originFor(MOCK_USER), {
        onConflict: 'refuse',
        edits: [{
          target: { tabId: 'main', blockId: '' },
          inverse: false,
          build: (tr) => {
            const nodes = serverEditor()._blocksToProsemirrorNode([image('img-own', own.url), image('img-foreign', foreign.url)] as never);
            tr.insert(tr.doc.content.size - 1, nodes.content);
          },
        }],
      });

      expect((await app.request(`/api/files/${own.fileId}?doc=${a.documentId}`)).status).toBe(200);
      expect((await app.request(`/api/files/${foreign.fileId}?doc=${a.documentId}`)).status).toBe(404);
      expect((await app.request(`/api/files/${foreign.fileId}`)).status).toBe(404);

      const res = await app.request(`/api/documents/${a.documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS });
      const checkpoint = (await res.json()) as CheckpointResponse;
      const files = JSON.parse(dec(await readBundleFile(storage, await bundleOf(checkpoint.versionId), 'files.json'))) as string[];
      expect(files).toEqual([own.fileId]);
    });
  });
});
