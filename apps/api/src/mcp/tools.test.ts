import { describe, it, expect, beforeEach } from 'vitest';
import { insertThread } from '../testing/threads.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { documents, documentCollaborators, users, versions, threads, comments } from '../db/schema.ts';
import { buildMcpToolHandlers, type ToolDeps } from './tools.ts';
import { v7 as uuidv7 } from 'uuid';

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({ id, email: `${id}@x.test`, displayName: id });
}

/** Insert a thread with a single comment on a version; returns their ids. */
async function seedThreadWithComment(
  versionId: string,
  authorId: string,
  body: string,
): Promise<{ threadId: string; commentId: string }> {
  const threadId = uuidv7();
  const commentId = uuidv7();
  await insertThread({
    id: threadId,
    versionId,
    anchor: { type: 'text-range', selectorText: body.slice(0, 20) },
  });
  await db.insert(comments).values({
    id: commentId,
    threadId,
    authorId,
    body,
    mentions: [],
  });
  return { threadId, commentId };
}

async function withDeps<T>(fn: (deps: ToolDeps) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-mcp-tools-'));
  try {
    const storage = new FilesystemStorage(root);
    const notifier = new NoopNotifier();
    return await fn({ storage, notifier, apiBaseUrl: 'https://primer.example.com' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM comments`);
  await db.execute(sql`DELETE FROM threads`);
  await db.execute(sql`DELETE FROM versions`);
  await db.execute(sql`DELETE FROM document_collaborators`);
  await db.execute(sql`DELETE FROM documents`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'tools-%'`);
});

describe('primer_whoami', () => {
  it('returns the user', async () => {
    await seedUser('tools-1');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_whoami({}, { id: 'tools-1', email: 'tools-1@x.test', displayName: 'tools-1' });
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.id).toBe('tools-1');
    });
  });
});

describe('primer_resolve_url', () => {
  it('extracts document + version from a Primer URL', async () => {
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_resolve_url(
        { url: 'https://primer.example.com/d/abc-123/v/2' },
        { id: 'tools-x', email: 'x@x.test', displayName: 'x' },
      );
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.documentId).toBe('abc-123');
      expect(parsed.versionNumber).toBe(2);
    });
  });

  it('returns bad_request on a non-Primer URL', async () => {
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_resolve_url(
        { url: 'https://example.com/foo' },
        { id: 'tools-x', email: 'x@x.test', displayName: 'x' },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });
});

describe('primer_create_document → primer_get_document (URL mode)', () => {
  it('creates a doc and reads it back by its URL', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const user = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

      const created = await handlers.primer_create_document(
        {
          title: 'Hello',
          content: '# hi',
          format: 'markdown',
        },
        user,
      );
      const createdBody = JSON.parse(created.content[0].text);
      expect(createdBody.documentId).toBeTruthy();
      expect(createdBody.url).toContain('/d/');

      const fetched = await handlers.primer_get_document(
        { url: createdBody.url },
        user,
      );
      const fetchedBody = JSON.parse(fetched.content[0].text);
      expect(fetchedBody.document.title).toBe('Hello');
    });
  });
});

describe('primer_get_document — open access path', () => {
  // Ownership rule: GET /api/documents/:docId has NO ownership gate —
  // any authenticated user can read a document (Primer is share-by-URL).
  // This test confirms the tool preserves that open-access model.
  it('returns the document for a different authenticated user', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-other');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'Private', content: '<p>hi</p>', format: 'html' },
        { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' },
      );
      const { documentId } = JSON.parse(created.content[0].text);
      const res = await handlers.primer_get_document(
        { documentId },
        { id: 'tools-other', email: 'tools-other@x.test', displayName: 'tools-other' },
      );
      // Open access: other user can read
      expect(res.isError).toBeFalsy();
      expect(res).toBeDefined();
      const body = JSON.parse(res.content[0].text);
      expect(body.document.visibility).toBe('org');
    });
  });
});

