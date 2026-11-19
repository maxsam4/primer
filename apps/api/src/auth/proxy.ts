import { createPublicKey, type KeyObject } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';
import type { UserResolver } from './resolver.ts';

/**
 * AUTH_MODE=proxy: a reverse proxy in front of Primer authenticates people
 * however it likes and forwards a short-lived signed JWT naming them. Primer
 * only verifies that token (signature, issuer, audience, expiry); it never
 * trusts a bare "X-Forwarded-User" style header.
 *
 * Claims: `sub` (required; the Primer user id is `proxy:<sub>`), `email` and `name`
 * (optional; default to `<sub>@proxy.invalid` and `sub`).
 */
export interface ProxyAuthOptions {
  /** Request header carrying the JWT, e.g. `x-identity`. */
  header: string;
  /** Static verification key (PEM, SPKI). Ed25519, RSA and EC are supported. */
  publicKeyPem?: string;
  /** Alternative to `publicKeyPem`: a JWKS endpoint, fetched and cached. */
  jwksUrl?: string;
  issuer: string;
  audience: string;
  /** Allowed clock difference in seconds (default 30). */
  clockToleranceSec?: number;
}

const JWKS_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

function algorithmsFor(key: KeyObject): string[] {
  switch (key.asymmetricKeyType) {
    case 'ed25519':
    case 'ed448':
      return ['EdDSA'];
    case 'rsa':
    case 'rsa-pss':
      return ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'];
    case 'ec':
      return ['ES256', 'ES384', 'ES512'];
    default:
      throw new Error(`PROXY_AUTH_PUBLIC_KEY: unsupported key type ${String(key.asymmetricKeyType)}`);
  }
}

/** Primer user ids for proxy identities are `proxy:<sub>`. */
export const PROXY_USER_PREFIX = 'proxy:';

/** Verifies the identity JWT and returns its `sub`/`email`/`name`, or null. */
export function makeProxyVerifier(opts: ProxyAuthOptions) {
  let key: KeyObject | JWTVerifyGetKey;
  let algorithms: string[];
  if (opts.publicKeyPem) {
    const k = createPublicKey(opts.publicKeyPem);
    key = k;
    algorithms = algorithmsFor(k);
  } else if (opts.jwksUrl) {
    key = createRemoteJWKSet(new URL(opts.jwksUrl));
    algorithms = JWKS_ALGS;
  } else {
    throw new Error('proxy auth needs PROXY_AUTH_PUBLIC_KEY or PROXY_AUTH_JWKS_URL');
  }
  return async (token: string): Promise<{ sub: string; email: string; name: string } | null> => {
    try {
      const { payload } = await jwtVerify(token, key as KeyObject, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms,
        clockTolerance: opts.clockToleranceSec ?? 30,
        requiredClaims: ['sub', 'exp'],
      });
      const sub = payload.sub;
      if (!sub) return null;
      const email = typeof payload.email === 'string' && payload.email ? payload.email : `${sub}@proxy.invalid`;
      const name = typeof payload.name === 'string' && payload.name ? payload.name : sub;
      return { sub, email, name };
    } catch (err) {
      logger.warn({ reason: (err as Error).message }, 'proxy auth: identity token rejected');
      return null;
    }
  };
}

/**
 * Resolver for AUTH_MODE=proxy. Upserts the user (same shape as the OIDC
 * callback) the first time a given identity is seen, and again when its
 * email or name changes. `authMethod` is 'cookie' so browser requests keep
 * CSRF protection; PAT/OAuth bearer resolvers run before this one.
 */
export function makeProxyResolver(opts: ProxyAuthOptions): UserResolver {
  const verify = makeProxyVerifier(opts);
  const header = opts.header.toLowerCase();
  const seen = new Map<string, string>();
  return async (c) => {
    const token = c.req.header(header)?.trim();
    if (!token) return null;
    const claims = await verify(token);
    if (!claims) return null;
    // Namespaced so a token can never name (and overwrite) a seeded service
    // user or a user created by another auth mode.
    const id = `${PROXY_USER_PREFIX}${claims.sub}`;
    const fingerprint = `${claims.email}\0${claims.name}`;
    if (seen.get(id) !== fingerprint) {
      await db.execute(sql`
        INSERT INTO users (id, email, display_name)
        VALUES (${id}, ${claims.email}, ${claims.name})
        ON CONFLICT (id)
        DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
      `);
      seen.set(id, fingerprint);
    }
    c.set('authMethod', 'cookie');
    return { id, email: claims.email, displayName: claims.name };
  };
}

/** The page browsers get when the proxy sent no (or an invalid) identity token. */
export function proxyUnauthorizedPage(c: Context): Response {
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in required</title>` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}</style></head>` +
      `<body><h1>Sign-in required</h1>` +
      `<p>Primer did not receive a valid identity from the sign-in proxy in front of it. ` +
      `Open Primer through that proxy, sign in there, and try again.</p></body></html>`,
    401,
  );
}
