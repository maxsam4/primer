import type { Hono } from 'hono';
import type { AppDeps, AppVariables } from '../app.ts';
import { serializeCookie, parseCookie } from '../auth/cookies.ts';
import { makeDisabledOktaAdapter, type OktaAdapter } from '../auth/okta.ts';
import { logger } from '../logger.ts';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { proxyUnauthorizedPage } from '../auth/proxy.ts';
import { createSession, deleteSession } from '../auth/session.ts';

const STATE_COOKIE_MAX_AGE_SEC = 10 * 60;            // 10 minutes
const DEFAULT_SESSION_COOKIE = 'primer_sid';
const DEFAULT_STATE_COOKIE = 'primer_auth_state';

interface StateCookiePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

function encodeState(p: StateCookiePayload): string {
  return Buffer.from(JSON.stringify(p), 'utf-8').toString('base64url');
}

function decodeState(raw: string): StateCookiePayload | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as Partial<StateCookiePayload>;
    if (
      typeof parsed.state === 'string' &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.codeVerifier === 'string' &&
      typeof parsed.returnTo === 'string'
    ) {
      return parsed as StateCookiePayload;
    }
    return null;
  } catch {
    return null;
  }
}

// Only same-origin relative paths are accepted: a leading single `/`, no
// backslashes or control characters (browsers treat `/\evil.com` like
// `//evil.com`), and the parsed URL must stay on our origin.
export function sanitizeReturnTo(input: string | undefined): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(input)) return '/';
  try {
    const base = 'http://primer.invalid';
    const url = new URL(input, base);
    if (url.origin !== base) return '/';
    const out = `${url.pathname}${url.search}${url.hash}`;
    // Normalization can turn `/.//evil.com` into a protocol-relative `//evil.com`.
    if (out.startsWith('//') || out.startsWith('/\\')) return '/';
    return out;
  } catch {
    return '/';
  }
}

function cookieOpts(maxAge: number, secure: boolean) {
  return { maxAge, httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
}

export function registerAuthRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  const adapter: OktaAdapter = deps.oktaAdapter ?? makeDisabledOktaAdapter();
  const sessionCookieName = deps.authCookieName ?? DEFAULT_SESSION_COOKIE;
  const stateCookieName = deps.authStateCookieName ?? DEFAULT_STATE_COOKIE;
  // Secure flag: prefer explicit COOKIE_SECURE, else derive from AUTH_BASE_URL.
  // Decoupled from NODE_ENV so an HTTPS deploy that forgets to set NODE_ENV
  // doesn't silently drop the Secure flag.
  const secure =
    process.env.COOKIE_SECURE === 'true' ||
    (process.env.AUTH_BASE_URL ?? '').startsWith('https://');

  app.get('/auth/login', async (c) => {
    if (deps.proxyAuth) {
      // Identity comes from the proxy on every request; there is nothing to
      // sign in to here. Signed in already -> carry on; otherwise explain.
      const user = deps.userResolver ? await deps.userResolver(c) : null;
      if (user) return c.redirect(sanitizeReturnTo(c.req.query('return_to')), 302);
      return proxyUnauthorizedPage(c);
    }
    try {
      const { url, state, nonce, codeVerifier } = await adapter.buildAuthorizationUrl();
      const returnTo = sanitizeReturnTo(c.req.query('return_to'));
      const payload = encodeState({ state, nonce, codeVerifier, returnTo });
      const cookie = serializeCookie(stateCookieName, payload, cookieOpts(STATE_COOKIE_MAX_AGE_SEC, secure));
      c.header('set-cookie', cookie);
      return c.redirect(url, 302);
    } catch (err) {
      logger.error({ err }, '/auth/login failed');
      return c.json({ error: 'oidc_unavailable', message: (err as Error).message }, 503);
    }
  });

  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    const receivedState = c.req.query('state');
    const cookieHeader = c.req.header('cookie') ?? null;
    const rawState = parseCookie(cookieHeader, stateCookieName);
    if (!code || !receivedState || !rawState) {
      return c.json({ error: 'invalid_state', message: 'Missing state' }, 400);
    }
    const stored = decodeState(rawState);
    if (!stored) {
      return c.json({ error: 'invalid_state', message: 'Malformed state cookie' }, 400);
    }
    if (stored.state !== receivedState) {
      return c.json({ error: 'invalid_state', message: 'State mismatch' }, 400);
    }

    let claims;
    try {
      claims = await adapter.exchangeCode({
        code,
        state: stored.state,
        nonce: stored.nonce,
        codeVerifier: stored.codeVerifier,
        receivedState,
      });
    } catch (err) {
      logger.error({ err }, '/auth/callback exchange failed');
      return c.json({ error: 'oidc_failure', message: (err as Error).message }, 400);
    }

    // Upsert user
    await db.execute(sql`
      INSERT INTO users (id, email, display_name)
      VALUES (${claims.sub}, ${claims.email}, ${claims.name})
      ON CONFLICT (id)
      DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
    `);

    const userAgent = c.req.header('user-agent') ?? null;
    const { id: sid, expiresAt } = await createSession({ userId: claims.sub, userAgent });

    const maxAgeSec = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    const sessionCookie = serializeCookie(sessionCookieName, sid, cookieOpts(maxAgeSec, secure));
    const clearStateCookie = serializeCookie(stateCookieName, '', cookieOpts(0, secure));
    // Hono accepts multiple Set-Cookie headers via append.
    c.header('set-cookie', sessionCookie, { append: true });
    c.header('set-cookie', clearStateCookie, { append: true });
    return c.redirect(stored.returnTo || '/', 302);
  });

  app.post('/auth/logout', async (c) => {
    const cookieHeader = c.req.header('cookie') ?? null;
    const sid = parseCookie(cookieHeader, sessionCookieName);
    if (sid) {
      await deleteSession(sid);
    }
    const clearCookie = serializeCookie(sessionCookieName, '', cookieOpts(0, secure));
    c.header('set-cookie', clearCookie);
    return c.body(null, 204);
  });
}

export { decodeState };
export type { StateCookiePayload };
