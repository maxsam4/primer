import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { composeResolvers } from '../auth/bearer.ts';
import { makeOAuthBearerResolver } from '../auth/oauth/bearer.ts';
import { db } from '../db/client.ts';
import { oauthAccessTokens, oauthClients, users } from '../db/schema.ts';
import { createClient } from '../auth/oauth/clients.ts';
import { generateAccessToken } from '../auth/oauth/tokens.ts';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-mcp-transport-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: composeResolvers(makeOAuthBearerResolver()),
      authBaseUrl: 'http://localhost:5173',
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedAccessToken(): Promise<{ token: string; userId: string }> {
  const userId = `mcp-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id: userId, email: `${userId}@x.test`, displayName: userId });
  const client = await createClient({
    clientName: 'test',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    grantTypes: ['authorization_code'],
  });
  const { token, tokenHash } = generateAccessToken();
  await db.insert(oauthAccessTokens).values({
    id: uuidv7(),
    tokenHash,
    userId,
    clientId: client.clientId,
    scopes: ['primer'],
    expiresAt: new Date(Date.now() + 3600 * 1000),
  });
  return { token, userId };
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthClients);
});

describe('GET /mcp', () => {
  it('answers 405 so a client opens no event stream', async () => {
    const { token } = await seedAccessToken();
    await withApp(async (app) => {
      const res = await app.request('/mcp', {
        method: 'GET',
        headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    });
  });
});

describe('POST /mcp', () => {
  it('returns 401 with WWW-Authenticate when no bearer is present', async () => {
    await withApp(async (app) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get('www-authenticate') ?? '';
      expect(wwwAuth).toMatch(/^Bearer/);
      expect(wwwAuth).toContain('resource_metadata=');
    });
  });

  it('lists the registered tools for an authenticated request', async () => {
    const { token } = await seedAccessToken();
    await withApp(async (app) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const expected = [
        'primer_whoami',
        'primer_get_document',
        'primer_list_versions',
        'primer_get_comments',
        'primer_create_document',
        'primer_add_version',
        'primer_resolve_url',
        'primer_list_documents',
        'primer_find_document',
        'primer_get_document_comments',
        'primer_get_all_comments',
      ];
      for (const name of expected) {
        expect(text).toContain(name);
      }
    });
  });

  it('MCP exposes the authoring resource and instructions', async () => {
    const { token } = await seedAccessToken();
    await withApp(async (app) => {
      const call = async (method: string, params: Record<string, unknown> = {}) => {
        const res = await app.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        expect(res.status).toBe(200);
        return res.text();
      };

      const init = await call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      });
      expect(init).toContain('primer://skills/authoring');
      expect(init).toContain('untrusted data');

      expect(await call('resources/list')).toContain('primer://skills/authoring');
      const read = await call('resources/read', { uri: 'primer://skills/authoring' });
      expect(read).toContain('Authoring live Primer documents');
      expect(read).toContain('expectVersion');
    });
  });
});
