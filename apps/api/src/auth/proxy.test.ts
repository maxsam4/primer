import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { db } from '../db/client.ts';
import { SERVICE_USER_ID } from './admin.ts';
import { sanitizeReturnTo } from '../routes/auth.ts';
import { apiTokens, users } from '../db/schema.ts';
import { composeResolvers, makeBearerResolver } from './bearer.ts';
import { makeProxyResolver } from './proxy.ts';
import { generateToken } from './tokens.ts';

const ISSUER = 'https://sso.example.com';
const AUDIENCE = 'primer';
const HEADER = 'x-identity';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function sign(
  claims: Record<string, unknown>,
  o: { key?: typeof privateKey; aud?: string; iss?: string; exp?: string | number } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '5m')
    .sign(o.key ?? privateKey);
}

function makeApp() {
  return createApp({
    storage: new FilesystemStorage('/tmp/primer-proxy-test'),
    notifier: new NoopNotifier(),
    proxyAuth: true,
    userResolver: composeResolvers(
      makeBearerResolver(),
      makeProxyResolver({ header: HEADER, publicKeyPem, issuer: ISSUER, audience: AUDIENCE }),
    ),
  });
}

describe('AUTH_MODE=proxy', () => {
  it('a valid identity token signs the person in and upserts the user', async () => {
    const token = await sign({ sub: 'person-1', email: 'ada@example.com', name: 'Ada' });
    const res = await makeApp().request('/api/me', { headers: { [HEADER]: token } });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.id, 'proxy:person-1'));
    expect(row).toMatchObject({ email: 'ada@example.com', displayName: 'Ada' });
  });

  it('a sub equal to the service user id is a distinct proxy user and leaves the service user untouched', async () => {
    await db.insert(users).values({ id: SERVICE_USER_ID, email: 'svc@example.com', displayName: 'Service' });
    const token = await sign({ sub: SERVICE_USER_ID, email: 'evil@example.com', name: 'Evil' });
    const res = await makeApp().request('/api/me', { headers: { [HEADER]: token } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(`proxy:${SERVICE_USER_ID}`);
    const [svc] = await db.select().from(users).where(eq(users.id, SERVICE_USER_ID));
    expect(svc).toMatchObject({ email: 'svc@example.com', displayName: 'Service' });
  });

  it('/auth/login return_to only follows same-origin paths', async () => {
    for (const bad of ['/\\evil.com', '//evil.com', 'javascript:alert(1)', 'https://evil.com', '/.//evil.com', '/%2e//evil.com']) {
      expect(sanitizeReturnTo(bad)).toBe('/');
    }
    expect(sanitizeReturnTo('/d/1?x=2#c')).toBe('/d/1?x=2#c');
    const token = await sign({ sub: 'person-3' });
    const res = await makeApp().request('/auth/login?return_to=' + encodeURIComponent('/\\evil.com'), {
      headers: { [HEADER]: token },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('rejects a wrong audience, wrong issuer, expired token and bad signature', async () => {
    const app = makeApp();
    const bad = [
      await sign({ sub: 'p' }, { aud: 'someone-else' }),
      await sign({ sub: 'p' }, { iss: 'https://evil.example.com' }),
      await sign({ sub: 'p' }, { exp: Math.floor(Date.now() / 1000) - 600 }),
      await sign({ sub: 'p' }, { key: other.privateKey }),
    ];
    for (const token of bad) {
      const res = await app.request('/api/me', { headers: { [HEADER]: token } });
      expect(res.status).toBe(401);
    }
  });

  it('no header: API gets 401 JSON, browsers get a 401 page (no Okta redirect)', async () => {
    const app = makeApp();
    expect((await app.request('/api/me')).status).toBe(401);
    const page = await app.request('/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('Sign-in required');
    expect((await app.request('/auth/login')).status).toBe(401);
  });

  it('keeps CSRF protection for browser requests but not for bearer tokens', async () => {
    const app = makeApp();
    const token = await sign({ sub: 'person-2' });
    const noCsrf = await app.request('/auth/logout', { method: 'POST', headers: { [HEADER]: token } });
    expect(noCsrf.status).toBe(403);
    const withCsrf = await app.request('/auth/logout', {
      method: 'POST',
      headers: { [HEADER]: token, 'x-primer-csrf': '1' },
    });
    expect(withCsrf.status).toBe(204);
  });

  it('primer_pat_ service tokens still work without an identity header', async () => {
    await db.insert(users).values({ id: 'svc-1', email: 'svc@example.com', displayName: 'Svc' });
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({ id: randomUUID(), userId: 'svc-1', tokenHash, tokenPrefix, name: 't' });
    const res = await makeApp().request('/api/me', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('svc-1');
    await db.delete(apiTokens).where(eq(apiTokens.userId, 'svc-1'));
  });
});