describe('primer_get_version_content', () => {
  const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

  it('returns HTML content when given a versionId', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C1', content: '<p>hello world</p>', format: 'html' },
        owner,
      );
      const { versionId, documentId } = JSON.parse(created.content[0].text);

      const res = await handlers.primer_get_version_content({ versionId }, owner);
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0].text);
      expect(body.documentId).toBe(documentId);
      expect(body.versionId).toBe(versionId);
      expect(body.versionNumber).toBe(1);
      expect(typeof body.sizeBytes).toBe('number');
      expect(body.content).toContain('hello world');
    });
  });

  it('returns the latest version when given only documentId', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C2', content: '<p>v1 body</p>', format: 'html' },
        owner,
      );
      const { documentId } = JSON.parse(created.content[0].text);

      const v2 = await handlers.primer_add_version(
        { documentId, content: '<p>v2 body</p>', format: 'html' },
        owner,
      );
      const { versionId: v2Id } = JSON.parse(v2.content[0].text);

      const res = await handlers.primer_get_version_content({ documentId }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.versionId).toBe(v2Id);
      expect(body.versionNumber).toBe(2);
      expect(body.content).toContain('v2 body');
    });
  });

  it('returns a specific version when given a URL with /v/<n>', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C3', content: '<p>v1 body</p>', format: 'html' },
        owner,
      );
      const { documentId, versionId: v1Id, url } = JSON.parse(created.content[0].text);
      await handlers.primer_add_version(
        { documentId, content: '<p>v2 body</p>', format: 'html' },
        owner,
      );

      const res = await handlers.primer_get_version_content({ url: `${url}/v/1` }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.versionId).toBe(v1Id);
      expect(body.versionNumber).toBe(1);
      expect(body.content).toContain('v1 body');
    });
  });

  it('returns latest when given a URL without /v/<n>', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C4', content: '<p>v1 body</p>', format: 'html' },
        owner,
      );
      const { documentId, url } = JSON.parse(created.content[0].text);
      const v2 = await handlers.primer_add_version(
        { documentId, content: '<p>v2 body</p>', format: 'html' },
        owner,
      );
      const { versionId: v2Id } = JSON.parse(v2.content[0].text);

      const res = await handlers.primer_get_version_content({ url }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.versionId).toBe(v2Id);
      expect(body.versionNumber).toBe(2);
      expect(body.content).toContain('v2 body');
    });
  });

  it('returns bad_request when no input given', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_version_content({}, owner);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });

  it('returns bad_request on a malformed URL', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_version_content(
        { url: 'not a Primer URL' },
        owner,
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });

  it('returns not_found for an unknown versionId', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_version_content(
        { versionId: '00000000-0000-0000-0000-000000000000' },
        owner,
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('not_found');
    });
  });

  it('returns not_found when the URL specifies a versionNumber that does not exist', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'C5', content: '<p>only v1</p>', format: 'html' },
        owner,
      );
      const { url } = JSON.parse(created.content[0].text);
      const res = await handlers.primer_get_version_content({ url: `${url}/v/9` }, owner);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('not_found');
    });
  });
});

async function seedDocOwnedBy(ownerId: string): Promise<{ docId: string; versionId: string }> {
  const docId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: docId,
    title: 'X',
    description: null,
    uploaderId: ownerId,
  });
  await db.insert(versions).values({
    id: versionId,
    documentId: docId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: null,
  });
  return { docId, versionId };
}

describe('MCP tools respect visibility + collab', () => {
  it('primer_get_document on private doc as stranger returns not_found', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-stranger');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, docId));
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_document(
        { documentId: docId },
        { id: 'tools-stranger', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('not_found');
    });
  });

  it('primer_get_document on private doc as commenter returns ok', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-commenter');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, docId));
    await db.insert(documentCollaborators).values({
      id: uuidv7(), documentId: docId, userId: 'tools-commenter',
      role: 'commenter', grantedBy: 'tools-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_document(
        { documentId: docId },
        { id: 'tools-commenter', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBeFalsy();
    });
  });

  it('primer_add_version as editor collab returns ok', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-editor');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(), documentId: docId, userId: 'tools-editor',
      role: 'editor', grantedBy: 'tools-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_add_version(
        { documentId: docId, content: '<html><body>x</body></html>', format: 'html' },
        { id: 'tools-editor', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBeFalsy();
    });
  });

  it('primer_add_version as commenter collab returns forbidden', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-commenter');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(), documentId: docId, userId: 'tools-commenter',
      role: 'commenter', grantedBy: 'tools-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_add_version(
        { documentId: docId, content: '<html><body>x</body></html>', format: 'html' },
        { id: 'tools-commenter', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('forbidden');
    });
  });
});

