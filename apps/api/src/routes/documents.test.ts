import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documents, documentViews, versions, users, documentCollaborators, externalShares } from '../db/schema.ts';
import type { DocumentDetailResponse, UploadResponse } from '@polygonlabs/primer-api-types';
import type { DocumentPatchRequest } from '@polygonlabs/primer-api-types';
import { CSRF_HEADERS, asUser, asUserJson } from '../test/harness.ts';
import { generateShareToken } from '../external/tokens.ts';

async function uploadFixture(app: ReturnType<typeof createApp>): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><p>x</p></body></html>'], { type: 'text/html' }), 'r.html');
  fd.append('title', 'Fixture');
  fd.append('description', 'desc');
  const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  return (await res.json()) as UploadResponse;
}

describe('GET /api/documents/:docId', () => {
  it('returns document + latest version summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docread-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DocumentDetailResponse;

      expect(body.document.id).toBe(upload.documentId);
      expect(body.document.title).toBe('Fixture');
      expect(body.document.description).toBe('desc');
      expect(body.document.uploaderDisplayName).toBe('Mock User');
      expect(body.document.visibility).toBe('org');
      expect(body.latestVersion.id).toBe(upload.versionId);
      expect(body.latestVersion.versionNumber).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for an unknown id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docread-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const res = await app.request('/api/documents/01234567-89ab-cdef-0123-456789abcdef');
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('GET /api/documents/:docId — view tracking', () => {
  it('upserts document_views on every hit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docview-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const r1 = await app.request(`/api/documents/${upload.documentId}`);
      expect(r1.status).toBe(200);
      const rows1 = await db
        .select()
        .from(documentViews)
        .where(eq(documentViews.documentId, upload.documentId));
      expect(rows1).toHaveLength(1);
      const firstViewedAt = rows1[0].viewedAt;

      await new Promise((r) => setTimeout(r, 50));
      const r2 = await app.request(`/api/documents/${upload.documentId}`);
      expect(r2.status).toBe(200);
      const rows2 = await db
        .select()
        .from(documentViews)
        .where(eq(documentViews.documentId, upload.documentId));
      expect(rows2).toHaveLength(1);
      expect(rows2[0].viewedAt.getTime()).toBeGreaterThan(firstViewedAt.getTime());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('GET /api/documents/:docId — soft-delete visibility', () => {
  it('returns 404 when the document is soft-deleted, even for the uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-softdelete-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      // Soft-delete via direct DB write.
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not_found');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not upsert document_views for a soft-deleted doc', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-softdelete-views-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));

      await app.request(`/api/documents/${upload.documentId}`);

      const rows = await db
        .select()
        .from(documentViews)
        .where(eq(documentViews.documentId, upload.documentId));
      expect(rows).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PATCH /api/documents/:docId', () => {
  it('updates title by uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-doc-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const body: DocumentPatchRequest = { title: 'New Title' };
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { id: string; title: string };
      expect(out.title).toBe('New Title');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates description (including null to clear)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-desc-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const r1 = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ description: 'Updated desc' }),
      });
      expect(r1.status).toBe(200);
      expect(((await r1.json()) as { description: string | null }).description).toBe('Updated desc');

      const r2 = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ description: null }),
      });
      expect(r2.status).toBe(200);
      expect(((await r2.json()) as { description: string | null }).description).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 400 when body is empty (no fields)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-empty-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 400 for empty title after trim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-empty-title-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '   ' }),
      });
      expect(res.status).toBe(400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 403 when not uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-403-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const otherUserId = 'other-user-patch';
      await db
        .insert(users)
        .values({ id: otherUserId, email: 'op@p.t', displayName: 'OtherP' })
        .onConflictDoNothing();
      const docId = uuidv7();
      const versionId = uuidv7();
      await db.insert(documents).values({
        id: docId,
        title: 'Theirs',
        description: null,
        uploaderId: otherUserId,
      });
      await db.insert(versions).values({
        id: versionId,
        documentId: docId,
        versionNumber: 1,
        storageKey: `v1/${versionId}.html`,
        sizeBytes: 0,
        versionNote: null,
      });

      const res = await app.request(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Sneaky' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 when soft-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-patch-404-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Cant edit' }),
      });
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('DELETE /api/documents/:docId', () => {
  it('soft-deletes by uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-delete-doc-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { id: string; deletedAt: string };
      expect(out.id).toBe(upload.documentId);
      expect(typeof out.deletedAt).toBe('string');

      const [row] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, upload.documentId));
      expect(row.deletedAt).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is idempotent on already-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-delete-idempotent-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      await app.request(`/api/documents/${upload.documentId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      const res = await app.request(`/api/documents/${upload.documentId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      expect(res.status).toBe(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 403 when not uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-delete-403-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const otherUserId = 'other-user-delete';
      await db.insert(users).values({ id: otherUserId, email: 'od@p.t', displayName: 'OtherD' }).onConflictDoNothing();
      const docId = uuidv7();
      await db.insert(documents).values({
        id: docId,
        title: 'Theirs',
        description: null,
        uploaderId: otherUserId,
      });

      const res = await app.request(`/api/documents/${docId}`, { method: 'DELETE', headers: CSRF_HEADERS });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import type { AddVersionResponse, VersionsListResponse } from '@polygonlabs/primer-api-types';
import { createLegacyDocument } from '../testing/legacy.ts';

function buildVersionFormData(html: string, versionNote?: string): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([html], { type: 'text/html' }), 'v2.html');
  if (versionNote !== undefined) fd.append('versionNote', versionNote);
  return fd;
}

describe('POST /api/documents/:docId/versions', () => {
  it('adds a new version with version_number incremented', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const fd = buildVersionFormData(
        '<html><body><h1>V2</h1></body></html>',
        'second version'
      );
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: CSRF_HEADERS,
        body: fd,
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as AddVersionResponse;
      expect(out.versionNumber).toBe(2);
      expect(out.url).toBe(`/d/${upload.documentId}`);

      const allVersions = await db
        .select()
        .from(versions)
        .where(eq(versions.documentId, upload.documentId));
      expect(allVersions).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 when doc is soft-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-404-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));

      const fd = buildVersionFormData('<html><body></body></html>');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: CSRF_HEADERS,
        body: fd,
      });
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 403 when not uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-403-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const otherUserId = 'other-user-addver';
      await db.insert(users).values({ id: otherUserId, email: 'oa@p.t', displayName: 'OtherA' }).onConflictDoNothing();
      const docId = uuidv7();
      const versionId = uuidv7();
      await db.insert(documents).values({
        id: docId,
        title: 'Theirs',
        description: null,
        uploaderId: otherUserId,
      });
      await db.insert(versions).values({
        id: versionId,
        documentId: docId,
        versionNumber: 1,
        storageKey: `v1/${versionId}.html`,
        sizeBytes: 0,
        versionNote: null,
      });

      const fd = buildVersionFormData('<html><body></body></html>');
      const res = await app.request(`/api/documents/${docId}/versions`, {
        method: 'POST',
        headers: CSRF_HEADERS,
        body: fd,
      });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects too_large / bad_extension via the existing upload validators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-bad-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const big = 'x'.repeat(10 * 1024 * 1024 + 1);
      const fd = new FormData();
      fd.append('file', new Blob([big], { type: 'text/html' }), 'big.html');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: CSRF_HEADERS,
        body: fd,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('too_large');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a .md version makes a legacy document live, rendered as an artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-addver-md-'));
    try {
      const storage = new FilesystemStorage(root);
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const upload = await createLegacyDocument(storage, '<html><body><p>x</p></body></html>');

      const md = '---\ntitle: ignored\n---\n\n# v2\n\nNew content.';
      const fd = new FormData();
      fd.append('file', new Blob([md], { type: 'text/markdown' }), 'notes.md');

      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: CSRF_HEADERS,
        body: fd,
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as AddVersionResponse;
      expect(out.versionNumber).toBe(2);

      const versionRows = await db
        .select()
        .from(versions)
        .where(eq(versions.id, out.versionId!));
      expect(versionRows).toHaveLength(1);

      const stream = await storage.get(versionRows[0].storageKey);
      const reader = stream.getReader();
      let combined = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        combined += new TextDecoder().decode(value);
      }
      expect(combined).toMatch(/<h1[^>]*>v2<\/h1>/);
      expect(combined).toMatch(/<p[^>]*>New content\.<\/p>/);
      expect(versionRows[0].bundleKey).toBe(`bundles/${out.versionId}/`);
      // Primer-authored Markdown carries the theme-ownership marker.
      expect(combined).toContain('data-primer-theme="managed"');
      expect(combined).toContain('<script src="/companion/v1.js"');
      expect(combined).not.toContain('---'); // frontmatter stripped
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('GET /api/documents/:docId/versions', () => {
  it('returns all versions ordered by versionNumber DESC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-listver-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      // Add v2 + v3 via direct DB inserts so this test doesn't depend on
      // the POST endpoint.
      const v2Id = uuidv7();
      const v3Id = uuidv7();
      await db.insert(versions).values([
        {
          id: v2Id,
          documentId: upload.documentId,
          versionNumber: 2,
          storageKey: `v1/${v2Id}.html`,
          sizeBytes: 100,
          versionNote: 'second',
        },
        {
          id: v3Id,
          documentId: upload.documentId,
          versionNumber: 3,
          storageKey: `v1/${v3Id}.html`,
          sizeBytes: 200,
          versionNote: null,
        },
      ]);

      const res = await app.request(`/api/documents/${upload.documentId}/versions`);
      expect(res.status).toBe(200);
      const out = (await res.json()) as VersionsListResponse;
      expect(out.versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
      expect(out.versions[1].versionNote).toBe('second');
      expect(out.versions[0].versionNote).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 when doc is soft-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-listver-404-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}/versions`);
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('GET /api/documents/:docId — uploaderId in response', () => {
  it('includes uploaderId in the document detail body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-uploaderid-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { document: { uploaderId: string } };
      expect(body.document.uploaderId).toBe('mock-user-1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('POST /api/documents/:docId/restore', () => {
  it('clears deletedAt when called within 30 days', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-restore-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}/restore`, { method: 'POST', headers: CSRF_HEADERS });
      expect(res.status).toBe(200);

      const [row] = await db
        .select({ deletedAt: documents.deletedAt })
        .from(documents)
        .where(eq(documents.id, upload.documentId));
      expect(row.deletedAt).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 409 when deleted more than 30 days ago', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-restore-expired-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await db
        .update(documents)
        .set({ deletedAt: thirtyOneDaysAgo })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request(`/api/documents/${upload.documentId}/restore`, { method: 'POST', headers: CSRF_HEADERS });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('restore_window_expired');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is idempotent on live doc (200, no change)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-restore-live-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}/restore`, { method: 'POST', headers: CSRF_HEADERS });
      expect(res.status).toBe(200);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 403 when not uploader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-restore-403-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const otherUserId = 'other-user-restore';
      await db.insert(users).values({ id: otherUserId, email: 'or@p.t', displayName: 'OtherR' }).onConflictDoNothing();
      const docId = uuidv7();
      await db.insert(documents).values({
        id: docId,
        title: 'Theirs',
        description: null,
        uploaderId: otherUserId,
        deletedAt: new Date(),
      });

      const res = await app.request(`/api/documents/${docId}/restore`, { method: 'POST', headers: CSRF_HEADERS });
      expect(res.status).toBe(403);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-docs-multi-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    await db.insert(users).values([
      { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
      { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
    ]).onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('doc access under visibility + collaborators', () => {
  it('GET private doc as non-collab returns 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);          // owned by mock-user-1
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));
      const res = await app.request(
        `/api/documents/${upload.documentId}`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(404);
    });
  });

  it('GET private doc as commenter collab returns 200', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(200);
    });
  });

  it('POST version as editor collab returns 201', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><h1>v2</h1></body></html>'], { type: 'text/html' }), 'v2.html');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
        body: fd,
      });
      expect(res.status).toBe(201);
    });
  });

  it('POST version as commenter collab returns 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'v.html');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
        body: fd,
      });
      expect(res.status).toBe(403);
    });
  });

  it('GET org doc as a reader without a collaborator row reports stranger role and canComment', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`, { headers: asUser('mock-user-2') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { myRole: string; canComment: boolean };
      expect(body.myRole).toBe('stranger');
      expect(body.canComment).toBe(true);
    });
  });

  it('GET private doc as responder returns 200 with myRole responder', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'responder',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(
        `/api/documents/${upload.documentId}`,
        { headers: asUser('mock-user-2') },
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { myRole?: string }).myRole).toBe('responder');
    });
  });

  it('POST version as responder collab returns 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'responder',
        grantedBy: 'mock-user-1',
      });
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'v.html');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
        body: fd,
      });
      expect(res.status).toBe(403);
    });
  });

  it('PATCH title as responder returns 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'responder',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: { ...asUser('mock-user-2'), 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('DELETE as editor collab returns 403 (manage is owner-only)', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'DELETE',
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(403);
    });
  });
});

