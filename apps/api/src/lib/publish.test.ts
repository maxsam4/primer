import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { UploadResponse } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { db } from '../db/client.ts';
import { docUpdates, documents, threadPlacements, versions } from '../db/schema.ts';
import { readBundleFile } from '../live/bundle.ts';
import { withLiveDoc } from '../live/live.testlib.ts';
import { buildMcpToolHandlers } from '../mcp/tools.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { MOCK_USER } from '../auth/resolver.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import type { Storage } from '../storage/types.ts';
import { CSRF_HEADERS } from '../test/harness.ts';
import { publishDocument, type PublishInput } from './publish.ts';

async function withStorage<T>(fn: (storage: FilesystemStorage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-publish-test-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function bytesAt(storage: Storage, key: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await storage.get(key)).arrayBuffer());
}

const enc = (s: string) => new TextEncoder().encode(s);

function md(content: string, extra: Partial<PublishInput> = {}): PublishInput {
  return { actor: MOCK_USER, title: 'Doc', content: enc(content), filename: 'doc.md', format: 'markdown', ...extra };
}

// Version preconditions apply to version-only (HTML) documents; Markdown
// documents are live and edited in place.
function html(content: string, extra: Partial<PublishInput> = {}): PublishInput {
  return { actor: MOCK_USER, title: 'Doc', content: enc(`<!doctype html><html><body>${content}</body></html>`), filename: 'doc.html', format: 'html', ...extra };
}

async function publishOk(storage: Storage, input: PublishInput) {
  const r = await publishDocument(storage, input);
  if (!r.ok) throw new Error(`publish refused: ${r.refusal.code}`);
  return r;
}

describe('publishDocument', () => {
  it('stores the uploaded bytes verbatim as the original', async () => {
    await withStorage(async (storage) => {
      const r = await publishOk(storage, md('# Hi\n'));
      const [row] = await db.select().from(versions).where(eq(versions.id, r.versionId));
      expect(row.sourceFormat).toBe('markdown');
      expect(row.originalKey).toBe(`v1/${r.versionId}.orig`);
      expect(await bytesAt(storage, row.originalKey!)).toEqual(enc('# Hi\n'));
    });
  });

  it('stale baseVersionNumber is refused', async () => {
    await withStorage(async (storage) => {
      const v1 = await publishOk(storage, html('<h1>One</h1>'));
      await publishOk(storage, html('<h1>Two</h1>', { documentId: v1.documentId, baseVersionNumber: 1 }));

      const r = await publishDocument(storage, html('<h1>Three</h1>', { documentId: v1.documentId, baseVersionNumber: 1 }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(409);
      expect(r.refusal.code).toBe('stale_base');
      expect(r.refusal.fix).toContain('2');
      const rows = await db.select().from(versions).where(eq(versions.documentId, v1.documentId));
      expect(rows).toHaveLength(2);
    });
  });

  it('concurrent publishes on the same base: exactly one wins', async () => {
    await withStorage(async (storage) => {
      const v1 = await publishOk(storage, html('<h1>One</h1>'));
      const results = await Promise.all(
        ['<h1>A</h1>', '<h1>B</h1>'].map((c) => publishDocument(storage, html(c, { documentId: v1.documentId, baseVersionNumber: 1 }))),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const refused = results.find((r) => !r.ok);
      expect(refused && !refused.ok && refused.refusal.code).toBe('stale_base');
    });
  });

  it('REST and MCP produce the same document', async () => {
    await withStorage(async (storage) => {
      const source = '# Same\n\nBody text.\n';
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const fd = new FormData();
      fd.append('file', new Blob([source], { type: 'text/markdown' }), 'same.md');
      fd.append('title', 'Same');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(200);
      const rest = (await res.json()) as UploadResponse;

      const handlers = buildMcpToolHandlers({ storage, notifier: new NoopNotifier(), apiBaseUrl: 'https://primer.example.com' });
      const out = await handlers.primer_create_document({ title: 'Same', content: source, format: 'markdown' }, MOCK_USER);
      expect(out.isError).toBeUndefined();
      const mcp = JSON.parse(out.content[0].text) as { versionId: string };

      // Block ids differ per import, so compare what each one exports.
      const exportOf = async (id: string) => {
        const [row] = await db.select({ k: versions.bundleKey }).from(versions).where(eq(versions.id, id));
        return new TextDecoder().decode(await readBundleFile(storage, row!.k!, 'export.md'));
      };
      expect(await exportOf(mcp.versionId)).toBe(source);
      expect(await exportOf(rest.versionId)).toBe(source);
    });
  });

  it('markdown upload creates a live document with checkpoint 1', async () => {
    await withStorage(async (storage) => {
      const source = '---\ntitle: Plan\n---\n\n# Plan\n\n- one\n- two\n';
      const r = await publishOk(storage, md(source));
      expect(r.versionNumber).toBe(1);
      const [doc] = await db.select().from(documents).where(eq(documents.id, r.documentId));
      expect(doc!.format).toBe('markdown');
      expect(doc!.metadata).toEqual({ title: 'Plan' });
      const [version] = await db.select().from(versions).where(eq(versions.id, r.versionId));
      const updates = await db.select().from(docUpdates).where(eq(docUpdates.documentId, r.documentId));
      expect(updates).toHaveLength(1);
      expect(version!.docVersion).toBe(updates[0]!.id);
      expect(version!.storageKey).toBe(`bundles/${r.versionId}/static.html`);
      // The live document holds the import, and exports the file unchanged.
      const blocks = await withLiveDoc(r.documentId, (d) => d.getXmlFragment('document-store').length);
      expect(blocks).toBeGreaterThan(0);
      expect(new TextDecoder().decode(await readBundleFile(storage, version!.bundleKey!, 'export.md'))).toBe(source);

      // Another format can't be merged into it.
      const again = await publishDocument(storage, html('<p>Other</p>', { documentId: r.documentId }));
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.refusal).toMatchObject({ code: 'bad_request' });
    });
  });

  it('legacy Markdown doc converts and re-anchors open threads by quote', async () => {
    await withStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const legacy = await publishOk(storage, html('<p>Revenue grew in March.</p><p>Churn fell.</p>'));
      const thread = async (quote: string) => {
        const res = await app.request(`/api/versions/${legacy.versionId}/threads`, {
          method: 'POST',
          headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify({ anchor: { type: 'text-range', selectorText: quote, prefix: '', suffix: '', containerPath: 'body' }, body: 'why?' }),
        });
        expect(res.status).toBe(201);
        return ((await res.json()) as { id: string }).id;
      };
      const kept = await thread('grew in March');
      const gone = await thread('Churn fell');

      const r = await publishOk(storage, md('# Q1\n\nRevenue grew in March, again.\n', { documentId: legacy.documentId }));
      expect(r.versionNumber).toBe(2);
      const [doc] = await db.select().from(documents).where(eq(documents.id, legacy.documentId));
      expect(doc!.format).toBe('markdown');

      // The found quote carries its thread's comment mark in the live document.
      const marked = await withLiveDoc(legacy.documentId, (d) => d.getXmlFragment('document-store').toString());
      expect(marked).toContain(kept);
      expect(marked).not.toContain(gone);
      // Both threads stay listed on the new checkpoint; the lost one is orphaned.
      const placements = await db.select().from(threadPlacements).where(eq(threadPlacements.versionId, r.versionId));
      expect(placements.find((p) => p.threadId === kept)!.anchor).not.toBeNull();
      expect(placements.find((p) => p.threadId === gone)!.anchor).toBeNull();
    });
  });
});
