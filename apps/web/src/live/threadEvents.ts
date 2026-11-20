import { useEffect, useRef } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';

const THREAD_EVENTS = new Set(['comment.created', 'thread.resolved', 'thread.updated', 'thread.orphaned']);

/** Sent to every listener when the stream is back after a break: events
 *  in between were missed, so listeners refetch. */
export const STREAM_REOPENED = 'stream.reopened';

type Listener = (type: string, payload: unknown) => void;
type Shared = { source: EventSource; listeners: Set<Listener>; broken: boolean; failures: number; retry?: ReturnType<typeof setTimeout> };

/** One event stream per document, shared by every listener on the page: each
 *  stream holds a connection, and a browser allows only a few per host. */
const streams = new Map<string, Shared>();

/**
 * Opens the stream. EventSource retries a dropped connection itself, but
 * gives up for good on an error response (a proxy's 502 while the server
 * restarts): then it is opened again, backing off up to 30 seconds.
 */
function connect(documentId: string, shared: Shared): EventSource {
  const source = new EventSource(`/api/documents/${encodeURIComponent(documentId)}/events/stream`);
  source.onopen = () => {
    shared.failures = 0;
    if (!shared.broken) return;
    shared.broken = false;
    for (const l of shared.listeners) l(STREAM_REOPENED, null);
  };
  source.onerror = () => {
    shared.broken = true;
    if (source.readyState !== EventSource.CLOSED) return;
    const delay = Math.min(30_000, 1_000 * 2 ** shared.failures++);
    shared.retry = setTimeout(() => {
      if (streams.get(documentId) === shared) shared.source = connect(documentId, shared);
    }, delay);
  };
  source.onmessage = (message) => {
    const row = JSON.parse(message.data as string) as { namespace?: string; type?: string; payload?: unknown };
    if (row.namespace === 'primer' && row.type) for (const l of shared.listeners) l(row.type, row.payload);
  };
  return source;
}

/**
 * Hands this document's listeners the events its live socket relays
 * (`primer.event` stateless messages: proxies may hold back the event
 * stream, never the socket), and a resync once the socket is back after a
 * break, for whatever was missed meanwhile.
 */
export function relayLiveEvents(documentId: string, provider: HocuspocusProvider): () => void {
  const deliver = (type: string) => {
    for (const l of streams.get(documentId)?.listeners ?? []) l(type, null);
  };
  const onStateless = ({ payload }: { payload: string }) => {
    let message: { type?: unknown; event?: { type?: unknown } } | null;
    try {
      message = JSON.parse(payload) as { type?: unknown; event?: { type?: unknown } } | null;
    } catch {
      return;
    }
    const type = message?.type === 'primer.event' ? message.event?.type : undefined;
    if (typeof type === 'string') deliver(type);
  };
  let syncedBefore = false;
  const onSynced = ({ state }: { state: boolean }) => {
    if (!state) return;
    if (syncedBefore) deliver(STREAM_REOPENED);
    syncedBefore = true;
  };
  provider.on('stateless', onStateless);
  provider.on('synced', onSynced);
  return () => {
    provider.off('stateless', onStateless);
    provider.off('synced', onSynced);
  };
}

function subscribe(documentId: string, listener: Listener): () => void {
  let shared = streams.get(documentId);
  if (!shared) {
    const created = { listeners: new Set<Listener>(), broken: false, failures: 0 } as unknown as Shared;
    streams.set(documentId, created);
    created.source = connect(documentId, created);
    shared = created;
  }
  const entry = shared;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      clearTimeout(entry.retry);
      entry.source.close();
      streams.delete(documentId);
    }
  };
}

/**
 * Calls `onChange` when the document's comments change (Primer's own
 * lifecycle events on the document's event stream), so every viewer's
 * comments sidebar follows other people's comments, replies and resolves.
 * After a break in the stream it is called once more, for what was missed.
 */
export function useThreadEvents(documentId: string, onChange: () => void, types: ReadonlySet<string> = THREAD_EVENTS): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    return subscribe(documentId, (type) => {
      if (types.has(type) || type === STREAM_REOPENED) latest.current();
    });
  }, [documentId, types]);
}

/**
 * Calls `onChange` with the collections others changed (a coalesced
 * `primer.data.changed` on the document's stream). The viewer's own writes
 * never come back as events: refresh after them yourself.
 */
export function useDataChanged(documentId: string, onChange: (collections: string[]) => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    return subscribe(documentId, (type, payload) => {
      if (type !== 'data.changed') return;
      const collections = (payload as { collections?: unknown } | null)?.collections;
      if (Array.isArray(collections)) latest.current(collections.filter((c): c is string => typeof c === 'string'));
    });
  }, [documentId]);
}