describe('PATCH /api/documents/:docId visibility', () => {
  it('owner can flip visibility to private', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ visibility: 'private' }),
      });
      expect(res.status).toBe(200);
      const patchBody = (await res.json()) as { visibility: 'org' | 'private' };
      expect(patchBody.visibility).toBe('private');
      const [row] = await db
        .select({ visibility: documents.visibility })
        .from(documents)
        .where(eq(documents.id, upload.documentId));
      expect(row.visibility).toBe('private');
    });
  });

  it('editor collab CANNOT flip visibility (canManage owner-only)', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ visibility: 'private' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('mixed body (title + visibility) requires canManage', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      // Editor can PATCH title alone (canEdit)…
      const okRes = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ title: 'Edited by editor' }),
      });
      expect(okRes.status).toBe(200);
      // …but not title + visibility (mixed body is manage).
      const denyRes = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ title: 'Sneak', visibility: 'private' }),
      });
      expect(denyRes.status).toBe(403);
    });
  });

  it('invalid visibility value → 400', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ visibility: 'public' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });
  });
});

describe('GET /api/documents/:docId — externallyShared flag', () => {
  it('reports externallyShared on the document payload', async () => {
    await withMultiUserApp(async (app) => {
      const { documentId } = await uploadFixture(app);

      const before = await app.request(`/api/documents/${documentId}`, { headers: asUser('mock-user-1') });
      expect(((await before.json()) as { document: { externallyShared: boolean } }).document.externallyShared).toBe(false);

      await db.insert(externalShares).values({
        id: uuidv7(), documentId, shareToken: generateShareToken(), createdBy: 'mock-user-1',
      });

      const after = await app.request(`/api/documents/${documentId}`, { headers: asUser('mock-user-1') });
      expect(((await after.json()) as { document: { externallyShared: boolean } }).document.externallyShared).toBe(true);
    });
  });
});
