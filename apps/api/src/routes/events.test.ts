// Tests for the structured document-events channel (issue #78):
// batch write semantics (atomicity, order, strictly increasing ids),
// per-audience read scoping, filters (exact + trailing-/* subtree),
// token pagination, since/Last-Event-ID, versionId provenance, and the
// SSE stream (per-row id:, resume, keepalive comments, live scoping).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documents, documentCollaborators, events, users, versions } from '../db/schema.ts';
import type { Notifier } from '../notifications/notifier.ts';
import type {
  CollaboratorRole,
  EventRowDTO,
  EventsListResponse,
  SendEventsResponse,
} from '@polygonlabs/primer-api-types';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

class NullNotifier implements Notifier {
  readonly emailEnabled = false;
  async notifyComment(): Promise<void> {}
  async notifyCollaboratorAdded(): Promise<void> {}
  async notifyExternalOtp(): Promise<void> {}
  async notifyExternalFirstView(): Promise<void> {}
}

const OWNER = 'mock-user-1'; // uploadFixture uploads as the default mock user
const COLLAB = 'mock-user-2';
const OUTSIDER = 'mock-user-3';

async function withApp<T>(
  fn: (app: ReturnType<typeof createApp>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-events-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NullNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: OWNER, email: 'one@p.t', displayName: 'User One' },
        { id: COLLAB, email: 'two@p.t', displayName: 'User Two' },
        { id: OUTSIDER, email: 'three@p.t', displayName: 'User Three' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addCollaborator(docId: string, userId: string, role: CollaboratorRole = 'editor') {
  await db.insert(documentCollaborators).values({
    id: uuidv7(),
    documentId: docId,
    userId,
    role,
    grantedBy: OWNER,
  });
}

interface PostedBatch {
  status: number;
  body: SendEventsResponse;
}

async function postEvents(
  app: ReturnType<typeof createApp>,
  docId: string,
  userId: string,
  events: unknown[],
): Promise<PostedBatch> {
  const res = await app.request(`/api/documents/${docId}/events`, {
    method: 'POST',
    headers: asUserJson(userId),
    body: JSON.stringify({ events }),
  });
  return { status: res.status, body: (await res.json()) as SendEventsResponse };
}

async function listAll(
  app: ReturnType<typeof createApp>,
  docId: string,
  userId: string,
  query = '',
): Promise<EventsListResponse> {
  const res = await app.request(`/api/documents/${docId}/events${query}`, {
    headers: asUser(userId),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as EventsListResponse;
}

/** Uploads a document and drops the `primer.version.published` row its
 *  creation wrote, so these tests see only the client-written channel
 *  (lifecycle rows are covered in events.lifecycle.test.ts). */
async function uploadDoc(app: ReturnType<typeof createApp>) {
  const upload = await uploadFixture(app);
  await db.delete(events).where(eq(events.documentId, upload.documentId));
  return upload;
}

const ev = (over: Record<string, unknown> = {}) => ({
  namespace: 'padd',
  type: 'export',
  payload: { hello: 'world' },
  audience: 'artifact',
  ...over,
});

describe('POST /api/documents/:id/events — batch write', () => {
  it('201: inserts in array order with strictly increasing integer ids, echoing audience', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await uploadDoc(app);
      const { status, body } = await postEvents(app, documentId, OWNER, [
        ev({ type: 'export', payload: { n: 1 }, versionId }),
        ev({ type: 'verdict', payload: { n: 2 }, audience: 'collaborators' }),
        ev({ namespace: 'padd/telemetry', type: 'grant', payload: null, audience: 'author' }),
      ]);
      expect(status).toBe(201);
      expect(body.events).toHaveLength(3);
      const [a, b, c] = body.events;
      expect(a.type).toBe('export');
      expect(b.type).toBe('verdict');
      expect(c.type).toBe('grant');
      expect(Number.isInteger(a.id) && a.id > 0).toBe(true);
      expect(b.id).toBeGreaterThan(a.id);
      expect(c.id).toBeGreaterThan(b.id);
      expect(a.audience).toBe('artifact');
      expect(b.audience).toBe('collaborators');
      expect(c.audience).toBe('author');
      expect(a.versionId).toBe(versionId);
      expect(b.versionId).toBeUndefined();
      expect(a.authorId).toBe(OWNER);
      expect(c.payload).toBeNull();
      expect(c.namespace).toBe('padd/telemetry');
    });
  });

  it('atomic visibility: all rows of a batch appear together in a list read', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await postEvents(app, documentId, OWNER, [ev(), ev(), ev()]);
      const list = await listAll(app, documentId, OWNER);
      expect(list.events).toHaveLength(3);
      const ids = list.events.map((r) => r.id);
      expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    });
  });

  it('all-or-nothing: one invalid event rejects the whole batch, nothing inserted', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const res = await app.request(`/api/documents/${documentId}/events`, {
        method: 'POST',
        headers: asUserJson(OWNER),
        body: JSON.stringify({
          events: [ev(), { namespace: 'padd', type: 'export', payload: {} }, ev()],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('bad_request');
      const list = await listAll(app, documentId, OWNER);
      expect(list.events).toHaveLength(0);
    });
  });

  it('rejects a missing/invalid audience, namespace, or type (audience has no default)', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      for (const bad of [
        ev({ audience: undefined }),
        ev({ audience: 'everyone' }),
        ev({ namespace: 'Padd' }),
        ev({ namespace: 'padd/' }),
        ev({ namespace: '/padd' }),
        ev({ type: 'padd/export' }), // type is a single name, no slashes
        ev({ type: 'UPPER' }),
        ev({ type: 'comment.created' }), // dotted types are Primer's own
        ev({ namespace: 'primer' }), // reserved for Primer's lifecycle events
        ev({ namespace: 'primer/comment' }),
        ev({ audience: 'readers' }), // server-only audience
        { type: 'export', payload: {}, audience: 'artifact' }, // no namespace
      ]) {
        const { status } = await postEvents(app, documentId, OWNER, [bad]);
        expect(status).toBe(400);
      }
      expect((await listAll(app, documentId, OWNER)).events).toHaveLength(0);
    });
  });

  it('accepts namespace `padd` with types export, verdict, reconciliation, grant', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const { status, body } = await postEvents(app, documentId, OWNER, [
        ev({ type: 'export' }),
        ev({ type: 'verdict' }),
        ev({ type: 'reconciliation' }),
        ev({ type: 'grant' }),
      ]);
      expect(status).toBe(201);
      expect(body.events.map((r) => r.type)).toEqual(['export', 'verdict', 'reconciliation', 'grant']);
    });
  });

  it('enforces the 256 KB serialized payload cap per event', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const big = 'x'.repeat(256 * 1024);
      const { status } = await postEvents(app, documentId, OWNER, [ev({ payload: { big } })]);
      expect(status).toBe(400);
      // Just under the cap passes.
      const okPayload = 'x'.repeat(200 * 1024);
      const { status: okStatus } = await postEvents(app, documentId, OWNER, [
        ev({ payload: { okPayload } }),
      ]);
      expect(okStatus).toBe(201);
    });
  });

  it('rejects an empty batch, a non-array body, and a batch above the cap', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      expect((await postEvents(app, documentId, OWNER, [])).status).toBe(400);
      const res = await app.request(`/api/documents/${documentId}/events`, {
        method: 'POST',
        headers: asUserJson(OWNER),
        body: JSON.stringify({ events: 'nope' }),
      });
      expect(res.status).toBe(400);
      const over = Array.from({ length: 101 }, () => ev());
      expect((await postEvents(app, documentId, OWNER, over)).status).toBe(400);
    });
  });

  it('versionId not belonging to the document → bad_request, nothing inserted', async () => {
    await withApp(async (app) => {
      const first = await uploadDoc(app);
      const second = await uploadDoc(app);
      const { status } = await postEvents(app, first.documentId, OWNER, [
        ev(),
        ev({ versionId: second.versionId }),
      ]);
      expect(status).toBe(400);
      expect((await listAll(app, first.documentId, OWNER)).events).toHaveLength(0);
    });
  });

  it('collaborators may write; non-collaborator org readers get 403; strangers on private docs 404', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      // Org reader who is NOT a collaborator: can see the doc → explicit 403.
      expect((await postEvents(app, documentId, OUTSIDER, [ev()])).status).toBe(403);
      await addCollaborator(documentId, COLLAB, 'editor');
      const asCollab = await postEvents(app, documentId, COLLAB, [ev()]);
      expect(asCollab.status).toBe(201);
      expect(asCollab.body.events[0].authorId).toBe(COLLAB);
      // Private doc: stranger can't even see it → 404.
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
      expect((await postEvents(app, documentId, OUTSIDER, [ev()])).status).toBe(404);
      // Collaborator still writes on the private doc.
      expect((await postEvents(app, documentId, COLLAB, [ev()])).status).toBe(201);
    });
  });

  it('responders write on both visibilities; commenters get 403 even as an org ghost row', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await addCollaborator(documentId, COLLAB, 'responder');
      await addCollaborator(documentId, OUTSIDER, 'commenter');
      // Org doc: the responder writes; the commenter row is a ghost (commenter
      // is refused under org via the API) and still cannot write.
      const orgResponder = await postEvents(app, documentId, COLLAB, [ev()]);
      expect(orgResponder.status).toBe(201);
      expect(orgResponder.body.events[0].authorId).toBe(COLLAB);
      expect((await postEvents(app, documentId, OUTSIDER, [ev()])).status).toBe(403);
      // Private doc: same split.
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
      const privateResponder = await postEvents(app, documentId, COLLAB, [ev()]);
      expect(privateResponder.status).toBe(201);
      expect(privateResponder.body.events[0].authorId).toBe(COLLAB);
      expect((await postEvents(app, documentId, OUTSIDER, [ev()])).status).toBe(403);
    });
  });

  it('unauthenticated principals (incl. external-share viewers) are rejected with 401', async () => {
    // External viewers are NOT users: their primer_ext_sid session plane
    // stops at /api/share/* and never resolves on /api/documents routes.
    const root = await mkdtemp(join(tmpdir(), 'primer-events-unauth-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NullNotifier(),
        userResolver: async () => null, // no internal principal
      });
      const someDoc = uuidv7();
      const headerVariants: Record<string, string>[] = [
        { 'content-type': 'application/json', 'x-primer-csrf': '1' },
        { 'content-type': 'application/json', 'x-primer-csrf': '1', cookie: 'primer_ext_sid=ext-session' },
      ];
      for (const headers of headerVariants) {
        const post = await app.request(`/api/documents/${someDoc}/events`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ events: [ev()] }),
        });
        expect(post.status).toBe(401);
        const get = await app.request(`/api/documents/${someDoc}/events`, { headers });
        expect(get.status).toBe(401);
        const stream = await app.request(`/api/documents/${someDoc}/events/stream`, { headers });
        expect(stream.status).toBe(401);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('404 for a missing or deleted document', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      expect((await postEvents(app, uuidv7(), OWNER, [ev()])).status).toBe(404);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));
      expect((await postEvents(app, documentId, OWNER, [ev()])).status).toBe(404);
    });
  });
});