describe('MCP tools: responder role', () => {
  it('primer_get_document on private doc as responder returns ok', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-responder');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, docId));
    await db.insert(documentCollaborators).values({
      id: uuidv7(), documentId: docId, userId: 'tools-responder',
      role: 'responder', grantedBy: 'tools-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_document(
        { documentId: docId },
        { id: 'tools-responder', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBeFalsy();
    });
  });

  it('primer_add_version as responder collab returns forbidden', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-responder');
    const { docId } = await seedDocOwnedBy('tools-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(), documentId: docId, userId: 'tools-responder',
      role: 'responder', grantedBy: 'tools-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_add_version(
        { documentId: docId, content: '<html><body>x</body></html>', format: 'html' },
        { id: 'tools-responder', email: 'x', displayName: 'x' },
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('forbidden');
    });
  });
});

describe('primer_list_documents', () => {
  const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

  it('lists documents newest-first and excludes soft-deleted', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const a = await handlers.primer_create_document({ title: 'Alpha', content: '<p>a</p>', format: 'html' }, owner);
      const b = await handlers.primer_create_document({ title: 'Beta', content: '<p>b</p>', format: 'html' }, owner);
      const { documentId: aId } = JSON.parse(a.content[0].text);
      const { documentId: bId } = JSON.parse(b.content[0].text);

      const res = await handlers.primer_list_documents({}, owner);
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0].text);
      // Newest (Beta) first.
      expect(body.documents.map((d: { id: string }) => d.id)).toEqual([bId, aId]);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();

      // Soft-delete Alpha; it should drop out.
      await db.update(documents).set({ deletedAt: new Date() }).where(sql`id = ${aId}`);
      const res2 = await handlers.primer_list_documents({}, owner);
      const body2 = JSON.parse(res2.content[0].text);
      expect(body2.documents.map((d: { id: string }) => d.id)).toEqual([bId]);
    });
  });

  it('paginates via limit + cursor', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await handlers.primer_create_document({ title: `Doc ${i}`, content: '<p>x</p>', format: 'html' }, owner);
        ids.push(JSON.parse(r.content[0].text).documentId);
      }
      // Newest-first order is reverse of insertion.
      const expectedOrder = [...ids].reverse();

      const page1 = JSON.parse((await handlers.primer_list_documents({ limit: 2 }, owner)).content[0].text);
      expect(page1.documents.map((d: { id: string }) => d.id)).toEqual(expectedOrder.slice(0, 2));
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe(expectedOrder[1]);

      const page2 = JSON.parse(
        (await handlers.primer_list_documents({ limit: 2, cursor: page1.nextCursor }, owner)).content[0].text,
      );
      expect(page2.documents.map((d: { id: string }) => d.id)).toEqual(expectedOrder.slice(2));
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();
    });
  });

  it('returns bad_request on an unknown cursor', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_list_documents(
        { cursor: '00000000-0000-0000-0000-000000000000' },
        owner,
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });

  it("scope 'all' is the caller's accessed library: own uploads + org docs they've opened, not everyone's", async () => {
    await seedUser('tools-owner');
    await seedUser('tools-other');
    const owner2 = { id: 'tools-other', email: 'tools-other@x.test', displayName: 'tools-other' };
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const mine = await handlers.primer_create_document({ title: 'Mine', content: '<p>a</p>', format: 'html' }, owner);
      const theirs = await handlers.primer_create_document(
        { title: 'Theirs', content: '<p>b</p>', format: 'html' },
        owner2,
      );
      const mineId = JSON.parse(mine.content[0].text).documentId;
      const theirsId = JSON.parse(theirs.content[0].text).documentId;

      // Owner has never opened Theirs → 'all' shows only their own upload.
      const before = JSON.parse((await handlers.primer_list_documents({ scope: 'all' }, owner)).content[0].text);
      expect(before.documents.map((d: { id: string }) => d.id)).toEqual([mineId]);

      const scoped = JSON.parse((await handlers.primer_list_documents({ scope: 'mine' }, owner)).content[0].text);
      expect(scoped.scope).toBe('mine');
      expect(scoped.documents.map((d: { id: string }) => d.id)).toEqual([mineId]);

      // Opening Theirs records a view → it enters the owner's accessed library.
      await handlers.primer_get_document({ documentId: theirsId }, owner);
      const all = JSON.parse((await handlers.primer_list_documents({ scope: 'all' }, owner)).content[0].text);
      expect(all.scope).toBe('all');
      expect(all.documents.map((d: { id: string }) => d.id).sort()).toEqual([mineId, theirsId].sort());
    });
  });

  it("defaults to scope 'all' when scope is omitted", async () => {
    await seedUser('tools-owner');
    await seedUser('tools-other');
    const owner2 = { id: 'tools-other', email: 'tools-other@x.test', displayName: 'tools-other' };
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      await handlers.primer_create_document({ title: 'Mine', content: '<p>a</p>', format: 'html' }, owner);
      const theirs = await handlers.primer_create_document({ title: 'Theirs', content: '<p>b</p>', format: 'html' }, owner2);
      const theirsId = JSON.parse(theirs.content[0].text).documentId;

      const body = JSON.parse((await handlers.primer_list_documents({}, owner)).content[0].text);
      expect(body.scope).toBe('all');
      // 'all' is the accessed library, not every doc: owner hasn't opened Theirs.
      expect(body.documents.length).toBe(1);

      // After opening Theirs, it appears.
      await handlers.primer_get_document({ documentId: theirsId }, owner);
      const body2 = JSON.parse((await handlers.primer_list_documents({}, owner)).content[0].text);
      expect(body2.documents.length).toBe(2);
    });
  });
});

