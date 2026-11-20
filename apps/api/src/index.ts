import './env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { parseAdminEmails } from './auth/admin.ts';
import { logger } from './logger.ts';
import { storageFromEnv } from './storage/fromEnv.ts';
import { notifierFromEnv } from './notifications/fromEnv.ts';
import { startPurgeInterval } from './jobs/purge.ts';
import { mockResolver, makeOktaResolver, type UserResolver } from './auth/resolver.ts';
import { OpenIdClientAdapter, makeDisabledOktaAdapter, type OktaAdapter } from './auth/okta.ts';
import { makeProxyResolver } from './auth/proxy.ts';
import { makeBearerResolver, composeResolvers } from './auth/bearer.ts';
import { makeOAuthBearerResolver } from './auth/oauth/bearer.ts';
import { createHub } from './live/hub.ts';
import { loadSigningKey } from './live/signing.ts';

const port = Number(process.env.PORT ?? 3000);
const { storage, description: storageDescription } = storageFromEnv();
await loadSigningKey(storage);
const notifier = notifierFromEnv();

const rawAuthMode = process.env.AUTH_MODE;
if (!rawAuthMode || !['mock', 'okta', 'proxy'].includes(rawAuthMode.toLowerCase())) {
  throw new Error(
    "AUTH_MODE must be explicitly set to 'mock', 'okta' or 'proxy'. " +
      "Refusing to start with an implicit default. " +
      'For local dev, set AUTH_MODE=mock in your .env file.',
  );
}
const authMode = rawAuthMode.toLowerCase();

if (authMode === 'mock' && process.env.NODE_ENV === 'production') {
  throw new Error(
    'AUTH_MODE=mock is not permitted when NODE_ENV=production. ' +
      'Set AUTH_MODE=okta (or proxy) and provide OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET, AUTH_BASE_URL.',
  );
}
if (authMode === 'mock') {
  logger.warn(
    'AUTH_MODE=mock — every request is authenticated as a mock persona (default mock-user-1; pick per browser at /auth/mock). Do not deploy this to any shared environment.',
  );
}

const sessionCookieName = process.env.SESSION_COOKIE_NAME ?? 'primer_sid';

let userResolver: UserResolver;
let oktaAdapter: OktaAdapter;

if (authMode === 'okta') {
  const issuer = process.env.OKTA_ISSUER;
  const clientId = process.env.OKTA_CLIENT_ID;
  const clientSecret = process.env.OKTA_CLIENT_SECRET;
  const authBaseUrl = process.env.AUTH_BASE_URL;
  if (!issuer || !clientId || !clientSecret || !authBaseUrl) {
    throw new Error(
      'AUTH_MODE=okta but one of OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET, AUTH_BASE_URL is missing.'
    );
  }
  userResolver = makeOktaResolver({ cookieName: sessionCookieName });
  oktaAdapter = new OpenIdClientAdapter({
    issuer,
    clientId,
    clientSecret,
    redirectUri: `${authBaseUrl.replace(/\/$/, '')}/auth/callback`,
    scope: 'openid profile email',
  });
} else if (authMode === 'proxy') {
  const header = process.env.PROXY_AUTH_HEADER;
  const publicKeyPem = process.env.PROXY_AUTH_PUBLIC_KEY;
  const jwksUrl = process.env.PROXY_AUTH_JWKS_URL;
  const proxyIssuer = process.env.PROXY_AUTH_ISSUER;
  const audience = process.env.PROXY_AUTH_AUDIENCE;
  if (!header || !proxyIssuer || !audience || (!publicKeyPem && !jwksUrl) || (publicKeyPem && jwksUrl)) {
    throw new Error(
      'AUTH_MODE=proxy needs PROXY_AUTH_HEADER, PROXY_AUTH_ISSUER, PROXY_AUTH_AUDIENCE and exactly one of ' +
        'PROXY_AUTH_PUBLIC_KEY (PEM) or PROXY_AUTH_JWKS_URL.',
    );
  }
  userResolver = makeProxyResolver({
    header,
    // Env files often carry PEMs on one line with literal \n.
    publicKeyPem: publicKeyPem?.replace(/\\n/g, '\n'),
    jwksUrl,
    issuer: proxyIssuer,
    audience,
  });
  oktaAdapter = makeDisabledOktaAdapter();
} else {
  userResolver = mockResolver;
  oktaAdapter = makeDisabledOktaAdapter();
}

// OAuth bearer runs first (primer_oat_ tokens), then PAT bearer (primer_pat_),
// then the session/mock resolver as fallback.
userResolver = composeResolvers(makeOAuthBearerResolver(), makeBearerResolver(), userResolver);

// Count only — never log the emails themselves. Zero admins means the
// admin endpoints are unreachable (fail closed).
const adminEmails = parseAdminEmails(process.env.ADMIN_EMAILS);
logger.info({ adminCount: adminEmails.length }, 'admin allowlist loaded');

// Live documents sync over WebSocket at /collab on this same server. Browser
// credentials are accepted only from the app's own origin.
const appOrigin = new URL(process.env.AUTH_BASE_URL ?? 'http://localhost:5173').origin;
const hub = createHub({ resolver: userResolver, appOrigin });

const app = createApp({
  storage,
  notifier,
  userResolver,
  oktaAdapter,
  proxyAuth: authMode === 'proxy',
  authCookieName: sessionCookieName,
  authBaseUrl: process.env.AUTH_BASE_URL,
  adminEmails,
});

const purgeIntervalMs = process.env.PURGE_INTERVAL_MS
  ? Number(process.env.PURGE_INTERVAL_MS)
  : undefined;
const stopPurge = startPurgeInterval({ storage, intervalMs: purgeIntervalMs });

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, storage: storageDescription, authMode }, 'primer api listening');
});
server.on('upgrade', hub.handleUpgrade);

const shutdown = async () => {
  await stopPurge();
  hub.close();
  if ('close' in server) {
    const http = server as { close: (cb?: () => void) => void; closeAllConnections?: () => void };
    http.close(() => process.exit(0));
    // Open event streams would otherwise hold the exit; browsers reconnect.
    http.closeAllConnections?.();
  } else {
    process.exit(0);
  }
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
