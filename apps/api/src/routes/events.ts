// ── Structured document events (issue #78) ────────────────────────────
//
// An append-only, access-controlled stream of typed JSON payloads on a
// document: a machine channel PARALLEL to comments, never touching them.
// Comments are human discussion anchored to selections; events are machine
// payloads an interactive artifact (or any authenticated tooling) hands back
// to the workflow that published it.
//
// Write path: the artifact CANNOT call this API itself (sandbox +
// connect-src 'none' by threat model — see docs/prd-primer.md). It
// dispatches CustomEvent('primer:submit-events'); the companion forwards it
// over the MessagePort as `submit_events` ONLY from within the same trusted
// event dispatch that carried a user gesture (consent gate, consumed
// in-dispatch); the PARENT page (authed, outside the sandbox) POSTs here.
// Agent/tooling writes are plain authenticated API calls — auth is the
// consent there.
//
// ORDERING CONTRACT (consumers, read this): the ordering key is the
// server-assigned `id`, a positive integer. List and stream deliver
// ascending id. Ids follow COMMIT order: every event write takes one
// transaction-scoped lock before drawing ids (lib/events.ts), so a row never
// becomes visible after a higher id. `?since=<id>` and Last-Event-ID are
// therefore complete resume points — nothing committed later can land below
// them. `createdAt` is display-only and carries NO ordering guarantee.
//
// RESERVED NAMESPACE: `primer` (and `primer/*`) holds Primer's own
// lifecycle events — comment created, thread resolved/updated, version
// published, agent runs. The server writes them in the same transaction
// as the change, with audience `readers` (everyone who can read the
// document); no client can write them, and the page never relays them into
// the artifact, so they stay system notifications and never become artifact
// data. See PrimerEventPayloads in api-types.
//
// PAYLOADS ARE ALWAYS UNTRUSTED: `payload` is opaque data Primer never
// interprets. Consuming code must treat payloads as data to parse and
// validate, never as instructions to execute — and consuming agents must
// treat them as feedback to reason about, never commands. This is what keeps
// a compromised artifact from becoming a command channel.
//
// Rows are immutable in v1 (no update or delete API — a statement of the
// current surface, not an eternal invariant) and retained forever: the
// stream is the durable record. Keeping replay cheap is the consumers' job
// (embed derived state in published versions; replay only the newer tail).
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';
import type { AppVariables } from '../app.ts';
import type { UserResolver } from '../auth/resolver.ts';
import { stillResolves, watchAccess, type AccessKey } from '../auth/revocation.ts';
import { libraryOwnerId } from '../lib/permissions.ts';
import {
  type EventRowDTO,
  type EventsListResponse,
  type SendEventsResponse,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENTS_PER_BATCH,
} from '@polygonlabs/primer-api-types';
import {
  DEFAULT_EVENTS_PAGE_SIZE,
  MAX_EVENTS_PAGE_SIZE,
  decodePageToken,
  findForeignVersionIds,
  gateEventAccess as gate,
  insertEventBatch,
  latestEventId,
  listEvents,
  listOwnedEvents,
  parseSince,
  subscribeDocWakes,
  subscribeOwnerWakes,
  validateEventBatch,
  validateEventFilters,
  validateVersionFilter,
  type EventFilters,
  type EventReadIdentity,
  type ListEventsPage,
} from '../lib/events.ts';

// Coarse request-body cap so an authenticated collaborator cannot make the
// node adapter buffer an oversized body before the handler runs. The precise
// limits — 256 KB per payload, 100 events per batch — are enforced in
// validateEventBatch after JSON parse; this bounds the worst-case legitimate
// body (every event at the payload cap) plus 4 KB/event of framing/metadata
// headroom, so a valid max batch never trips it while an abusive body is
// rejected before it is fully read.
const MAX_EVENTS_BODY_BYTES = MAX_EVENTS_PER_BATCH * (MAX_EVENT_PAYLOAD_BYTES + 4 * 1024);