describe('primer_find_document', () => {
  const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

  it('matches on title and description, case-insensitively', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      await handlers.primer_create_document(
        { title: 'Quarterly Report', description: 'finance stuff', content: '<p>a</p>', format: 'html' },
        owner,
      );
      await handlers.primer_create_document(
        { title: 'Random Notes', description: 'about QUARTERLY planning', content: '<p>b</p>', format: 'html' },
        owner,
      );
      await handlers.primer_create_document(
        { title: 'Unrelated', content: '<p>c</p>', format: 'html' },
        owner,
      );

      const res = await handlers.primer_find_document({ query: 'quarterly' }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.query).toBe('quarterly');
      const titles = body.documents.map((d: { title: string }) => d.title).sort();
      expect(titles).toEqual(['Quarterly Report', 'Random Notes']);
    });
  });

  it('treats LIKE wildcards as literal characters', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      await handlers.primer_create_document({ title: 'A 100% match', content: '<p>a</p>', format: 'html' }, owner);
      await handlers.primer_create_document({ title: 'nothing here', content: '<p>b</p>', format: 'html' }, owner);

      const res = await handlers.primer_find_document({ query: '100%' }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.documents.map((d: { title: string }) => d.title)).toEqual(['A 100% match']);
    });
  });

  it('returns bad_request when query is missing', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_find_document({}, owner);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });

  it("scope 'mine' restricts search to the caller's own documents", async () => {
    await seedUser('tools-owner');
    await seedUser('tools-other');
    const owner2 = { id: 'tools-other', email: 'tools-other@x.test', displayName: 'tools-other' };
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      await handlers.primer_create_document({ title: 'Roadmap mine', content: '<p>a</p>', format: 'html' }, owner);
      await handlers.primer_create_document({ title: 'Roadmap theirs', content: '<p>b</p>', format: 'html' }, owner2);

      const scoped = JSON.parse(
        (await handlers.primer_find_document({ query: 'roadmap', scope: 'mine' }, owner)).content[0].text,
      );
      expect(scoped.scope).toBe('mine');
      expect(scoped.documents.map((d: { title: string }) => d.title)).toEqual(['Roadmap mine']);

      const all = JSON.parse(
        (await handlers.primer_find_document({ query: 'roadmap', scope: 'all' }, owner)).content[0].text,
      );
      expect(all.documents.map((d: { title: string }) => d.title).sort()).toEqual(['Roadmap mine', 'Roadmap theirs']);
    });
  });
});

