import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import type { CheckpointResponse } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { MOCK_USER } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { docUpdates, versions } from '../db/schema.ts';
import { publishDocument } from '../lib/publish.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import type { Storage } from '../storage/types.ts';
import { CSRF_HEADERS } from '../test/harness.ts';
import { readBundleFile } from './bundle.ts';
import { createCheckpoint, restoreCheckpoint } from './checkpoint.ts';
import { readBlocks, serverEditor } from './editor.ts';
import { exportMarkdown } from './export.ts';
import { withLiveDoc } from './live.testlib.ts';
import { originFor } from './origin.ts';
import { applyPlan } from './pipeline.ts';
import { tabsOf } from './reach.ts';
import { createLegacyDocument } from '../testing/legacy.ts';

const SOURCE = '# Plan\n\nShip the editor first.\n';
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function withStorage<T>(fn: (storage: FilesystemStorage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-tabs-test-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function publish(storage: Storage, content: string, extra: { documentId?: string; format?: 'html' | 'markdown' } = {}) {
  const format = extra.format ?? 'markdown';
  const r = await publishDocument(storage, {
    actor: MOCK_USER,
    title: 'Plan',
    filename: format === 'html' ? 'plan.html' : 'plan.md',
    format,
    documentId: extra.documentId,
    content: new TextEncoder().encode(content),
  });
  if (!r.ok) throw new Error(`publish refused: ${r.refusal.code}`);
  return r;
}

/** What an editor's client does: the tab list is plain Yjs state. */
const setTabs = (documentId: string, tabs: { id: string; title: string }[]) =>
  withLiveDoc(documentId, (doc) =>
    doc.transact(() => {
      const array = doc.getArray('tabs');
      array.delete(0, array.length);
      array.push(tabs);
    }),
  );

/** Replaces a tab's content with one paragraph, through the pipeline. */
const fillTab = (documentId: string, tabId: string, text: string, blockId = `${tabId}-p`) =>
  applyPlan(documentId, originFor(MOCK_USER), {
    onConflict: 'refuse',
    edits: [
      {
        target: { tabId, blockId: '' },
        inverse: false,
        build: (tr) => {
          tr.replaceWith(0, tr.doc.content.size, serverEditor()._blocksToProsemirrorNode([{ id: blockId, type: 'paragraph', content: text }] as never).content);
        },
      },
    ],
  });

const fragmentText = (documentId: string, name: string) => withLiveDoc(documentId, (doc) => doc.getXmlFragment(name).toString());

describe('tabs', () => {
  it('pipeline edits on a second tab leave the main tab untouched', async () => {
    await withStorage(async (storage) => {
      const { documentId } = await publish(storage, SOURCE);
      await setTabs(documentId, [{ id: 'main', title: '' }, { id: 'notes', title: 'Notes' }]);
      await fillTab(documentId, 'notes', 'First notes.');
      const main = await fragmentText(documentId, 'document-store');

      await fillTab(documentId, 'notes', 'Second notes.');
      expect(await fragmentText(documentId, 'document-store')).toBe(main);
      expect(await fragmentText(documentId, 'tab/notes')).toContain('Second notes.');
      const [last] = await db.select().from(docUpdates).where(eq(docUpdates.documentId, documentId)).orderBy(desc(docUpdates.id)).limit(1);
      const mainIds = await withLiveDoc(documentId, (doc) => readBlocks(doc, 'main').map((b) => b.id));
      expect(last!.touched.some((id) => mainIds.includes(id))).toBe(false);
      expect(last!.touched).toContain('notes-p');
    });
  });

  it('export and checkpoint include every tab', async () => {
    await withStorage(async (storage) => {
      const { documentId } = await publish(storage, SOURCE);
      await setTabs(documentId, [{ id: 'main', title: '' }, { id: 'notes', title: 'Meeting\nnotes' }]);
      await fillTab(documentId, 'notes', 'Decided to ship tabs.');
      const expected = `${SOURCE}\n# Meeting notes\n\nDecided to ship tabs.\n`;
      expect(await withLiveDoc(documentId, (doc) => exportMarkdown(doc, documentId))).toBe(expected);

      const checkpoint = await createCheckpoint(storage, documentId, MOCK_USER, null);
      const [row] = await db.select().from(versions).where(eq(versions.id, checkpoint.versionId));
      expect(dec(await readBundleFile(storage, row!.bundleKey!, 'export.md'))).toBe(expected);
      const html = dec(await readBundleFile(storage, row!.bundleKey!, 'static.html'));
      expect(html).toContain('Meeting notes</h1>');
      expect(html).toContain('Decided to ship tabs.');

      // Deleting the tab and restoring the checkpoint brings it back.
      await setTabs(documentId, [{ id: 'main', title: '' }]);
      expect(await withLiveDoc(documentId, (doc) => exportMarkdown(doc, documentId))).toBe(SOURCE);
      await restoreCheckpoint(storage, { documentId, bundleKey: row!.bundleKey! }, MOCK_USER);
      expect(await withLiveDoc(documentId, (doc) => tabsOf(doc).map((t) => t.id))).toEqual(['main', 'notes']);
      expect(await withLiveDoc(documentId, (doc) => exportMarkdown(doc, documentId))).toBe(expected);
    });
  });

  it('a tab left inside a code fence does not swallow the next tab heading', async () => {
    await withStorage(async (storage) => {
      const { documentId } = await publish(storage, '# Plan\n\n```js\nconst a = 1;\n');
      await setTabs(documentId, [{ id: 'main', title: '' }, { id: 'notes', title: 'Notes' }]);
      await fillTab(documentId, 'notes', 'Hello.');
      const out = await withLiveDoc(documentId, (doc) => exportMarkdown(doc, documentId));
      expect(out).toBe('# Plan\n\n```js\nconst a = 1;\n```\n\n# Notes\n\nHello.\n');
    });
  });

  it('deleting a tab orphans its threads', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const legacy = await createLegacyDocument(storage, '<!doctype html><html><body><p>Open questions here.</p></body></html>');
      const created = await app.request(`/api/versions/${legacy.versionId}/threads`, {
        method: 'POST',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'Open questions', prefix: '', suffix: '', containerPath: 'body' },
          body: 'Which ones?',
        }),
      });
      const thread = (await created.json()) as { id: string };
      const { documentId } = await publish(storage, SOURCE, { documentId: legacy.documentId });

      // The thread's text lives in a second tab, marked there.
      await setTabs(documentId, [{ id: 'main', title: '' }, { id: 'notes', title: 'Notes' }]);
      await fillTab(documentId, 'notes', 'Open questions here.');
      await applyPlan(documentId, originFor(MOCK_USER), {
        onConflict: 'refuse',
        edits: [
          {
            target: { tabId: 'notes', blockId: 'notes-p' },
            inverse: false,
            build: (tr, at) => {
              tr.addMark(at!.pos + 2, at!.pos + 2 + 'Open questions'.length, tr.doc.type.schema.marks.comment!.create({ threadId: thread.id, orphan: false }));
            },
          },
        ],
      });
      const placedOn = async () => {
        const res = await app.request(`/api/documents/${documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS });
        const checkpoint = (await res.json()) as CheckpointResponse;
        const listed = await app.request(`/api/versions/${checkpoint.versionId}/threads`);
        return ((await listed.json()) as { threads: { id: string; contextChanged: boolean }[] }).threads;
      };
      expect(await placedOn()).toEqual([expect.objectContaining({ id: thread.id, contextChanged: false })]);

      // Deleting the tab leaves its fragment unreachable: the thread stays
      // listed, with its quote, but without an anchor.
      await setTabs(documentId, [{ id: 'main', title: '' }]);
      expect(await placedOn()).toEqual([expect.objectContaining({ id: thread.id, contextChanged: true })]);
    });
  });
});