describe('GET /api/documents/:id/events — audience scoping', () => {
  it('scopes rows per tier: author / collaborators / artifact', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await addCollaborator(documentId, COLLAB, 'editor');
      // Owner writes one row per tier; the collaborator writes an author row.
      await postEvents(app, documentId, OWNER, [
        ev({ type: 'export', audience: 'artifact' }),
        ev({ type: 'verdict', audience: 'collaborators' }),
        ev({ type: 'grant', audience: 'author' }), // owner-private
      ]);
      await postEvents(app, documentId, COLLAB, [
        ev({ type: 'reconciliation', audience: 'author' }), // collab-private
      ]);

      // Owner sees everything (owner is in every tier's reader set).
      const ownerList = await listAll(app, documentId, OWNER);
      expect(ownerList.events.map((r) => r.type).sort()).toEqual(
        ['export', 'grant', 'reconciliation', 'verdict'],
      );

      // Collaborator sees collaborators + artifact + their OWN author rows,
      // but never another author's `author` rows.
      const collabList = await listAll(app, documentId, COLLAB);
      expect(collabList.events.map((r) => r.type).sort()).toEqual(
        ['export', 'reconciliation', 'verdict'],
      );

      // Non-collaborator org reader: may look, but reads no tier — exactly
      // the rows their identity may read is the empty set here.
      const outsiderList = await listAll(app, documentId, OUTSIDER);
      expect(outsiderList.events).toHaveLength(0);
    });
  });

  it('commenter and responder both read collaborators- and artifact-audience rows, never another user\'s author rows', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
      // Pages render from this data, so a commenter must keep reading it even
      // though it can no longer write events.
      await addCollaborator(documentId, COLLAB, 'commenter');
      await addCollaborator(documentId, OUTSIDER, 'responder');
      await postEvents(app, documentId, OWNER, [
        ev({ type: 'export', audience: 'artifact' }),
        ev({ type: 'verdict', audience: 'collaborators' }),
        ev({ type: 'grant', audience: 'author' }), // owner-private
      ]);
      for (const reader of [COLLAB, OUTSIDER]) {
        const list = await listAll(app, documentId, reader);
        expect(list.events.map((r) => r.type).sort()).toEqual(['export', 'verdict']);
      }
    });
  });

  it('strangers on private docs get 404 at every read surface', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
      const list = await app.request(`/api/documents/${documentId}/events`, {
        headers: asUser(OUTSIDER),
      });
      expect(list.status).toBe(404);
      const stream = await app.request(`/api/documents/${documentId}/events/stream`, {
        headers: asUser(OUTSIDER),
      });
      expect(stream.status).toBe(404);
    });
  });
});