describe('primer_get_document_comments', () => {
  const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

  it('returns comments grouped across all versions', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'Doc With Comments', content: '<p>v1</p>', format: 'html' },
        owner,
      );
      const { documentId, versionId: v1Id } = JSON.parse(created.content[0].text);
      const v2 = await handlers.primer_add_version({ documentId, content: '<p>v2</p>', format: 'html' }, owner);
      const { versionId: v2Id } = JSON.parse(v2.content[0].text);

      await seedThreadWithComment(v1Id, 'tools-owner', 'comment on v1');
      await seedThreadWithComment(v2Id, 'tools-owner', 'comment on v2');

      const res = await handlers.primer_get_document_comments({ documentId }, owner);
      expect(res.isError).toBeFalsy();
      const body = JSON.parse(res.content[0].text);
      expect(body.title).toBe('Doc With Comments');
      expect(body.threadCount).toBe(2);
      // Newest version first.
      expect(body.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
      const v2Out = body.versions.find((v: { versionId: string }) => v.versionId === v2Id);
      expect(v2Out.threadCount).toBe(1);
      expect(v2Out.markdown).toContain('comment on v2');
    });
  });

  it('returns empty versions when the document has none with comments', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const created = await handlers.primer_create_document(
        { title: 'No Comments', content: '<p>x</p>', format: 'html' },
        owner,
      );
      const { documentId } = JSON.parse(created.content[0].text);
      const res = await handlers.primer_get_document_comments({ documentId }, owner);
      const body = JSON.parse(res.content[0].text);
      expect(body.threadCount).toBe(0);
      expect(body.versions.length).toBe(1);
      expect(body.versions[0].threadCount).toBe(0);
    });
  });

  it('returns not_found for an unknown document', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_document_comments(
        { documentId: '00000000-0000-0000-0000-000000000000' },
        owner,
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('not_found');
    });
  });

  it('returns bad_request when documentId is missing', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_document_comments({}, owner);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });
});

describe('primer_get_all_comments', () => {
  const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };

  it('lists comments across all documents newest-first and paginates', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const d1 = JSON.parse(
        (await handlers.primer_create_document({ title: 'D1', content: '<p>1</p>', format: 'html' }, owner)).content[0].text,
      );
      const d2 = JSON.parse(
        (await handlers.primer_create_document({ title: 'D2', content: '<p>2</p>', format: 'html' }, owner)).content[0].text,
      );

      const c1 = await seedThreadWithComment(d1.versionId, 'tools-owner', 'first comment');
      const c2 = await seedThreadWithComment(d2.versionId, 'tools-owner', 'second comment');
      const c3 = await seedThreadWithComment(d2.versionId, 'tools-owner', 'third comment');
      // Insertion order c1 < c2 < c3 → newest-first is c3, c2, c1.

      const page1 = JSON.parse((await handlers.primer_get_all_comments({ limit: 2 }, owner)).content[0].text);
      expect(page1.comments.map((c: { id: string }) => c.id)).toEqual([c3.commentId, c2.commentId]);
      expect(page1.comments[0].documentTitle).toBe('D2');
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe(c2.commentId);

      const page2 = JSON.parse(
        (await handlers.primer_get_all_comments({ limit: 2, cursor: page1.nextCursor }, owner)).content[0].text,
      );
      expect(page2.comments.map((c: { id: string }) => c.id)).toEqual([c1.commentId]);
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();
    });
  });

  it('excludes comments from soft-deleted documents', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const d1 = JSON.parse(
        (await handlers.primer_create_document({ title: 'Keep', content: '<p>1</p>', format: 'html' }, owner)).content[0].text,
      );
      const d2 = JSON.parse(
        (await handlers.primer_create_document({ title: 'Drop', content: '<p>2</p>', format: 'html' }, owner)).content[0].text,
      );
      const keep = await seedThreadWithComment(d1.versionId, 'tools-owner', 'keep me');
      await seedThreadWithComment(d2.versionId, 'tools-owner', 'drop me');
      await db.update(documents).set({ deletedAt: new Date() }).where(sql`id = ${d2.documentId}`);

      const body = JSON.parse((await handlers.primer_get_all_comments({}, owner)).content[0].text);
      expect(body.comments.map((c: { id: string }) => c.id)).toEqual([keep.commentId]);
    });
  });

  it('returns bad_request on an unknown cursor', async () => {
    await seedUser('tools-owner');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const res = await handlers.primer_get_all_comments(
        { cursor: '00000000-0000-0000-0000-000000000000' },
        owner,
      );
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('bad_request');
    });
  });

  it("scope 'mine' returns only comments authored by the caller", async () => {
    await seedUser('tools-owner');
    await seedUser('tools-other');
    const owner2 = { id: 'tools-other', email: 'tools-other@x.test', displayName: 'tools-other' };
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      // A single shared doc with comments from two different authors.
      const d = JSON.parse(
        (await handlers.primer_create_document({ title: 'Shared', content: '<p>1</p>', format: 'html' }, owner)).content[0].text,
      );
      const mine = await seedThreadWithComment(d.versionId, 'tools-owner', 'from owner');
      const theirs = await seedThreadWithComment(d.versionId, 'tools-other', 'from other');

      const scoped = JSON.parse((await handlers.primer_get_all_comments({ scope: 'mine' }, owner)).content[0].text);
      expect(scoped.scope).toBe('mine');
      expect(scoped.comments.map((c: { id: string }) => c.id)).toEqual([mine.commentId]);

      const all = JSON.parse((await handlers.primer_get_all_comments({ scope: 'all' }, owner)).content[0].text);
      expect(all.comments.map((c: { id: string }) => c.id).sort()).toEqual(
        [mine.commentId, theirs.commentId].sort(),
      );

      // owner2 scoped to their own comments sees only theirs.
      const scoped2 = JSON.parse((await handlers.primer_get_all_comments({ scope: 'mine' }, owner2)).content[0].text);
      expect(scoped2.comments.map((c: { id: string }) => c.id)).toEqual([theirs.commentId]);
    });
  });
});

