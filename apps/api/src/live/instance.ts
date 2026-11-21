import * as Y from 'yjs';
import { Hocuspocus } from '@hocuspocus/server';
import { attachPersistence, loadYDoc, persistedUpTo, touchedOf } from './persist.ts';
import { liveAccess, type LiveContext } from './auth.ts';
import { logger } from '../logger.ts';
import { sanitizeClientAwareness } from './awareness.ts';
import { SYSTEM_ORIGIN, originOf, type LiveOrigin } from './origin.ts';
import { cancelOrphanSync, scheduleOrphanSync } from './orphans.ts';
import { onLifecycleCommitted } from '../lib/events.ts';

/** Lifecycle events an open editor follows (comments, threads,
 *  suggestions), relayed to the document's peers as a stateless message
 *  `{ type: 'primer.event', event: { type } }` once committed. Every peer may
 *  read the document, and the message carries only the type: the editor
 *  refetches. Proxies may hold back the event stream; the socket is live. */
const RELAYED = /^(comment|thread|suggestion)\./;

onLifecycleCommitted((event) => {
  if (!RELAYED.test(event.type)) return;
  instance?.documents.get(liveDocName(event.documentId))?.broadcastStateless(
    JSON.stringify({ type: 'primer.event', event: { type: event.type } }),
  );
});

/** A peer's liveness probe and the answer (stateless messages). */
export const LIVENESS_PING = 'primer:ping';
export const LIVENESS_PONG = 'primer:pong';

const NAME = /^doc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The Hocuspocus document name of a live document. */
export function liveDocName(documentId: string): string {
  return `doc:${documentId}`;
}

/** The document id in a Hocuspocus document name, or null. */
export function documentIdOf(name: string): string | null {
  return NAME.exec(name)?.[1] ?? null;
}

const failureHandlers = new Set<(documentId: string, doc: Y.Doc) => void>();

/** Runs when a document's persistence fails (the hub closes its sockets). */
export function onPersistenceFailure(handler: (documentId: string, doc: Y.Doc) => void): () => void {
  failureHandlers.add(handler);
  return () => failureHandlers.delete(handler);
}

type UpdateHandler = (documentId: string, origin: LiveOrigin, touched: string[]) => void;
const updateHandlers = new Set<UpdateHandler>();

/** Runs after every change to a loaded live document, with who made it and
 *  the block ids it touched (indexes kept from the document, such as tasks,
 *  schedule their sync). */
export function onLiveUpdate(handler: UpdateHandler): () => void {
  updateHandlers.add(handler);
  return () => updateHandlers.delete(handler);
}

const loadHandlers = new Set<(documentId: string) => void>();

/** Runs when a live document has been loaded into memory (indexes kept from
 *  the document, such as tasks, catch up with what changed while it was
 *  unloaded). Must not wait on the document itself. */
export function onLiveLoad(handler: (documentId: string) => void): () => void {
  loadHandlers.add(handler);
  return () => loadHandlers.delete(handler);
}

let instance: Hocuspocus | null = null;

/**
 * The process's one Hocuspocus: one in-memory Y.Doc per open live document,
 * shared by WebSocket peers (live/hub.ts) and server writes (live/pipeline.ts)
 * so both see the same state. Peers are authorised per document; loading
 * applies the stored state and then attaches persistence; unloading waits for
 * queued inserts.
 */
export function liveInstance(): Hocuspocus {
  instance ??= new Hocuspocus({
    quiet: true,
    // WebSocket peers only (live/hub.ts resolved `auth` at the upgrade); server
    // writes open direct connections, which skip this hook.
    async onAuthenticate({ context, documentName, connectionConfig }) {
      const { auth: opened, reauth } = context as LiveContext;
      const documentId = documentIdOf(documentName);
      if (!opened || !documentId) throw new Error('forbidden');
      // The upgrade's auth may be stale: a token revoked since then must not join.
      const auth = reauth ? await reauth() : opened;
      if (!auth) throw new Error('forbidden');
      const access = await liveAccess(auth, documentId);
      if (access === 'none') throw new Error('forbidden');
      connectionConfig.readOnly = access !== 'write';
      return { user: auth.user, documentId } satisfies LiveContext;
    },
    // Awareness is client-writable; only the server sets agent states.
    async beforeHandleAwareness({ context, documentName, states, removedClients }) {
      const user = (context as LiveContext | undefined)?.user;
      const documentId = documentIdOf(documentName);
      if (user && documentId) sanitizeClientAwareness(documentId, user, states, removedClients);
    },
    async onLoadDocument({ document, documentName }) {
      const documentId = documentIdOf(documentName);
      if (!documentId) throw new Error(`not a live document name: ${documentName}`);
      const { doc, docVersion } = await loadYDoc(documentId);
      Y.applyUpdate(document, Y.encodeStateAsUpdate(doc));
      doc.destroy();
      const detach = attachPersistence(document, documentId, {
        docVersion,
        onFailure: (err) => {
          logger.error({ documentId, error: err.message }, 'live document: saving an update failed');
          for (const handler of failureHandlers) handler(documentId, document);
        },
      });
      const onUpdate = (_update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
        scheduleOrphanSync(documentId, document);
        const by = originOf(origin);
        const touched = touchedOf(tr);
        for (const handler of updateHandlers) handler(documentId, by, touched);
      };
      document.on('update', onUpdate);
      for (const handler of loadHandlers) handler(documentId);
      // Detach only once the document is really gone: Hocuspocus keeps it
      // after beforeUnloadDocument when someone connected meanwhile.
      document.on('destroy', () => {
        document.off('update', onUpdate);
        cancelOrphanSync(documentId);
        void detach();
      });
    },
    // Liveness: a browser probes its connection (web live/provider.ts), since
    // through proxies a server that went away can leave the socket open.
    async onStateless({ connection, payload }) {
      if (payload === LIVENESS_PING) connection.sendStateless(LIVENESS_PONG);
    },
    async beforeUnloadDocument({ document }) {
      await persistedUpTo(document).catch(() => undefined);
    },
  });
  return instance;
}

/**
 * Runs `fn` against a live document's in-memory Y.Doc (loading it if no one
 * has it open), for reads such as exports. Writes go through `applyPlan`.
 */
export async function withLiveDocument<T>(documentId: string, fn: (doc: Y.Doc) => T | Promise<T>): Promise<T> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), SYSTEM_ORIGIN);
  try {
    return await fn(connection.document!);
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}
