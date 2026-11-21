/**
 * Parent-side delivery engine for the document-events read relay
 * (issue #78, fleet-command Pin 9): hydrate the visible event list, hold an
 * SSE subscription, and hand `artifact`-audience rows to the caller in
 * coalesced batches for forwarding into the sandboxed iframe.
 *
 * Delivery mechanics are ENTIRELY this side's responsibility and invisible
 * to the artifact (it has no network and no connection awareness). The
 * contract owed is at-least-once, eventually-complete delivery of the
 * document's `artifact`-audience rows:
 *
 *  - every stream event carries an SSE `id:` equal to the row id, so
 *    EventSource's native reconnect resumes via Last-Event-ID;
 *  - the stream always opens with an explicit `?since=<highest id seen>`,
 *    `since=0` when the hydrate found nothing or failed. Without it the
 *    server starts at its latest id when the connection is set up, and a
 *    row committed between our hydrate and that moment would never arrive;
 *  - on every successful open (the first one and each reconnect) and on
 *    page-visibility regain — or any doubt — we re-read everything after
 *    the highest id seen, re-relay anything missed and tell the page to
 *    resync. Ids follow commit order, so that read is complete: no row can
 *    commit below an id already seen;
 *  - duplicates and overlaps are legal by design (this module suppresses
 *    them by id as a courtesy; artifact code must dedupe by id anyway).
 *
 * Batch grouping carries NO semantics: consumers must derive identical
 * state however the same rows are partitioned into dispatches — which is
 * exactly what makes coalescing purely this side's optimization to tune.
 *
 * DI-friendly by construction (fetch, EventSource, and timers injected) so
 * the whole engine is testable without a browser.
 */
import { PRIMER_EVENT_NAMESPACE, type EventRowDTO, type EventsListResponse } from '@polygonlabs/primer-api-types';

/** Minimal slice of EventSource this engine needs. */
export interface EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  /** EventSource's readyState: 2 (CLOSED) after an error means it gave up
   *  (a non-200 reply, e.g. a 502 during a rollout) and will not reconnect. */
  readonly readyState?: number;
  close(): void;
}