describe('post-#37 tools respect visibility (canRead filter)', () => {
  const stranger = { id: 'tools-stranger', email: 'tools-stranger@x.test', displayName: 'tools-stranger' };
  const commenter = { id: 'tools-commenter', email: 'tools-commenter@x.test', displayName: 'tools-commenter' };

  it('primer_list_documents hides a private doc from a stranger; shows it to a commenter collab', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-stranger');
    await seedUser('tools-commenter');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };
      const created = await handlers.primer_create_document({ title: 'Private Only', content: '<p>a</p>', format: 'html' }, owner);
      const { documentId } = JSON.parse(created.content[0].text);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId, userId: 'tools-commenter', role: 'commenter', grantedBy: 'tools-owner',
      });

      const asStranger = JSON.parse((await handlers.primer_list_documents({}, stranger)).content[0].text);
      expect(asStranger.documents.map((d: { id: string }) => d.id)).not.toContain(documentId);

      const asCommenter = JSON.parse((await handlers.primer_list_documents({}, commenter)).content[0].text);
      expect(asCommenter.documents.map((d: { id: string }) => d.id)).toContain(documentId);
    });
  });

  it('primer_find_document hides a private doc from a stranger; shows it to a commenter collab', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-stranger');
    await seedUser('tools-commenter');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };
      const created = await handlers.primer_create_document({ title: 'Secret Roadmap', content: '<p>x</p>', format: 'html' }, owner);
      const { documentId } = JSON.parse(created.content[0].text);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(), documentId, userId: 'tools-commenter', role: 'commenter', grantedBy: 'tools-owner',
      });

      const asStranger = JSON.parse((await handlers.primer_find_document({ query: 'roadmap' }, stranger)).content[0].text);
      expect(asStranger.documents.map((d: { id: string }) => d.id)).not.toContain(documentId);

      const asCommenter = JSON.parse((await handlers.primer_find_document({ query: 'roadmap' }, commenter)).content[0].text);
      expect(asCommenter.documents.map((d: { id: string }) => d.id)).toContain(documentId);
    });
  });

  it('primer_get_document_comments returns not_found for a stranger on a private doc', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-stranger');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };
      const created = await handlers.primer_create_document({ title: 'X', content: '<p>a</p>', format: 'html' }, owner);
      const { documentId } = JSON.parse(created.content[0].text);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));

      const res = await handlers.primer_get_document_comments({ documentId }, stranger);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content[0].text).code).toBe('not_found');
    });
  });

  it('primer_get_all_comments excludes comments on private docs the caller cannot read', async () => {
    await seedUser('tools-owner');
    await seedUser('tools-stranger');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const owner = { id: 'tools-owner', email: 'tools-owner@x.test', displayName: 'tools-owner' };
      // Public + private doc, each with one comment.
      const pub = JSON.parse((await handlers.primer_create_document({ title: 'Public', content: '<p>p</p>', format: 'html' }, owner)).content[0].text);
      const priv = JSON.parse((await handlers.primer_create_document({ title: 'Private', content: '<p>s</p>', format: 'html' }, owner)).content[0].text);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, priv.documentId));
      const pubC = await seedThreadWithComment(pub.versionId, 'tools-owner', 'public comment');
      const privC = await seedThreadWithComment(priv.versionId, 'tools-owner', 'private comment');

      const asStranger = JSON.parse((await handlers.primer_get_all_comments({}, stranger)).content[0].text);
      const strangerIds = asStranger.comments.map((c: { id: string }) => c.id);
      expect(strangerIds).toContain(pubC.commentId);
      expect(strangerIds).not.toContain(privC.commentId);

      // Owner sees both.
      const asOwner = JSON.parse((await handlers.primer_get_all_comments({}, owner)).content[0].text);
      const ownerIds = asOwner.comments.map((c: { id: string }) => c.id);
      expect(ownerIds).toEqual(expect.arrayContaining([pubC.commentId, privC.commentId]));
    });
  });
});