describe('GET /api/documents/:id/events — filters, since, pagination, versionId', () => {
  it('delivers ascending id; ?since returns only rows with greater ids', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const first = await postEvents(app, documentId, OWNER, [ev(), ev(), ev()]);
      const cutoff = first.body.events[1].id;
      const list = await listAll(app, documentId, OWNER, `?since=${cutoff}`);
      expect(list.events.map((r) => r.id)).toEqual([first.body.events[2].id]);
    });
  });

  it('malformed since → bad_request', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      for (const bad of ['abc', '-1', '1.5', '1e3']) {
        const res = await app.request(
          `/api/documents/${documentId}/events?since=${encodeURIComponent(bad)}`,
          { headers: asUser(OWNER) },
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('bad_request');
      }
    });
  });

  it('?namespace exact match and trailing-/* subtree; ?type exact', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await postEvents(app, documentId, OWNER, [
        ev({ namespace: 'padd', type: 'export' }),
        ev({ namespace: 'padd/telemetry', type: 'ping' }),
        ev({ namespace: 'padd/telemetry/deep', type: 'ping' }),
        ev({ namespace: 'paddington', type: 'export' }), // must NOT match padd/*
        ev({ namespace: 'other', type: 'export' }),
      ]);
      const exact = await listAll(app, documentId, OWNER, '?namespace=padd');
      expect(exact.events.map((r) => r.namespace)).toEqual(['padd']);
      const subtree = await listAll(app, documentId, OWNER, `?namespace=${encodeURIComponent('padd/*')}`);
      expect(subtree.events.map((r) => r.namespace)).toEqual([
        'padd',
        'padd/telemetry',
        'padd/telemetry/deep',
      ]);
      const nested = await listAll(
        app, documentId, OWNER, `?namespace=${encodeURIComponent('padd/telemetry/*')}`,
      );
      expect(nested.events.map((r) => r.namespace)).toEqual(['padd/telemetry', 'padd/telemetry/deep']);
      const byType = await listAll(app, documentId, OWNER, '?type=ping');
      expect(byType.events.map((r) => r.namespace)).toEqual(['padd/telemetry', 'padd/telemetry/deep']);
      const combined = await listAll(
        app, documentId, OWNER, `?namespace=${encodeURIComponent('padd/*')}&type=export`,
      );
      expect(combined.events.map((r) => r.namespace)).toEqual(['padd']);
    });
  });

  it('rejects malformed filter values', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      for (const q of ['?namespace=Padd', '?namespace=%2F*', '?namespace=padd%2F**', '?type=a%2Fb']) {
        const res = await app.request(`/api/documents/${documentId}/events${q}`, {
          headers: asUser(OWNER),
        });
        expect(res.status).toBe(400);
      }
    });
  });

  it('token pagination: bounded pages of ascending ids, followed to exhaustion', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const posted = await postEvents(
        app, documentId, OWNER,
        Array.from({ length: 7 }, (_, i) => ev({ payload: { i } })),
      );
      const allIds = posted.body.events.map((r) => r.id);

      const seen: number[] = [];
      let token: string | null = null;
      let pages = 0;
      do {
        const q = token ? `?limit=3&pageToken=${encodeURIComponent(token)}` : '?limit=3';
        const page: EventsListResponse = await listAll(app, documentId, OWNER, q);
        expect(page.events.length).toBeLessThanOrEqual(3);
        seen.push(...page.events.map((r) => r.id));
        token = page.nextPageToken;
        pages += 1;
      } while (token !== null);
      expect(pages).toBe(3);
      expect(seen).toEqual(allIds);
    });
  });

  it('malformed pageToken → bad_request', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const res = await app.request(`/api/documents/${documentId}/events?pageToken=%3F%3F%3F`, {
        headers: asUser(OWNER),
      });
      expect(res.status).toBe(400);
    });
  });

  it('?versionId is a provenance lens: only rows that DECLARED that version', async () => {
    await withApp(async (app) => {
      const upload = await uploadDoc(app);
      const v2 = uuidv7();
      await db.insert(versions).values({
        id: v2,
        documentId: upload.documentId,
        versionNumber: 2,
        storageKey: 'unused',
        sizeBytes: 1,
      });
      await postEvents(app, upload.documentId, OWNER, [
        ev({ payload: { at: 'v1' }, versionId: upload.versionId }),
        ev({ payload: { at: 'v2' }, versionId: v2 }),
        ev({ payload: { at: 'none' } }),
      ]);
      const all = await listAll(app, upload.documentId, OWNER);
      expect(all.events).toHaveLength(3);
      const v2Only = await listAll(app, upload.documentId, OWNER, `?versionId=${v2}`);
      expect(v2Only.events.map((r) => (r.payload as { at: string }).at)).toEqual(['v2']);
    });
  });

  it("?versionId that isn't a version of this document → bad_request", async () => {
    await withApp(async (app) => {
      const first = await uploadDoc(app);
      const second = await uploadDoc(app);
      const res = await app.request(
        `/api/documents/${first.documentId}/events?versionId=${second.versionId}`,
        { headers: asUser(OWNER) },
      );
      expect(res.status).toBe(400);
    });
  });
});