export interface EventsFeedOptions {
  documentId: string;
  /** Receives coalesced batches of `artifact`-audience rows, ascending id. */
  onBatch: (rows: EventRowDTO[]) => void;
  /** Receives Primer's own lifecycle rows (namespace `primer`: comments,
   *  threads, versions, runs) as the stream delivers them. They
   *  are page notifications and are never relayed into the artifact. */
  onDocChange?: (row: EventRowDTO) => void;
  /** Called after every re-hydrate (each stream open, visibility regain):
   *  anything the page shows may have changed before the stream was up. */
  onResync?: () => void;
  /** Same-origin fetch (cookie-authed); inject `api` from lib/fetch.ts. */
  fetchImpl: (url: string) => Promise<Response>;
  /** EventSource factory; inject `(url) => new EventSource(url)`. */
  eventSourceFactory: (url: string) => EventSourceLike;
  /** Stream-burst coalescing window, ms. */
  coalesceMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export interface EventsFeed {
  /** Hydrates the list (one relay batch), then subscribes to the stream. */
  start(): Promise<void>;
  stop(): void;
  /** Call on page-visibility regain (or any doubt): full re-hydrate. Not limited
   *  to ids above the highest seen: rows that became readable after an access
   *  change sit below it. The seen-set drops what was already relayed. */
  refresh(): Promise<void>;
}

const DEFAULT_COALESCE_MS = 25;
const MAX_RECONNECT_MS = 30_000;

/** Browser glue: adapts a real EventSource to the injectable interface
 *  (the native handler-property types don't structurally match the minimal
 *  slice above). */
export function browserEventSourceFactory(url: string): EventSourceLike {
  const es = new EventSource(url);
  const like: EventSourceLike = {
    onmessage: null,
    onopen: null,
    onerror: null,
    get readyState() {
      return es.readyState;
    },
    close: () => es.close(),
  };
  es.onmessage = (ev) => like.onmessage?.({ data: String(ev.data), lastEventId: ev.lastEventId });
  es.onopen = (ev) => like.onopen?.(ev);
  es.onerror = (ev) => like.onerror?.(ev);
  return like;
}

export function createEventsFeed(opts: EventsFeedOptions): EventsFeed {
  const {
    documentId,
    onBatch,
    onDocChange,
    onResync,
    fetchImpl,
    eventSourceFactory,
    coalesceMs = DEFAULT_COALESCE_MS,
    setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutImpl = (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  } = opts;

  let stopped = false;
  let source: EventSourceLike | null = null;
  /** Ids already relayed — the courtesy dedupe. */
  const seen = new Set<number>();
  let highestSeen = 0;

  let pending: EventRowDTO[] = [];
  let flushHandle: unknown = null;
  let reconnectHandle: unknown = null;
  let reconnectAttempts = 0;

  function relay(rows: EventRowDTO[]): void {
    const fresh = rows
      .filter((r) => r.audience === 'artifact' && !seen.has(r.id))
      .sort((a, b) => a.id - b.id);
    for (const r of rows) {
      // Track EVERY delivered row (any audience) — the stream subscription
      // resumes from this frontier (a resume hint only; completeness comes
      // from the full re-hydrates).
      if (r.id > highestSeen) highestSeen = r.id;
    }
    if (fresh.length === 0) return;
    for (const r of fresh) seen.add(r.id);
    onBatch(fresh);
  }

  function scheduleFlush(): void {
    if (flushHandle !== null) return;
    flushHandle = setTimeoutImpl(() => {
      flushHandle = null;
      const batch = pending;
      pending = [];
      relay(batch);
    }, coalesceMs);
  }

  async function fetchAll(sinceId: number | null): Promise<EventRowDTO[]> {
    const rows: EventRowDTO[] = [];
    let pageToken: string | null = null;
    do {
      const params = new URLSearchParams();
      if (sinceId !== null && sinceId > 0) params.set('since', String(sinceId));
      if (pageToken !== null) params.set('pageToken', pageToken);
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      const res = await fetchImpl(`/api/documents/${documentId}/events${qs}`);
      if (!res.ok) throw new Error(`events list fetch failed: ${res.status}`);
      const body = (await res.json()) as EventsListResponse;
      rows.push(...body.events);
      pageToken = body.nextPageToken;
    } while (pageToken !== null);
    return rows;
  }

  async function hydrate(sinceId: number | null): Promise<void> {
    const rows = await fetchAll(sinceId);
    if (stopped) return;
    relay(rows); // one batch — a (re-)fetch arrives as a single dispatch
  }

  async function resync(full: boolean): Promise<void> {
    if (stopped) return;
    // A reconnect reads everything after the highest id seen: ids follow
    // commit order, so nothing missed while disconnected can sit below it.
    // A visibility regain reads it all (see `refresh`).
    try {
      await hydrate(full ? null : highestSeen);
    } catch {
      // Best-effort: the stream (or the next refresh) will catch us up.
    }
    if (!stopped) onResync?.();
  }

  const refresh = () => resync(true);

  function subscribe(): void {
    if (stopped) return;
    // Always explicit, 0 included: with no `since` the server starts from
    // its latest id at connection time and skips anything committed since
    // our hydrate.
    source = eventSourceFactory(`/api/documents/${documentId}/events/stream?since=${highestSeen}`);
    source.onmessage = (ev) => {
      let row: EventRowDTO;
      try {
        row = JSON.parse(ev.data) as EventRowDTO;
      } catch {
        return;
      }
      if (typeof row?.id !== 'number') return;
      if (row.namespace === PRIMER_EVENT_NAMESPACE) onDocChange?.(row);
      pending.push(row);
      scheduleFlush();
    };
    // EventSource reconnects on its own (with Last-Event-ID). Every open,
    // the first included, re-reads and resyncs: the page's own queries (and
    // a failed initial hydrate) predate the stream.
    source.onopen = () => {
      reconnectAttempts = 0;
      void resync(false);
    };
    // A native EventSource retries a dropped connection but gives up on a
    // non-200 reply; recreate it then, from the highest id seen, with backoff.
    source.onerror = () => {
      const failed = source;
      if (stopped || failed === null || failed.readyState !== 2) return;
      failed.close();
      source = null;
      if (reconnectHandle !== null) return;
      const delay = Math.min(MAX_RECONNECT_MS, 1000 * 2 ** reconnectAttempts++);
      reconnectHandle = setTimeoutImpl(() => {
        reconnectHandle = null;
        subscribe();
      }, delay);
    };
  }

  return {
    async start(): Promise<void> {
      try {
        await hydrate(null);
      } catch {
        // Initial hydrate failed (transient network?) — the stream opens
        // with since=0 and its first open re-hydrates; artifact state is a
        // fold, so late delivery is correctness-preserving.
      }
      subscribe();
    },
    stop(): void {
      stopped = true;
      if (flushHandle !== null) {
        clearTimeoutImpl(flushHandle);
        flushHandle = null;
      }
      pending = [];
      if (reconnectHandle !== null) {
        clearTimeoutImpl(reconnectHandle);
        reconnectHandle = null;
      }
      source?.close();
      source = null;
    },
    refresh,
  };
}
