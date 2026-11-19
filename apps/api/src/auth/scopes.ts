import type { Context, MiddlewareHandler } from 'hono';
import type { ApiTokenScope } from '@polygonlabs/primer-api-types';
import { isApiTokenScope } from '@polygonlabs/primer-api-types';
import type { AppVariables } from '../app.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A route a scoped API token may call, and the scope it needs. `scope: null`
 * means any scoped token may call it (identity, and the MCP transport, which
 * gates each tool by scope itself — see mcp/transport.ts).
 *
 * Patterns use Hono's `:param` syntax and must match the registered route
 * exactly; scopes.test.ts fails if a registered route is in neither this
 * table nor NOT_GRANTABLE, so a new route is unreachable with a scoped token
 * until someone decides which scope it belongs to.
 */
export interface ScopedRoute {
  method: Method;
  path: string;
  scope: ApiTokenScope | null;
  /** Decided ahead of the route itself (live documents land their scope rows
   *  before their routes). Exempt from the stale-row check until registered. */
  upcoming?: true;
}

export const ROUTE_SCOPES: readonly ScopedRoute[] = [
  { method: 'GET', path: '/api/me', scope: null },
  { method: 'POST', path: '/mcp', scope: null },

  { method: 'GET', path: '/api/library', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:docId', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:docId/versions', scope: 'documents:read' },
  { method: 'GET', path: '/api/versions/:versionId/content', scope: 'documents:read' },
  { method: 'GET', path: '/api/versions/:versionId/threads', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:docId/threads', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:documentId/events', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:documentId/events/stream', scope: 'documents:read' },
  { method: 'GET', path: '/api/events/stream', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:docId/live', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:docId/agents', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:docId/runs', scope: 'documents:read' },
  { method: 'GET', path: '/api/runs', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:docId/suggestions', scope: 'documents:read' },
  { method: 'GET', path: '/api/documents/:docId/export', scope: 'documents:read' },
  { method: 'GET', path: '/api/versions/:versionId/ydoc', scope: 'documents:read' },
  { method: 'GET', path: '/api/files/:fileId', scope: 'documents:read' },

  { method: 'POST', path: '/api/upload', scope: 'documents:write' },
  { method: 'POST', path: '/api/documents/:docId/versions', scope: 'documents:write' },
  // Title/description, and visibility only towards private: a scoped token
  // asking for `visibility: 'org'` is refused in the handler
  // (routes/documents.ts).
  { method: 'PATCH', path: '/api/documents/:docId', scope: 'documents:write' },
  { method: 'PATCH', path: '/api/versions/:versionId', scope: 'documents:write' },
  { method: 'POST', path: '/api/documents/:docId/ops', scope: 'documents:write' },
  // Agents work their runs with documents:write (the run must be theirs).
  { method: 'POST', path: '/api/runs/:runId/claim', scope: 'documents:write' },
  { method: 'POST', path: '/api/runs/:runId/status', scope: 'documents:write' },
  { method: 'POST', path: '/api/runs/:runId/finish', scope: 'documents:write' },
  { method: 'POST', path: '/api/runs/:runId/cancel', scope: 'documents:write' },
  { method: 'POST', path: '/api/runs/:runId/undo', scope: 'documents:write' },
  // An agent withdraws its own suggestions; deciding them is for people.
  { method: 'POST', path: '/api/suggestions/:id/withdraw', scope: 'documents:write' },
  { method: 'POST', path: '/api/documents/:docId/checkpoints', scope: 'documents:write' },
  { method: 'POST', path: '/api/versions/:versionId/restore', scope: 'documents:write' },
  { method: 'POST', path: '/api/documents/:docId/files', scope: 'documents:write' },

  { method: 'POST', path: '/api/versions/:versionId/threads', scope: 'comments:write' },
  { method: 'POST', path: '/api/threads/:threadId/comments', scope: 'comments:write' },
  { method: 'POST', path: '/api/threads/:threadId/resolve', scope: 'comments:write' },
  { method: 'POST', path: '/api/threads/:threadId/reopen', scope: 'comments:write' },
  { method: 'PATCH', path: '/api/comments/:commentId', scope: 'comments:write' },
  { method: 'DELETE', path: '/api/comments/:commentId', scope: 'comments:write' },
  { method: 'POST', path: '/api/comments/:commentId/restore', scope: 'comments:write' },
  { method: 'POST', path: '/api/documents/:docId/threads', scope: 'comments:write' },
  { method: 'POST', path: '/api/threads/:threadId/reanchor', scope: 'comments:write' },
  { method: 'POST', path: '/api/comments/:commentId/reactions/:emoji', scope: 'comments:write' },
  { method: 'DELETE', path: '/api/comments/:commentId/reactions/:emoji', scope: 'comments:write' },

  // Asking an agent is like commenting.
  { method: 'POST', path: '/api/documents/:docId/runs', scope: 'comments:write' },
  { method: 'POST', path: '/api/runs/:runId/retry', scope: 'comments:write' },

  { method: 'POST', path: '/api/documents/:documentId/events', scope: 'events:write' },

  { method: 'GET', path: '/api/documents/:docId/collaborators', scope: 'collaborators:manage' },
  { method: 'POST', path: '/api/documents/:docId/collaborators', scope: 'collaborators:manage' },
  { method: 'PATCH', path: '/api/documents/:docId/collaborators/:userId', scope: 'collaborators:manage' },
  { method: 'DELETE', path: '/api/documents/:docId/collaborators/:userId', scope: 'collaborators:manage' },

  { method: 'GET', path: '/api/users/lookup', scope: 'users:read' },
  { method: 'GET', path: '/api/users', scope: 'users:read' },
  { method: 'GET', path: '/api/users/mentionable', scope: 'users:read' },
];

/**
 * Routes deliberately left without a scope: a scoped token gets 403 on them.
 * Listed (with the reason) so the coverage test can tell "decided" from
 * "forgotten". Unrestricted tokens are unaffected by this list.
 */
export const NOT_GRANTABLE: readonly { method: Method; path: string; reason: string }[] = [
  { method: 'DELETE', path: '/api/documents/:docId', reason: 'destructive; owner action in the UI' },
  { method: 'POST', path: '/api/documents/:docId/restore', reason: 'pairs with delete' },
  { method: 'GET', path: '/api/documents/:docId/external-share', reason: 'external sharing leaves the org' },
  { method: 'POST', path: '/api/documents/:docId/external-share', reason: 'external sharing leaves the org' },
  { method: 'DELETE', path: '/api/documents/:docId/external-share', reason: 'external sharing leaves the org' },
  { method: 'POST', path: '/api/documents/:docId/external-share/recipients', reason: 'external sharing leaves the org' },
  { method: 'DELETE', path: '/api/documents/:docId/external-share/recipients/:recipientId', reason: 'external sharing leaves the org' },
  { method: 'POST', path: '/api/documents/:docId/external-share/publish', reason: 'external sharing leaves the org' },
  { method: 'GET', path: '/api/documents/:docId/external-share/views', reason: 'external sharing leaves the org' },
  { method: 'POST', path: '/api/folders', reason: 'per-user library organisation' },
  { method: 'PATCH', path: '/api/folders/:folderId', reason: 'per-user library organisation' },
  { method: 'DELETE', path: '/api/folders/:folderId', reason: 'per-user library organisation' },
  { method: 'PUT', path: '/api/documents/:docId/folder', reason: 'per-user library organisation' },
  { method: 'GET', path: '/api/tokens', reason: 'token management' },
  { method: 'POST', path: '/api/tokens', reason: 'token management (session-only)' },
  { method: 'DELETE', path: '/api/tokens/:id', reason: 'token management' },
  { method: 'GET', path: '/api/agents', reason: 'agent management (session-only)' },
  { method: 'POST', path: '/api/agents', reason: 'agent management (session-only)' },
  { method: 'POST', path: '/api/agents/:agentId/tokens', reason: 'token management (session-only)' },
  { method: 'DELETE', path: '/api/agents/:agentId/tokens/:tokenId', reason: 'token management (session-only)' },
  { method: 'GET', path: '/api/device/pending', reason: 'device login is for humans' },
  { method: 'POST', path: '/api/device/approve', reason: 'device login (session-only)' },
  { method: 'POST', path: '/api/device/deny', reason: 'device login (session-only)' },
  { method: 'GET', path: '/api/admin/stats', reason: 'admin (session-only)' },
  { method: 'POST', path: '/auth/logout', reason: 'browser session' },
  { method: 'POST', path: '/api/runs/:runId/approve', reason: 'a person approves an agent\'s plan; agents never do' },
  { method: 'POST', path: '/api/suggestions/:id/accept', reason: 'a person decides a suggestion; agents never do' },
  { method: 'POST', path: '/api/suggestions/:id/reject', reason: 'a person decides a suggestion; agents never do' },
];

function compile(path: string): RegExp {
  const escaped = path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}

const COMPILED = ROUTE_SCOPES.map((r) => ({ ...r, re: compile(r.path) }));

/**
 * Looks up the scoped-route entry for a request. HEAD is matched as GET,
 * mirroring Hono's routing. Returns undefined for anything not in
 * ROUTE_SCOPES (including NOT_GRANTABLE routes).
 */
export function findScopedRoute(method: string, path: string): ScopedRoute | undefined {
  const m = method === 'HEAD' ? 'GET' : method;
  return COMPILED.find((r) => r.method === m && r.re.test(path));
}

/** Parses the `scopes` column; unknown values are dropped (fail closed). */
export function parseStoredScopes(raw: unknown): ApiTokenScope[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isApiTokenScope);
}

/**
 * Validates `scopes` from an untrusted request body. `undefined` (absent)
 * means an unrestricted token; otherwise it must be a non-empty array of
 * known scopes. Returns the deduplicated list in canonical order, or null
 * when invalid.
 */
export function parseRequestedScopes(
  raw: unknown,
): { ok: true; scopes: ApiTokenScope[] | null } | { ok: false } {
  if (raw === undefined) return { ok: true, scopes: null };
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false };
  if (!raw.every(isApiTokenScope)) return { ok: false };
  const set = new Set(raw);
  return { ok: true, scopes: [...set].sort() as ApiTokenScope[] };
}

/** The request's token scopes, or null when unrestricted (or not a token). */
export function tokenScopes(c: Context<{ Variables: AppVariables }>): readonly ApiTokenScope[] | null {
  return c.get('tokenScopes') ?? null;
}

/**
 * Enforces token scopes. Requests without scopes (browser sessions, mock
 * auth, unrestricted tokens, public paths) pass through untouched. A scoped
 * token may only call routes in ROUTE_SCOPES whose scope it holds; everything
 * else is 403 `insufficient_scope` — default deny.
 */
export const scopeMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const scopes = tokenScopes(c);
  if (scopes === null) return next();

  const route = findScopedRoute(c.req.method, c.req.path);
  if (route && (route.scope === null || scopes.includes(route.scope))) return next();

  return c.json(
    {
      error: 'insufficient_scope',
      message: route?.scope
        ? `This API token lacks the "${route.scope}" scope.`
        : 'This API token cannot call this endpoint.',
    },
    403,
  );
};