// ── SSE stream ─────────────────────────────────────────────────────────

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Incremental SSE frame parser over a fetch body reader. */
function makeSseReader(res: Response) {
  const bodyStream = res.body;
  if (!bodyStream) throw new Error('SSE response has no body');
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];

  function drainBuffer(): void {
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) return;
      const rawFrame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame: SseFrame = {};
      for (const line of rawFrame.split('\n')) {
        if (line.startsWith(':')) frame.comment = (frame.comment ?? '') + line.slice(1).trim();
        else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
        else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          frame.data = (frame.data === undefined ? '' : `${frame.data}\n`) + line.slice(5).trim();
        }
      }
      frames.push(frame);
    }
  }

  return {
    /** Waits until `predicate` matches an accumulated frame (or times out). */
    async waitFor(predicate: (f: SseFrame) => boolean, timeoutMs = 5000): Promise<SseFrame> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`SSE waitFor timed out; frames so far: ${JSON.stringify(frames)}`);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream ended before predicate matched');
        buffer += decoder.decode(value, { stream: true });
        drainBuffer();
      }
    },
    frames,
    /** Reads until the server ends the stream; false if it is still open at the deadline. */
    async waitForEnd(timeoutMs = 3000): Promise<boolean> {
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs));
      for (;;) {
        const next = await Promise.race([reader.read(), timeout]);
        if (next === 'timeout') return false;
        if (next.done) return true;
        buffer += decoder.decode(next.value, { stream: true });
        drainBuffer();
      }
    },
    async close(): Promise<void> {
      await reader.cancel();
    },
  };
}