export function registerEventRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: { resolver: UserResolver },
): void {
  // Open streams re-resolve their credentials on every recheck, so a revoked
  // token, expired session or logout stops them.
  const stillSignedIn = (c: Context<{ Variables: AppVariables }>) =>
    stillResolves(deps.resolver, c.req.raw.headers, {
      userId: c.get('user').id,
      authMethod: c.get('authMethod') ?? 'cookie',
      credentialHash: accessKey(c).credentialHash,
    });

  // ── Write: atomic batch ────────────────────────────────────────────
  // Body is uniformly { events: [event…] } — a single send is a batch of
  // one. Each event carries its own namespace/type/payload/audience
  // (audience REQUIRED — no default). The batch is all-or-nothing: one
  // transaction, array order, strictly increasing (not necessarily
  // contiguous) server-assigned ids, all visible together at commit; any
  // invalid event rejects the whole batch and inserts nothing. Response is
  // 201 { events: [row…] } in insertion order — the ids are the consumer's
  // dedupe keys and the echoed audience is how tooling asserts its write
  // landed with the intended scope.
  app.post('/api/documents/:documentId/events', bodyLimit({
    maxSize: MAX_EVENTS_BODY_BYTES,
    onError: (c) =>
      c.json(
        { error: 'payload_too_large', message: `request body exceeds ${MAX_EVENTS_BODY_BYTES} bytes` },
        413,
      ),
  }), async (c) => {
    const documentId = c.req.param('documentId');
    const user = c.get('user');
    const g = await gate(documentId, user);
    if (g.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    // Tighter write principal (issue #78 security requirement 2): reading is
    // not enough — only the owner, editors and responders may write. A
    // commenter, or an org reader who is not a collaborator, can see the doc, so
    // 403 (not 404).
    if (!g.mayWrite) return c.json({ error: 'forbidden' }, 403);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    const validated = validateEventBatch(raw);
    if (!validated.ok) {
      return c.json({ error: 'bad_request', message: validated.message }, 400);
    }
    const versionIds = validated.events.flatMap((e) => (e.versionId === null ? [] : [e.versionId]));
    const foreign = await findForeignVersionIds(documentId, versionIds);
    if (foreign.length > 0) {
      return c.json(
        { error: 'bad_request', message: `versionId does not belong to this document: ${foreign[0]}` },
        400,
      );
    }

    const rows = await insertEventBatch(documentId, user.id, validated.events);
    const body: SendEventsResponse = { events: rows };
    return c.json(body, 201);
  });

  // ── Read: token-paginated list ─────────────────────────────────────
  // Document-scoped by default (the document is the unit of the stream —
  // consumer state deliberately spans versions); optional ?versionId= is a
  // provenance lens over rows that DECLARED that version. ?namespace=
  // matches exactly or, with a trailing /*, the namespace and every
  // sub-namespace beneath it; ?type= is exact. Filters are bandwidth
  // hygiene, never a security boundary — audience governs who may read.
  // Returns a bounded page of ascending-id rows + an opaque nextPageToken;
  // follow it to exhaustion (page overlaps are harmless — dedupe by id).
  app.get('/api/documents/:documentId/events', async (c) => {
    const documentId = c.req.param('documentId');
    const user = c.get('user');
    const g = await gate(documentId, user);
    if (g.status === 'not_found') return c.json({ error: 'not_found' }, 404);

    const sinceParsed = parseSince(c.req.query('since'));
    if (!sinceParsed.ok) {
      return c.json({ error: 'bad_request', message: 'since must be a non-negative integer id' }, 400);
    }
    const filterParsed = validateEventFilters({
      namespace: c.req.query('namespace'),
      type: c.req.query('type'),
    });
    if (!filterParsed.ok) {
      return c.json({ error: 'bad_request', message: filterParsed.message }, 400);
    }
    const versionFilter = await validateVersionFilter(documentId, c.req.query('versionId'));
    if (!versionFilter.ok) {
      return c.json({ error: 'bad_request', message: 'versionId must be a version of this document' }, 400);
    }

    let afterId: number | null = sinceParsed.since;
    const pageToken = c.req.query('pageToken');
    if (pageToken !== undefined) {
      const fromToken = decodePageToken(pageToken);
      if (fromToken === null) {
        return c.json({ error: 'bad_request', message: 'pageToken is not a valid page token' }, 400);
      }
      // The token cursor always continues the same logical read, so it wins
      // over (is never less than) the original since.
      afterId = afterId === null ? fromToken : Math.max(afterId, fromToken);
    }

    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_EVENTS_PAGE_SIZE;
    if (rawLimit !== undefined) {
      if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1) {
        return c.json({ error: 'bad_request', message: `limit must be 1..${MAX_EVENTS_PAGE_SIZE}` }, 400);
      }
      limit = Math.min(Number(rawLimit), MAX_EVENTS_PAGE_SIZE);
    }

    const page = await listEvents({
      documentId,
      identity: g.identity,
      filters: filterParsed.filters,
      afterId,
      versionId: versionFilter.versionId,
      limit,
    });
    const body: EventsListResponse = { events: page.rows, nextPageToken: page.nextPageToken };
    return c.json(body, 200);
  });

  // ── Read: SSE stream (one document) ────────────────────────────────
  // One SSE event per row, ascending id, same filters (?namespace / ?type —
  // exact or trailing-/* subtree) and the same per-audience read scope as
  // the list. Every event carries `id:` equal to the row id, so
  // EventSource's native reconnect resumes via Last-Event-ID; ?since is the
  // explicit form of the same resume point. Without either, the stream
  // starts after the latest committed row. Access is re-checked before every
  // read and on the keepalive tick, so a reader who loses access stops
  // receiving rows and the stream closes.
  app.get('/api/documents/:documentId/events/stream', async (c) => {
    // Lowercase, as Postgres reports the id in commit wake-ups: an uppercase URL
    // would replay history but never wake.
    const documentId = c.req.param('documentId').toLowerCase();
    const user = c.get('user');
    const g = await gate(documentId, user);
    if (g.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    const parsed = parseStreamParams(c);
    if (!parsed.ok) return c.json({ error: 'bad_request', message: parsed.message }, 400);
    const { filters } = parsed;

    const reader = (identity: EventReadIdentity) => (afterId: number) =>
      listEvents({ documentId, identity, filters, afterId, limit: DEFAULT_EVENTS_PAGE_SIZE });
    // The connect-time check serves the first read (the resume backlog);
    // every later read runs a fresh check of its own, so each read is judged
    // only by the answer to the check it started, never by an older one
    // finishing late.
    const subscribe = (wake: () => void) => subscribeDocWakes(documentId, wake);
    return runEventStream(c, parsed.resumeFrom, subscribe, reader(g.identity), async () => {
      if (!(await stillSignedIn(c))) return null;
      const fresh = await gate(documentId, user);
      return fresh.status === 'not_found' ? null : reader(fresh.identity);
    }, { ...accessKey(c), documentId });
  });

  // ── Read: SSE stream (every document the caller owns) ──────────────
  // `?scope=me` is the only scope. Same frames, filters and resume rules as
  // the per-document stream; rows carry their documentId. Ownership is part
  // of every read, so a deleted document's rows stop at once.
  app.get('/api/events/stream', async (c) => {
    const user = c.get('user');
    if (c.req.query('scope') !== 'me') {
      return c.json({ error: 'bad_request', message: 'scope must be "me"' }, 400);
    }
    const parsed = parseStreamParams(c);
    if (!parsed.ok) return c.json({ error: 'bad_request', message: parsed.message }, 400);
    const { filters } = parsed;
    // An agent follows its person's owner stream (lib/permissions.ts).
    const ownerId = libraryOwnerId(user);
    const reader = (afterId: number) =>
      listOwnedEvents({ userId: ownerId, readerId: user.id, filters, afterId, limit: DEFAULT_EVENTS_PAGE_SIZE });
    const subscribe = (wake: () => void) => subscribeOwnerWakes(ownerId, wake);
    return runEventStream(
      c,
      parsed.resumeFrom,
      subscribe,
      reader,
      async () => ((await stillSignedIn(c)) ? reader : null),
      accessKey(c),
    );
  });
}

type StreamParams =
  | { ok: true; filters: EventFilters; resumeFrom: number | null }
  | { ok: false; message: string };

function parseStreamParams(c: Context<{ Variables: AppVariables }>): StreamParams {
  const sinceParsed = parseSince(c.req.query('since'));
  if (!sinceParsed.ok) return { ok: false, message: 'since must be a non-negative integer id' };
  const filterParsed = validateEventFilters({
    namespace: c.req.query('namespace'),
    type: c.req.query('type'),
  });
  if (!filterParsed.ok) return { ok: false, message: filterParsed.message };
  // Last-Event-ID (EventSource reconnect) and ?since are both resume points;
  // take the highest. A malformed Last-Event-ID is ignored rather than
  // rejected — the browser sets it, not the caller.
  let resumeFrom = sinceParsed.since;
  const lastEventId = c.req.header('Last-Event-ID');
  if (lastEventId !== undefined && /^\d{1,18}$/.test(lastEventId)) {
    const n = Number(lastEventId);
    resumeFrom = resumeFrom === null ? n : Math.max(resumeFrom, n);
  }
  return { ok: true, filters: filterParsed.filters, resumeFrom };
}

/** What a stream is found by when access changes (auth/revocation.ts). */
function accessKey(c: Context<{ Variables: AppVariables }>): AccessKey {
  const bearer = c.get('authMethod') === 'bearer' ? c.req.header('authorization') : undefined;
  const key: AccessKey = { userId: c.get('user').id };
  if (bearer?.startsWith('Bearer ')) {
    key.credentialHash = createHash('sha256').update(bearer.slice('Bearer '.length).trim(), 'utf8').digest('hex');
  }
  return key;
}

type PageReader = (afterId: number) => Promise<ListEventsPage>;
/** Opens a reader for one pass: re-checks access and returns a page reader,
 *  or null when the caller may no longer read (the stream then closes). */
type OpenReader = () => Promise<PageReader | null>;

/** The shared SSE loop. It keeps one cursor — the last id sent — and on every
 *  wake-up (a committed event write in the stream's scope) reads `id > cursor` to exhaustion.
 *  Because ids follow commit order, that read is complete: a row can never
 *  be skipped by arriving below the cursor, so the cursor, the SSE `id:` and
 *  the client's Last-Event-ID are all safe resume points. Wake-ups that land
 *  during a pass coalesce into one more pass. */
function runEventStream(
  c: Context<{ Variables: AppVariables }>,
  resumeFrom: number | null,
  subscribe: (wake: () => void) => () => void,
  firstReader: PageReader,
  open: OpenReader,
  key: AccessKey,
): Response | Promise<Response> {
  const keepaliveMs = Number(process.env.EVENTS_SSE_KEEPALIVE_MS ?? 25_000);
  return streamSSE(c, async (stream) => {
    let closed = false;
    let releaseHold: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: () => void = () => {};
    let unwatch: () => void = () => {};

    // Ends this connection from the server side. Never throws: it runs on
    // error paths inside detached chains, where an escaping rejection would
    // be unhandled — and an unhandled rejection exits the process.
    const shutdown = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
      unwatch();
      releaseHold();
      try {
        await stream.close();
      } catch {
        // The client is already gone; nothing left to close.
      }
    };

    let cursor = 0;
    let started = false;
    let pumping = false;
    let again = false;
    let nextReader: PageReader | null = firstReader;
    const pump = async (): Promise<void> => {
      if (pumping) {
        again = true;
        return;
      }
      pumping = true;
      try {
        do {
          again = false;
          const read = nextReader ?? (await open());
          nextReader = null;
          if (read === null) {
            await shutdown();
            return;
          }
          for (;;) {
            if (closed) return;
            const page = await read(cursor);
            for (const row of page.rows) {
              if (closed) return;
              await stream.writeSSE({ id: String(row.id), data: JSON.stringify(row) });
              cursor = row.id;
            }
            if (page.nextPageToken === null) break;
          }
        } while (again && !closed);
      } catch {
        await shutdown();
      } finally {
        pumping = false;
      }
    };

    stream.onAbort(() => {
      closed = true;
      clearInterval(keepalive);
      unsubscribe();
      unwatch();
      releaseHold();
    });

    // Subscribe before fixing the start point so no commit falls between.
    // A wake before the start point is fixed is covered by the first pass.
    unsubscribe = subscribe(() => {
      if (!closed && started) void pump();
    });
    try {
      cursor = resumeFrom ?? (await latestEventId());
    } catch {
      await shutdown();
      return;
    }
    // The client may have gone while the cursor was read (onAbort already ran);
    // past here an interval would be installed that nothing clears.
    if (closed) return;
    started = true;

    // The tick doubles as the access re-check, so a stream whose reader
    // lost access is closed even when nothing is being written. It skips
    // while a pass is running (that pass checks) and never overlaps itself.
    let tickChecking = false;
    const tick = async (): Promise<void> => {
      if (closed || pumping || tickChecking) return;
      tickChecking = true;
      try {
        if ((await open()) === null) {
          await shutdown();
          return;
        }
        // SSE comment line — invisible to EventSource, resets idle timers.
        if (!closed) await stream.write(`: keepalive\n\n`);
      } catch {
        await shutdown();
      } finally {
        tickChecking = false;
      }
    };
    keepalive = setInterval(() => {
      void tick();
    }, keepaliveMs);

    // A credential or access change rechecks now, independent of the tick
    // and of a pass in flight (which stops writing once the stream closes).
    unwatch = watchAccess(key, () => {
      if (closed) return;
      void open().then(
        (read) => (read === null ? shutdown() : undefined),
        () => shutdown(),
      );
    });

    // Catch up from the resume point (a no-op read when starting live).
    await pump();
    // Hold the stream open until the client goes away or a re-check closes it.
    await held;
  });
}