describe('primer_send_events / primer_get_events (issue #78)', () => {
  const asUserArg = (id: string) => ({ id, email: `${id}@x.test`, displayName: id });
  const validEvent = {
    namespace: 'padd',
    type: 'reconciliation',
    payload: { itemId: 'q1', state: 'resolved' },
    audience: 'artifact',
  };

  it('writes an atomic batch and reads it back, audience-aware', async () => {
    await seedUser('tools-ev-owner');
    await seedUser('tools-ev-collab');
    await seedUser('tools-ev-outsider');
    const { docId } = await seedDocOwnedBy('tools-ev-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(),
      documentId: docId,
      userId: 'tools-ev-collab',
      role: 'editor',
      grantedBy: 'tools-ev-owner',
    });
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const sent = await handlers.primer_send_events(
        {
          documentId: docId,
          events: [validEvent, { ...validEvent, type: 'grant', audience: 'author' }],
        },
        asUserArg('tools-ev-owner'),
      );
      expect(sent.isError).toBeFalsy();
      const rows = (JSON.parse(sent.content[0].text) as { events: { id: number; type: string }[] }).events;
      expect(rows).toHaveLength(2);
      expect(rows[1].id).toBeGreaterThan(rows[0].id);

      // Collaborator read: sees the artifact row, not the owner's author row.
      const got = await handlers.primer_get_events(
        { documentId: docId },
        asUserArg('tools-ev-collab'),
      );
      expect(got.isError).toBeFalsy();
      const page = JSON.parse(got.content[0].text) as {
        events: { type: string }[];
        nextPageToken: string | null;
      };
      expect(page.events.map((e) => e.type)).toEqual(['reconciliation']);
      expect(page.nextPageToken).toBeNull();
    });
  });

  it('responders write events; commenters cannot write but still read collaborators-audience rows', async () => {
    await seedUser('tools-ev-owner4');
    await seedUser('tools-ev-responder');
    await seedUser('tools-ev-commenter');
    const { docId } = await seedDocOwnedBy('tools-ev-owner4');
    await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, docId));
    await db.insert(documentCollaborators).values([
      { id: uuidv7(), documentId: docId, userId: 'tools-ev-responder', role: 'responder', grantedBy: 'tools-ev-owner4' },
      { id: uuidv7(), documentId: docId, userId: 'tools-ev-commenter', role: 'commenter', grantedBy: 'tools-ev-owner4' },
    ]);
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const asResponder = await handlers.primer_send_events(
        { documentId: docId, events: [validEvent] },
        asUserArg('tools-ev-responder'),
      );
      expect(asResponder.isError).toBeFalsy();

      const asCommenter = await handlers.primer_send_events(
        { documentId: docId, events: [validEvent] },
        asUserArg('tools-ev-commenter'),
      );
      expect(asCommenter.isError).toBe(true);
      expect((JSON.parse(asCommenter.content[0].text) as { code: string }).code).toBe('forbidden');

      // Pages render from collaborators-audience rows, so the commenter keeps read.
      const ownerRow = await handlers.primer_send_events(
        { documentId: docId, events: [{ ...validEvent, type: 'verdict', audience: 'collaborators' }] },
        asUserArg('tools-ev-owner4'),
      );
      expect(ownerRow.isError).toBeFalsy();
      const got = await handlers.primer_get_events({ documentId: docId }, asUserArg('tools-ev-commenter'));
      expect(got.isError).toBeFalsy();
      const types = (JSON.parse(got.content[0].text) as { events: { type: string }[] }).events.map((e) => e.type);
      expect(types).toContain('verdict');
    });
  });

  it('rejects non-collaborator writers (forbidden) and invalid batches (bad_request, nothing inserted)', async () => {
    await seedUser('tools-ev-owner2');
    await seedUser('tools-ev-outsider2');
    const { docId } = await seedDocOwnedBy('tools-ev-owner2');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      const asOutsider = await handlers.primer_send_events(
        { documentId: docId, events: [validEvent] },
        asUserArg('tools-ev-outsider2'),
      );
      expect(asOutsider.isError).toBe(true);
      expect((JSON.parse(asOutsider.content[0].text) as { code: string }).code).toBe('forbidden');

      const badBatch = await handlers.primer_send_events(
        { documentId: docId, events: [validEvent, { namespace: 'padd', type: 'x', payload: {} }] },
        asUserArg('tools-ev-owner2'),
      );
      expect(badBatch.isError).toBe(true);
      expect((JSON.parse(badBatch.content[0].text) as { code: string }).code).toBe('bad_request');

      const list = await handlers.primer_get_events({ documentId: docId }, asUserArg('tools-ev-owner2'));
      expect((JSON.parse(list.content[0].text) as { events: unknown[] }).events).toHaveLength(0);
    });
  });

  it('supports namespace subtree filter, since, and pagination on reads', async () => {
    await seedUser('tools-ev-owner3');
    const { docId } = await seedDocOwnedBy('tools-ev-owner3');
    await withDeps(async (deps) => {
      const handlers = buildMcpToolHandlers(deps);
      await handlers.primer_send_events(
        {
          documentId: docId,
          events: [
            { ...validEvent, namespace: 'padd', type: 'export' },
            { ...validEvent, namespace: 'padd/telemetry', type: 'ping' },
            { ...validEvent, namespace: 'other', type: 'export' },
          ],
        },
        asUserArg('tools-ev-owner3'),
      );
      const subtree = await handlers.primer_get_events(
        { documentId: docId, namespace: 'padd/*' },
        asUserArg('tools-ev-owner3'),
      );
      const rows = (JSON.parse(subtree.content[0].text) as { events: { namespace: string; id: number }[] }).events;
      expect(rows.map((r) => r.namespace)).toEqual(['padd', 'padd/telemetry']);

      const since = await handlers.primer_get_events(
        { documentId: docId, since: rows[0].id },
        asUserArg('tools-ev-owner3'),
      );
      const sinceRows = (JSON.parse(since.content[0].text) as { events: { id: number }[] }).events;
      expect(sinceRows.every((r) => r.id > rows[0].id)).toBe(true);

      const paged = await handlers.primer_get_events(
        { documentId: docId, limit: 2 },
        asUserArg('tools-ev-owner3'),
      );
      const pagedBody = JSON.parse(paged.content[0].text) as { events: unknown[]; nextPageToken: string | null };
      expect(pagedBody.events).toHaveLength(2);
      expect(pagedBody.nextPageToken).not.toBeNull();
      const rest = await handlers.primer_get_events(
        { documentId: docId, pageToken: pagedBody.nextPageToken },
        asUserArg('tools-ev-owner3'),
      );
      expect((JSON.parse(rest.content[0].text) as { nextPageToken: string | null }).nextPageToken).toBeNull();
    });
  });
});