describe('GET /api/documents/:id/events/stream — access is re-checked while the stream is open', () => {
  // The stream checks access once at connect; without a re-check a reader
  // whose access was taken away kept receiving rows for as long as the
  // connection lived (keepalives hold it open indefinitely).
  it('a collaborator removed from a private doc stops receiving rows and their stream closes; others keep receiving', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
      await addCollaborator(documentId, COLLAB, 'commenter');
      await addCollaborator(documentId, OUTSIDER, 'commenter');

      const removedRes = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(OUTSIDER) });
      const keptRes = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(COLLAB) });
      expect(removedRes.status).toBe(200);
      expect(keptRes.status).toBe(200);
      const removed = makeSseReader(removedRes);
      const kept = makeSseReader(keptRes);

      const del = await app.request(`/api/documents/${documentId}/collaborators/${OUTSIDER}`, {
        method: 'DELETE',
        headers: asUser(OWNER),
      });
      expect(del.status).toBe(204);
      const list = await app.request(`/api/documents/${documentId}/events`, { headers: asUser(OUTSIDER) });
      expect(list.status).toBe(404);

      const posted = await postEvents(app, documentId, OWNER, [ev({ type: 'after-removal', audience: 'collaborators' })]);
      expect(posted.status).toBe(201);
      const rowId = String(posted.body.events[0].id);

      // The unchanged collaborator still gets the live row.
      await kept.waitFor((f) => f.id === rowId);
      await kept.close();

      // The removed one never sees it, and the server ends their stream.
      expect(await removed.waitForEnd()).toBe(true);
      expect(removed.frames.map((f) => f.id)).not.toContain(rowId);
    });
  });

  it('closes an open stream once the document is deleted', async () => {
    const prev = process.env.EVENTS_SSE_KEEPALIVE_MS;
    process.env.EVENTS_SSE_KEEPALIVE_MS = '50';
    try {
      await withApp(async (app) => {
        const { documentId } = await uploadDoc(app);
        await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
        await addCollaborator(documentId, COLLAB, 'commenter');
        const res = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(COLLAB) });
        expect(res.status).toBe(200);
        const sse = makeSseReader(res);

        const del = await app.request(`/api/documents/${documentId}`, { method: 'DELETE', headers: asUser(OWNER) });
        expect(del.status).toBeLessThan(300);

        // No row can be written to a deleted document, so the stream must
        // notice on its own (it re-checks on its keepalive tick).
        expect(await sse.waitForEnd()).toBe(true);
      });
    } finally {
      if (prev === undefined) delete process.env.EVENTS_SSE_KEEPALIVE_MS;
      else process.env.EVENTS_SSE_KEEPALIVE_MS = prev;
    }
  });

  it('a collaborator removed from an org doc keeps the stream but stops receiving collaborators-audience rows', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await addCollaborator(documentId, COLLAB, 'responder');
      await addCollaborator(documentId, OUTSIDER, 'responder');
      const removedRes = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(OUTSIDER) });
      const keptRes = await app.request(`/api/documents/${documentId}/events/stream`, { headers: asUser(COLLAB) });
      const removed = makeSseReader(removedRes);
      const kept = makeSseReader(keptRes);

      const del = await app.request(`/api/documents/${documentId}/collaborators/${OUTSIDER}`, {
        method: 'DELETE',
        headers: asUser(OWNER),
      });
      expect(del.status).toBe(204);

      const posted = await postEvents(app, documentId, OWNER, [ev({ type: 'org-after-removal', audience: 'collaborators' })]);
      const rowId = String(posted.body.events[0].id);
      await kept.waitFor((f) => f.id === rowId);
      await kept.close();

      // Still an org reader, so the stream stays open, but the row is not theirs to read.
      expect(await removed.waitForEnd(1000)).toBe(false);
      expect(removed.frames.map((f) => f.id)).not.toContain(rowId);
      await removed.close();
    });
  });
});

