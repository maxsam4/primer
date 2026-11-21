import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { ApiTokenScope } from '@polygonlabs/primer-api-types';
import type { AppVariables, AuthUser } from '../app.ts';
import type { UserResolver } from './resolver.ts';
import { logger } from '../logger.ts';

// Long-lived connections (live-sync sockets, event streams) authenticate once
// and then stay open. Everything here keeps them honest: they can re-resolve
// their credentials, and every handler that removes credentials or access
// rechecks the affected ones at once.

/** Who opened a connection, resolved from its request headers. */
export type ResolvedAuth = {
  user: AuthUser;
  authMethod: 'bearer' | 'cookie' | 'mock';
  scopes?: readonly ApiTokenScope[];
  /** sha-256 hex of the bearer token (how PATs and OAuth access tokens are
   *  stored), so revoking that token finds this connection. */
  credentialHash?: string;
};

/**
 * Runs Primer's resolver chain (OAuth, PAT, session or mock, and the proxy
 * resolver when configured) against request headers, through a minimal stand-in
 * for the Hono context the resolvers read (`req.header`) and write
 * (`set('authMethod' | 'tokenScopes')`).
 */
export async function resolveFromHeaders(
  resolver: UserResolver,
  headers: Headers,
  /** A recheck only validates: it must not slide the session's expiry, or an
   *  idle open socket would keep a session alive forever. */
  opts: { validateOnly?: boolean } = {},
): Promise<ResolvedAuth | null> {
  const vars = new Map<string, unknown>();
  if (opts.validateOnly) vars.set('validateOnly', true);
  const shim = {
    req: { header: (name: string) => headers.get(name) ?? undefined },
    set: (key: string, value: unknown) => void vars.set(key, value),
    get: (key: string) => vars.get(key),
  } as unknown as Context<{ Variables: AppVariables }>;
  const user = await resolver(shim);
  if (!user) return null;
  const authMethod = (vars.get('authMethod') as ResolvedAuth['authMethod'] | undefined) ?? 'cookie';
  const auth: ResolvedAuth = { user, authMethod };
  const scopes = vars.get('tokenScopes') as readonly ApiTokenScope[] | undefined;
  if (scopes) auth.scopes = scopes;
  const bearer = headers.get('authorization');
  if (authMethod === 'bearer' && bearer?.startsWith('Bearer ')) {
    auth.credentialHash = createHash('sha256').update(bearer.slice('Bearer '.length).trim(), 'utf8').digest('hex');
  }
  return auth;
}

/** Which open connections to recheck: those on a document, those of a user,
 *  or those opened with one bearer credential (its sha-256 hex). */
export type AccessMatch = { documentId: string } | { userId: string } | { credentialHash: string };

/** What a watched connection is keyed by. */
export type AccessKey = { userId: string; credentialHash?: string; documentId?: string };

const watchers = new Set<{ key: AccessKey; recheck: () => void }>();
const matchers = new Set<(match: AccessMatch) => Promise<void>>();

/** Registers one open connection (an event stream). `recheck` re-resolves its
 *  credentials and re-authorises it, closing it when either fails. */
export function watchAccess(key: AccessKey, recheck: () => void): () => void {
  const entry = { key, recheck };
  watchers.add(entry);
  return () => void watchers.delete(entry);
}

/** Registers a component that rechecks its own connections by match (the
 *  live-sync hub, which indexes its sockets itself). */
export function onAccessRecheck(fn: (match: AccessMatch) => Promise<void>): () => void {
  matchers.add(fn);
  return () => void matchers.delete(fn);
}

function matches(key: AccessKey, match: AccessMatch): boolean {
  if ('documentId' in match) return key.documentId === match.documentId;
  if ('userId' in match) return key.userId === match.userId;
  return key.credentialHash === match.credentialHash;
}

/**
 * Called by every handler that removes credentials or access: token and
 * agent-token revocation, OAuth revocation, logout, collaborator removal or
 * role change, visibility change, deletion. Matching connections recheck at
 * once; those that lost access close. Never throws: the change it follows has
 * already been made.
 */
export async function recheckAccess(match: AccessMatch): Promise<void> {
  for (const watcher of watchers) if (matches(watcher.key, match)) watcher.recheck();
  try {
    await Promise.all([...matchers].map((fn) => fn(match)));
  } catch (err) {
    logger.warn({ error: String(err) }, 'recheck after an access change failed');
  }
}

/** What a connection was opened with: its user, how it authenticated and (for
 *  bearer) which token. A recheck must resolve to the same credential, or a
 *  revoked token would fall through to a cookie on the same request. */
export type OpenedWith = Pick<ResolvedAuth, 'authMethod' | 'credentialHash'> & { userId: string };

/** The recheck of `opened` against `headers`: the fresh resolution when it is
 *  still the same user and credential (not revoked, expired or signed out),
 *  else null. Validation only: never slides the session. */
export async function resolveAgain(resolver: UserResolver, headers: Headers, opened: OpenedWith): Promise<ResolvedAuth | null> {
  const again = await resolveFromHeaders(resolver, headers, { validateOnly: true });
  const same =
    again !== null &&
    again.user.id === opened.userId &&
    again.authMethod === opened.authMethod &&
    again.credentialHash === opened.credentialHash;
  return same ? again : null;
}

/** True while `headers` still resolve to the credential `opened` was made with. */
export async function stillResolves(resolver: UserResolver, headers: Headers, opened: OpenedWith): Promise<boolean> {
  return (await resolveAgain(resolver, headers, opened)) !== null;
}
