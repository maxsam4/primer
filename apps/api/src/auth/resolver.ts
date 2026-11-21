import type { Context } from 'hono';
import type { AppVariables } from '../app.ts';
import { parseCookie } from './cookies.ts';
import { lookupSession, refreshSessionIfStale } from './session.ts';

export type ResolvedUser = AppVariables['user'];

export type UserResolver = (
  c: Context<{ Variables: AppVariables }>
) => Promise<ResolvedUser | null>;

export const MOCK_USER: ResolvedUser = {
  id: 'mock-user-1',
  email: 'mock@polygon.technology',
  displayName: 'Mock User',
  kind: 'person',
  viaUserId: null,
};

/** The dev personas available under AUTH_MODE=mock. Each must have a seeded
 *  `users` row (drizzle/0001, 0013) or foreign keys on authored content
 *  fail. The second persona exists so two browsers can hold sessions as
 *  DIFFERENT collaborators at once — required to exercise the live
 *  multi-party events relay (issue #78) locally. */
export const MOCK_USERS: ResolvedUser[] = [
  MOCK_USER,
  {
    id: 'mock-user-2',
    email: 'mock-reviewer@polygon.technology',
    displayName: 'Mock Reviewer',
    kind: 'person',
    viaUserId: null,
  },
];

/** Cookie set by GET /auth/mock (dev-only route) naming the chosen persona.
 *  Read ONLY by mockResolver — under AUTH_MODE=okta neither the route nor
 *  this resolver exists in the chain, so the cookie is inert. */
export const MOCK_USER_COOKIE = 'primer_mock_user';

/** AUTH_MODE=mock resolver: authenticates every request as a mock persona.
 *  Which persona is selected per BROWSER via the `primer_mock_user` cookie
 *  (set by /auth/mock), defaulting to MOCK_USER — so two browser contexts
 *  can be two different collaborators simultaneously. An unknown cookie
 *  value falls back to the default rather than failing: the cookie is a
 *  dev convenience, never an authorization input. */
export const mockResolver: UserResolver = async (c) => {
  c.set('authMethod', 'mock');
  const chosen = parseCookie(c.req.header('cookie') ?? null, MOCK_USER_COOKIE);
  if (chosen) {
    const match = MOCK_USERS.find((u) => u.id === chosen);
    if (match) return match;
  }
  return MOCK_USER;
};

/** Reads `X-Mock-User-Id` from the request. Falls back to MOCK_USER's id when absent. */
export const mockMultiResolver: UserResolver = async (c) => {
  const headerId = c.req.header('x-mock-user-id');
  const id = headerId && headerId.trim().length > 0 ? headerId : MOCK_USER.id;
  c.set('authMethod', 'mock');
  // The middleware needs the FULL user (email + displayName). For tests we
  // don't read these from the DB — they're synthesized from the id.
  if (id === MOCK_USER.id) return MOCK_USER;
  return { id, email: `${id}@polygon.technology`, displayName: id, kind: 'person', viaUserId: null };
};

export interface OktaResolverOptions {
  cookieName: string;
}

export function makeOktaResolver(opts: OktaResolverOptions): UserResolver {
  return async (c) => {
    const sid = parseCookie(c.req.header('cookie') ?? null, opts.cookieName);
    if (!sid) return null;
    const found = await lookupSession(sid);
    if (!found) return null;
    // Sliding refresh — fire and forget; refresh failures don't break the request.
    // Not for a recheck of an open connection (auth/revocation.ts): that only validates.
    if (!(c.get as (key: string) => unknown)('validateOnly')) void refreshSessionIfStale(sid).catch(() => undefined);
    c.set('authMethod', 'cookie');
    return found.user;
  };
}