describe('GET /api/documents/:id/events/stream — SSE', () => {
  it('delivers live rows with SSE id: equal to the row id', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const res = await app.request(`/api/documents/${documentId}/events/stream`, {
        headers: asUser(OWNER),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
      const sse = makeSseReader(res);
      const posted = await postEvents(app, documentId, OWNER, [ev({ payload: { live: true } })]);
      const rowId = posted.body.events[0].id;
      const frame = await sse.waitFor((f) => f.id === String(rowId));
      const row = JSON.parse(frame.data ?? '{}') as EventRowDTO;
      expect(row.id).toBe(rowId);
      expect(row.payload).toEqual({ live: true });
      await sse.close();
    });
  });

  it('replays backlog on since / Last-Event-ID resume, then continues live', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const before = await postEvents(app, documentId, OWNER, [
        ev({ payload: { n: 1 } }),
        ev({ payload: { n: 2 } }),
        ev({ payload: { n: 3 } }),
      ]);
      const ids = before.body.events.map((r) => r.id);

      // Resume from the first id via Last-Event-ID (as EventSource would).
      const res = await app.request(`/api/documents/${documentId}/events/stream`, {
        headers: { ...asUser(OWNER), 'Last-Event-ID': String(ids[0]) },
      });
      const sse = makeSseReader(res);
      await sse.waitFor((f) => f.id === String(ids[2]));
      const dataFrames = sse.frames.filter((f) => f.data !== undefined);
      expect(dataFrames.map((f) => f.id)).toEqual([String(ids[1]), String(ids[2])]);

      // …and live rows keep flowing after the backlog.
      const later = await postEvents(app, documentId, OWNER, [ev({ payload: { n: 4 } })]);
      await sse.waitFor((f) => f.id === String(later.body.events[0].id));
      await sse.close();
    });
  });

  it('applies namespace subtree + type filters on the stream (parity with the list)', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const res = await app.request(
        `/api/documents/${documentId}/events/stream?namespace=${encodeURIComponent('padd/*')}&type=ping`,
        { headers: asUser(OWNER) },
      );
      const sse = makeSseReader(res);
      const posted = await postEvents(app, documentId, OWNER, [
        ev({ namespace: 'other', type: 'ping' }),          // filtered out
        ev({ namespace: 'padd', type: 'export' }),          // filtered out (type)
        ev({ namespace: 'padd/telemetry', type: 'ping' }),  // delivered
      ]);
      const wantedId = posted.body.events[2].id;
      await sse.waitFor((f) => f.id === String(wantedId));
      const dataFrames = sse.frames.filter((f) => f.data !== undefined);
      expect(dataFrames).toHaveLength(1);
      await sse.close();
    });
  });

  it('scopes live rows by audience (an author row of another user is not delivered)', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await addCollaborator(documentId, COLLAB, 'editor');
      const res = await app.request(`/api/documents/${documentId}/events/stream`, {
        headers: asUser(COLLAB),
      });
      const sse = makeSseReader(res);
      const posted = await postEvents(app, documentId, OWNER, [
        ev({ type: 'grant', audience: 'author' }),      // owner-private: NOT for the collab
        ev({ type: 'export', audience: 'artifact' }),   // delivered
      ]);
      await sse.waitFor((f) => f.id === String(posted.body.events[1].id));
      const dataFrames = sse.frames.filter((f) => f.data !== undefined);
      expect(dataFrames).toHaveLength(1);
      expect((JSON.parse(dataFrames[0].data ?? '{}') as EventRowDTO).type).toBe('export');
      await sse.close();
    });
  });

  it('delivers a collaborators-audience row to a commenter\'s stream (commenters keep read)', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, documentId));
      await addCollaborator(documentId, COLLAB, 'commenter');
      await addCollaborator(documentId, OUTSIDER, 'responder');
      const res = await app.request(`/api/documents/${documentId}/events/stream`, {
        headers: asUser(COLLAB),
      });
      expect(res.status).toBe(200);
      const sse = makeSseReader(res);
      // A responder writes the row, so the stream also covers a non-owner writer.
      const posted = await postEvents(app, documentId, OUTSIDER, [ev({ type: 'verdict', audience: 'collaborators' })]);
      const frame = await sse.waitFor((f) => f.id === String(posted.body.events[0].id));
      expect((JSON.parse(frame.data ?? '{}') as EventRowDTO).type).toBe('verdict');
      await sse.close();
    });
  });

  it('emits periodic keepalive comments', async () => {
    const prev = process.env.EVENTS_SSE_KEEPALIVE_MS;
    process.env.EVENTS_SSE_KEEPALIVE_MS = '50';
    try {
      await withApp(async (app) => {
        const { documentId } = await uploadDoc(app);
        const res = await app.request(`/api/documents/${documentId}/events/stream`, {
          headers: asUser(OWNER),
        });
        const sse = makeSseReader(res);
        const frame = await sse.waitFor((f) => f.comment !== undefined);
        expect(frame.comment).toBe('keepalive');
        await sse.close();
      });
    } finally {
      if (prev === undefined) delete process.env.EVENTS_SSE_KEEPALIVE_MS;
      else process.env.EVENTS_SSE_KEEPALIVE_MS = prev;
    }
  });

  it('malformed since on the stream → bad_request', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      const res = await app.request(`/api/documents/${documentId}/events/stream?since=nope`, {
        headers: asUser(OWNER),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('publish flow primitives (issue #78 identity requirements)', () => {
  it('GET /api/users/lookup resolves an email (case-insensitively) to users.id', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/users/lookup?email=TWO@p.t', {
        headers: asUser(OWNER),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: COLLAB });

      const miss = await app.request('/api/users/lookup?email=nobody@p.t', {
        headers: asUser(OWNER),
      });
      expect(miss.status).toBe(404);

      const bad = await app.request('/api/users/lookup', { headers: asUser(OWNER) });
      expect(bad.status).toBe(400);
    });
  });

  it('publish flow: owner uploads, resolves a reviewer by email, adds them as collaborator; the reviewer can then write events', async () => {
    await withApp(async (app) => {
      // 1. Publish (upload) as the owning principal (e.g. a service account).
      const { documentId } = await uploadDoc(app);
      // 2. Resolve the commissioning human by email.
      const lookup = await app.request('/api/users/lookup?email=two@p.t', {
        headers: asUser(OWNER),
      });
      const { id: reviewerId } = (await lookup.json()) as { id: string };
      // 3. Add them as a collaborator (editor is the strongest grantable
      //    role — Primer has no managing collaborator role in v1).
      const add = await app.request(`/api/documents/${documentId}/collaborators`, {
        method: 'POST',
        headers: asUserJson(OWNER),
        body: JSON.stringify({ userId: reviewerId, role: 'editor' }),
      });
      expect(add.status).toBe(201);
      // 4. The invited reviewer is now inside the write principal.
      const write = await postEvents(app, documentId, reviewerId, [
        ev({ type: 'verdict', audience: 'artifact' }),
      ]);
      expect(write.status).toBe(201);
      expect(write.body.events[0].authorId).toBe(reviewerId);
    });
  });
});
