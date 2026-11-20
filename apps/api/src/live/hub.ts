import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import crossws from 'crossws/adapters/node';
import type { Connection, Document, Hocuspocus, WebSocketLike } from '@hocuspocus/server';
import type { UserResolver } from '../auth/resolver.ts';
import { logger } from '../logger.ts';
import { onAccessRecheck, resolveFromHeaders, type AccessMatch } from '../auth/revocation.ts';
import { liveAccess, type LiveAuth, type LiveContext } from './auth.ts';
import { documentIdOf, liveInstance, onPersistenceFailure } from './instance.ts';

/** The WebSocket path live documents sync on. */
export const COLLAB_PATH = '/collab';
/** Close codes the editor reacts to. */
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_SAVE_FAILED = 4500;
/** The backstop recheck: bearer connections every tick, others every sixth. */
const TICK_MS = 10_000;
const TICKS_PER_SESSION_RECHECK = 6;

export type Hub = {
  hocuspocus: Hocuspocus;
  /** For the API server's `upgrade` event; anything but /collab is refused. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Re-evaluates the matching connections now: closes those that lost read
   *  access (or whose credentials no longer resolve), makes read-only those
   *  that lost write. Handlers reach it through `recheckAccess`. */
  recheck(match: AccessMatch): Promise<void>;
  close(): void;
};

/**
 * Hocuspocus inside the API process, on its own HTTP server's `upgrade`
 * event, wired the way Hocuspocus's own Server is (crossws's node adapter).
 *
 * The upgrade is authenticated with Primer's own resolver chain. A
 * browser-credential connection (cookie, mock, proxy) must come from the app's
 * own Origin, so another site can't open a socket with a visitor's cookie.
 * Per document, `onAuthenticate` (live/instance.ts) admits readers read-only
 * and owners and editors read-write; bearer connections are always read-only.
 * Every handler that removes credentials or access rechecks the affected
 * connections at once (`recheckAccess`); a timer is the backstop.
 */
export function createHub(deps: { resolver: UserResolver; appOrigin: string }): Hub {
  const hocuspocus = liveInstance();

  const ws = crossws({
    hooks: {
      upgrade: async (request) => {
        const auth = await resolveFromHeaders(deps.resolver, request.headers);
        if (!auth) throw new Response('unauthorized', { status: 401 });
        if (auth.authMethod !== 'bearer' && request.headers.get('origin') !== deps.appOrigin) {
          throw new Response('forbidden', { status: 403 });
        }
        if (auth.scopes && !auth.scopes.includes('documents:read')) {
          throw new Response('forbidden', { status: 403 });
        }
        return { context: { auth } };
      },
      open: (peer) => {
        const context: LiveContext = { auth: peer.context.auth as LiveAuth };
        const client = hocuspocus.handleConnection(peer.websocket as unknown as WebSocketLike, peer.request, context);
        (peer as unknown as { _hocuspocus: typeof client })._hocuspocus = client;
        // As Hocuspocus's Server does: pongs count as activity.
        (peer.websocket as unknown as { on?: (event: string, fn: () => void) => void }).on?.('pong', () => client.touch());
      },
      message: (peer, message) => {
        (peer as unknown as { _hocuspocus?: { handleMessage(data: Uint8Array): void } })._hocuspocus?.handleMessage(
          message.uint8Array(),
        );
      },
      close: (peer, event) => {
        (peer as unknown as { _hocuspocus?: { handleClose(e: { code?: number; reason?: string }): void } })._hocuspocus?.handleClose(
          { code: event.code, reason: event.reason },
        );
      },
      error: (peer, error) => {
        logger.warn({ peer: peer.id, error: String(error) }, 'live: websocket error');
      },
    },
  });

  // Close the socket first, so the editor sees the code (a protocol-level
  // close would reach it as 1000), then detach the connection from the
  // document at once, so no further update from it applies.
  const closeConnection = (connection: Connection, code: number, reason: string) => {
    connection.webSocket.close(code, reason);
    connection.close({ code, reason });
  };

  const recheckConnection = async (connection: Connection, documentId: string) => {
    const context = connection.context as LiveContext;
    let access: 'none' | 'read' | 'write' = 'none';
    try {
      // Re-resolve too: a signed-out session or revoked token loses access.
      const auth = await resolveFromHeaders(deps.resolver, connection.request.headers);
      if (auth && auth.user.id === context.auth?.user.id) access = await liveAccess(auth, documentId);
    } catch (err) {
      logger.warn({ documentId, error: String(err) }, 'live: access recheck failed; closing');
    }
    if (access === 'none') closeConnection(connection, CLOSE_FORBIDDEN, 'forbidden');
    else connection.readOnly = access === 'read';
  };

  const connections = (): { connection: Connection; documentId: string }[] =>
    [...hocuspocus.documents.entries()].flatMap(([name, document]) => {
      const documentId = documentIdOf(name);
      return documentId ? document.getConnections().map((connection) => ({ connection, documentId })) : [];
    });

  const matches = (connection: Connection, documentId: string, match: AccessMatch): boolean => {
    const auth = (connection.context as LiveContext).auth;
    if ('documentId' in match) return match.documentId === documentId;
    if ('userId' in match) return auth?.user.id === match.userId;
    return auth?.credentialHash === match.credentialHash;
  };

  const recheck = async (match: AccessMatch) => {
    await Promise.all(
      connections()
        .filter(({ connection, documentId }) => matches(connection, documentId, match))
        .map(({ connection, documentId }) => recheckConnection(connection, documentId)),
    );
  };
  const stopRecheck = onAccessRecheck(recheck);

  let tick = 0;
  const timer = setInterval(() => {
    const everyone = ++tick % TICKS_PER_SESSION_RECHECK === 0;
    for (const { connection, documentId } of connections()) {
      if (everyone || (connection.context as LiveContext).auth?.authMethod === 'bearer') {
        void recheckConnection(connection, documentId);
      }
    }
  }, TICK_MS);
  timer.unref();

  // A document whose update couldn't be stored is dropped from memory so it
  // reloads from what was stored; its editors reconnect and resend.
  const stopFailures = onPersistenceFailure((_documentId, doc) => {
    const document = doc as Document;
    for (const connection of document.getConnections()) closeConnection(connection, CLOSE_SAVE_FAILED, 'save_failed');
    hocuspocus.unloadDocument(document).catch((err: unknown) => {
      logger.error({ error: String(err) }, 'live: unloading a document after a save failure failed');
    });
  });

  return {
    hocuspocus,
    handleUpgrade(req, socket, head) {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== COLLAB_PATH) {
        socket.destroy();
        return;
      }
      ws.handleUpgrade(req, socket, head);
    },
    recheck,
    close() {
      clearInterval(timer);
      stopFailures();
      stopRecheck();
      // Shutting down: close every live connection (1012, service restart)
      // so browsers reconnect to the next server at once, instead of an
      // exiting process keeping their sockets open.
      for (const document of hocuspocus.documents.values()) {
        for (const connection of document.getConnections()) closeConnection(connection, 1012, 'restart');
      }
    },
  };
}
