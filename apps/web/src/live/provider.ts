import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

/** Close codes the server ends a live connection with (apps/api/src/live/hub.ts). */
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_SAVE_FAILED = 4500;

export type LiveProvider = { provider: HocuspocusProvider; doc: Y.Doc; destroy(): void };

/** The server answers a probe at once (apps/api/src/live/instance.ts). */
const PING = 'primer:ping';
const PONG = 'primer:pong';
export const PROBE_EVERY_MS = 15_000;
export const PONG_WITHIN_MS = 5_000;

/**
 * Reconnects when the server stops answering. A server that restarts behind
 * a proxy can leave the browser's socket looking open, so nothing would
 * arrive and nothing would say so. Closing it makes the provider reconnect,
 * and a reconnect syncs whatever changed meanwhile.
 */
function watchLiveness(provider: HocuspocusProvider): () => void {
  const socket = provider.configuration.websocketProvider;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  const onStateless = ({ payload }: { payload: string }) => {
    if (payload !== PONG || !waiting) return;
    clearTimeout(waiting);
    waiting = null;
  };
  provider.on('stateless', onStateless);
  const probe = setInterval(() => {
    if (waiting || socket.status !== 'connected' || !provider.isSynced) return;
    provider.sendStateless(PING);
    waiting = setTimeout(() => {
      waiting = null;
      socket.onClose({ event: { code: 4408, reason: 'no answer' } } as never);
    }, PONG_WITHIN_MS);
  }, PROBE_EVERY_MS);
  return () => {
    clearInterval(probe);
    if (waiting) clearTimeout(waiting);
    provider.off('stateless', onStateless);
  };
}

/**
 * The live connection to one document: `/collab` on the app's own origin
 * (the session cookie authenticates it), document `doc:<id>`.
 */
export function createLiveProvider(documentId: string): LiveProvider {
  const doc = new Y.Doc();
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const provider = new HocuspocusProvider({
    url: `${scheme}//${window.location.host}/collab`,
    name: `doc:${documentId}`,
    document: doc,
    // Retry at least every five seconds (the socket's own default backs off
    // to 30), so a restarted server is back in the editor within seconds.
    maxDelay: 5_000,
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  const unwatch = watchLiveness(provider);
  return {
    provider,
    doc,
    destroy() {
      unwatch();
      provider.destroy();
      doc.destroy();
    },
  };
}
