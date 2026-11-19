import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { composeResolvers, makeBearerResolver } from './bearer.ts';
import { mockMultiResolver } from './resolver.ts';
import { PUBLIC_PATHS } from '../middleware/auth.ts';
import { db } from '../db/client.ts';
import { apiTokens, users } from '../db/schema.ts';
import { asUser, asUserJson } from '../test/harness.ts';
import { NOT_GRANTABLE, ROUTE_SCOPES, findScopedRoute, parseRequestedScopes } from './scopes.ts';
import { TOOL_NAMES, toolsForScopes } from '../mcp/tools.ts';
import type { ApiTokenScope, CreateTokenResponse } from '@polygonlabs/primer-api-types';

const ADMIN_ID = 'admin-user';
const ADMIN_EMAIL = `${ADMIN_ID}@polygon.technology`;
const HUMAN_ID = 'human-1';
/** An agent acting via ADMIN_ID. */
const AGENT_ID = 'agent_scopes-test';

type App = ReturnType<typeof createApp>;

async function withApp<T>(fn: (app: App) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-scopes-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver),
      // authBaseUrl doubles as the OAuth issuer, which gates /mcp registration.
      authBaseUrl: 'http://localhost:5173',
      adminEmails: [ADMIN_EMAIL],
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mintAgentToken(app: App, scopes: ApiTokenScope[]): Promise<CreateTokenResponse> {
  const res = await app.request(`/api/agents/${AGENT_ID}/tokens`, {
    method: 'POST',
    headers: asUserJson(ADMIN_ID),
    body: JSON.stringify({ name: 'scoped', scopes }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateTokenResponse;
}

/** Personal tokens may still be unrestricted (scopes omitted). */
async function mintUnrestrictedToken(app: App): Promise<CreateTokenResponse> {
  const res = await app.request('/api/tokens', {
    method: 'POST',
    headers: asUserJson(ADMIN_ID),
    body: JSON.stringify({ name: 'unrestricted' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateTokenResponse;
}

function bearer(token: string, json = true): Record<string, string> {
  return json
    ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    : { authorization: `Bearer ${token}` };
}

async function upload(app: App, token: string): Promise<{ status: number; documentId?: string }> {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><p>hi</p></body></html>'], { type: 'text/html' }), 'a.html');
  fd.append('title', 'Scoped upload');
  const res = await app.request('/api/upload', { method: 'POST', headers: bearer(token, false), body: fd });
  if (!res.ok) return { status: res.status };
  return { status: res.status, documentId: ((await res.json()) as { documentId: string }).documentId };
}

async function mcpToolsList(app: App, token: string): Promise<string[]> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { ...bearer(token), accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(200);
  const dataLine = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).pop()!;
  const rpc = JSON.parse(dataLine.slice('data: '.length)) as { result: { tools: { name: string }[] } };
  return rpc.result.tools.map((t) => t.name).sort();
}

beforeEach(async () => {
  await db.delete(apiTokens);
  await db
    .insert(users)
    .values([
      { id: ADMIN_ID, email: ADMIN_EMAIL, displayName: ADMIN_ID },
      { id: HUMAN_ID, email: `${HUMAN_ID}@polygon.technology`, displayName: 'Human' },
    ])
    .onConflictDoNothing();
  await db
    .insert(users)
    .values({ id: AGENT_ID, email: 'agent@agents.primer.invalid', displayName: 'Claude', kind: 'agent', viaUserId: ADMIN_ID })
    .onConflictDoNothing();
});

describe('route scope table', () => {
  // Routes a bearer never reaches through the scope check: the auth
  // middleware skips them, or they are dev/mock-only.
  function isPublicOrDev(path: string): boolean {
    return (
      PUBLIC_PATHS.has(path) ||
      path.startsWith('/api/share/') ||
      path.startsWith('/share/') ||
      path.startsWith('/.well-known/') ||
      path.startsWith('/companion/') ||
      path.startsWith('/dev/') ||
      path === '/api/health' ||
      path === '/auth/mock'
    );
  }

  it('classifies every registered route as scoped or deliberately not grantable', async () => {
    await withApp(async (app) => {
      const registered = app.routes
        .filter((r) => r.method !== 'ALL')
        .filter((r) => !isPublicOrDev(r.path))
        .map((r) => `${r.method} ${r.path}`);
      const classified = new Set([
        ...ROUTE_SCOPES.map((r) => `${r.method} ${r.path}`),
        ...NOT_GRANTABLE.map((r) => `${r.method} ${r.path}`),
      ]);

      const unclassified = registered.filter((r) => !classified.has(r));
      expect(unclassified).toEqual([]);

      // And no table entry is stale (typo or removed route).
      const registeredSet = new Set(registered);
      const upcoming = new Set(ROUTE_SCOPES.filter((r) => r.upcoming).map((r) => `${r.method} ${r.path}`));
      const stale = [...classified].filter((r) => !registeredSet.has(r) && !upcoming.has(r));
      expect(stale).toEqual([]);
    });
  });

  it('matches concrete paths to their pattern, exactly', () => {
    expect(findScopedRoute('GET', '/api/users/lookup')?.scope).toBe('users:read');
    expect(findScopedRoute('GET', '/api/documents/abc/collaborators')?.scope).toBe('collaborators:manage');
    expect(findScopedRoute('HEAD', '/api/documents/abc')?.scope).toBe('documents:read');
    expect(findScopedRoute('DELETE', '/api/documents/abc')).toBeUndefined();
    expect(findScopedRoute('GET', '/api/documents/abc/collaborators/extra/segment')).toBeUndefined();
    expect(findScopedRoute('GET', '/api/documents/../tokens')).toBeUndefined();
  });

  it('gives every MCP tool the same scope as its REST equivalent', () => {
    expect(toolsForScopes(null)).toEqual([...TOOL_NAMES]);
    expect(toolsForScopes([])).toEqual(['primer_whoami']);
    expect(toolsForScopes(['documents:write'])).toEqual([
      'primer_whoami',
      'primer_create_document',
      'primer_add_version',
      'primer_apply_ops',
      'primer_update_run',
      'primer_withdraw_suggestion',
    ]);
  });
});

describe('parseRequestedScopes', () => {
  it('treats absent as unrestricted, and canonicalises a valid list', () => {
    expect(parseRequestedScopes(undefined)).toEqual({ ok: true, scopes: null });
    expect(parseRequestedScopes(['users:read', 'documents:read', 'users:read'])).toEqual({
      ok: true,
      scopes: ['documents:read', 'users:read'],
    });
  });

  it.each([[[]], [['bogus']], [['documents:read', 'tokens:write']], ['documents:read'], [null]])(
    'rejects %j',
    (raw) => {
      expect(parseRequestedScopes(raw)).toEqual({ ok: false });
    },
  );
});

describe('minting scoped tokens', () => {
  it('stores and returns scopes; rejects invalid ones with invalid_scopes', async () => {
    await withApp(async (app) => {
      const { summary } = await mintAgentToken(app, ['users:read', 'documents:read']);
      expect(summary.scopes).toEqual(['documents:read', 'users:read']);

      const unrestricted = await mintUnrestrictedToken(app);
      expect(unrestricted.summary.scopes).toBeNull();

      const unscopedService = await app.request(`/api/agents/${AGENT_ID}/tokens`, {
        method: 'POST',
        headers: asUserJson(ADMIN_ID),
        body: JSON.stringify({ name: 'no-scopes' }),
      });
      expect(unscopedService.status).toBe(400);
      expect(((await unscopedService.json()) as { error: string }).error).toBe('scopes_required');

      const list = await app.request('/api/agents', { headers: asUserJson(ADMIN_ID) });
      const { agents } = (await list.json()) as { agents: { id: string; tokens: { id: string; scopes: unknown }[] }[] };
      const tokens = agents.find((a) => a.id === AGENT_ID)!.tokens;
      expect(tokens.find((t) => t.id === summary.id)?.scopes).toEqual(['documents:read', 'users:read']);

      for (const path of [`/api/agents/${AGENT_ID}/tokens`, '/api/tokens']) {
        const bad = await app.request(path, {
          method: 'POST',
          headers: asUserJson(ADMIN_ID),
          body: JSON.stringify({ name: 'bad', scopes: ['admin'] }),
        });
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: string }).error).toBe('invalid_scopes');
      }
    });
  });
});

describe('enforcing scopes', () => {
  it('lets a scoped token do exactly what its scopes grant', async () => {
    await withApp(async (app) => {
      const { token } = await mintAgentToken(app, ['documents:write', 'collaborators:manage', 'users:read']);

      const up = await upload(app, token);
      expect(up.status).toBe(200);
      const docId = up.documentId!;

      const who = await app.request('/api/me', { headers: bearer(token) });
      expect(who.status).toBe(200);

      const lookup = await app.request(`/api/users/lookup?email=${HUMAN_ID}@polygon.technology`, {
        headers: bearer(token),
      });
      expect(lookup.status).toBe(200);

      const add = await app.request(`/api/documents/${docId}/collaborators`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ userId: HUMAN_ID, role: 'editor' }),
      });
      expect(add.status).toBe(201);

      const rename = await app.request(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: bearer(token),
        body: JSON.stringify({ title: 'Renamed' }),
      });
      expect(rename.status).toBe(200);

      const denied: [string, string, unknown?][] = [
        ['GET', `/api/documents/${docId}`], // lacks documents:read
        ['PATCH', `/api/documents/${docId}`, { visibility: 'org' }], // only narrowing is grantable
        ['DELETE', `/api/documents/${docId}`],
        ['POST', `/api/documents/${docId}/external-share`, {}],
        ['PUT', `/api/documents/${docId}/folder`, { folderId: null }],
        ['GET', '/api/tokens'],
        ['DELETE', '/api/tokens/00000000-0000-0000-0000-000000000000'],
        ['GET', '/api/device/pending?userCode=ABCD-EFGH'],
      ];
      for (const [method, path, body] of denied) {
        const res = await app.request(path, {
          method,
          headers: bearer(token),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
        expect(((await res.json()) as { error: string }).error).toBe('insufficient_scope');
      }
    });
  });

  it('leaves unrestricted tokens and browser sessions as they were', async () => {
    await withApp(async (app) => {
      const { token } = await mintUnrestrictedToken(app);
      const up = await upload(app, token);
      expect(up.status).toBe(200);
      const share = await app.request(`/api/documents/${up.documentId}/external-share`, {
        method: 'POST',
        headers: bearer(token),
        body: '{}',
      });
      expect(share.status).toBe(201);

      const tokens = await app.request('/api/tokens', { headers: asUserJson(ADMIN_ID) });
      expect(tokens.status).toBe(200);
    });
  });

  it('only registers the MCP tools a scoped token may use', async () => {
    await withApp(async (app) => {
      const readOnly = await mintAgentToken(app, ['documents:read']);
      const tools = await mcpToolsList(app, readOnly.token);
      expect(tools).toContain('primer_get_document');
      expect(tools).not.toContain('primer_create_document');
      expect(tools).not.toContain('primer_add_version');
      expect(tools).not.toContain('primer_send_events');

      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { ...bearer(readOnly.token), accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'primer_create_document', arguments: { title: 't', content: '<p>x</p>', format: 'html' } },
        }),
      });
      const text = await res.text();
      expect(text).not.toContain('documentId');

      const unrestricted = await mintUnrestrictedToken(app);
      expect(await mcpToolsList(app, unrestricted.token)).toEqual([...TOOL_NAMES].sort());
    });
  });
});

async function uploadAs(app: App, userId: string): Promise<string> {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><p>hi</p></body></html>'], { type: 'text/html' }), 'a.html');
  fd.append('title', 'Human upload');
  const res = await app.request('/api/upload', { method: 'POST', headers: asUser(userId), body: fd });
  expect(res.status).toBe(200);
  return ((await res.json()) as { documentId: string }).documentId;
}

async function addCollaborator(app: App, ownerId: string, docId: string, userId: string, role: string): Promise<void> {
  const res = await app.request(`/api/documents/${docId}/collaborators`, {
    method: 'POST',
    headers: asUserJson(ownerId),
    body: JSON.stringify({ userId, role }),
  });
  expect(res.status).toBe(201);
}

async function setVisibility(app: App, token: string, docId: string, visibility: string): Promise<Response> {
  return app.request(`/api/documents/${docId}`, {
    method: 'PATCH',
    headers: bearer(token),
    body: JSON.stringify({ visibility }),
  });
}

async function sendEvents(app: App, token: string, docId: string): Promise<Response> {
  return app.request(`/api/documents/${docId}/events`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ events: [{ namespace: 'padd', type: 'export', payload: {}, audience: 'artifact' }] }),
  });
}

/** Calls an MCP tool; returns the JSON-RPC result (or error) as text. */
async function mcpCall(app: App, token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { ...bearer(token), accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).pop()!;
}

describe('visibility with a scoped token', () => {
  it('may narrow a document it can manage to private, but never widen it to org', async () => {
    await withApp(async (app) => {
      const { token } = await mintAgentToken(app, ['documents:read', 'documents:write']);
      const docId = (await upload(app, token)).documentId!;

      const narrow = await setVisibility(app, token, docId, 'private');
      expect(narrow.status).toBe(200);
      expect(((await narrow.json()) as { visibility: string }).visibility).toBe('private');
      // An org member who isn't a collaborator can no longer see it.
      const asHuman = await app.request(`/api/documents/${docId}`, { headers: asUser(HUMAN_ID) });
      expect(asHuman.status).toBe(404);

      const widen = await setVisibility(app, token, docId, 'org');
      expect(widen.status).toBe(403);
      expect(((await widen.json()) as { error: string }).error).toBe('insufficient_scope');
      const after = await app.request(`/api/documents/${docId}`, { headers: bearer(token) });
      expect(((await after.json()) as { document: { visibility: string } }).document.visibility).toBe('private');
    });
  });

  it('still needs the user to manage the document', async () => {
    await withApp(async (app) => {
      const docId = await uploadAs(app, HUMAN_ID);
      await addCollaborator(app, HUMAN_ID, docId, AGENT_ID, 'editor');
      const { token } = await mintAgentToken(app, ['documents:write']);

      const res = await setVisibility(app, token, docId, 'private');
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('forbidden');
    });
  });
});

describe('a scope only narrows the document role', () => {
  it('denies events:write to a user who is only an org reader', async () => {
    await withApp(async (app) => {
      const docId = await uploadAs(app, HUMAN_ID);
      const { token } = await mintAgentToken(app, ['documents:read', 'events:write']);

      const rest = await sendEvents(app, token, docId);
      expect(rest.status).toBe(403);
      expect(((await rest.json()) as { error: string }).error).toBe('forbidden');

      const mcp = await mcpCall(app, token, 'primer_send_events', {
        documentId: docId,
        events: [{ namespace: 'padd', type: 'export', payload: {}, audience: 'artifact' }],
      });
      expect(mcp).toContain('forbidden');
      expect(mcp).not.toContain('"inserted"');
    });
  });

  it('denies an editor whose token lacks events:write', async () => {
    await withApp(async (app) => {
      const docId = await uploadAs(app, HUMAN_ID);
      await addCollaborator(app, HUMAN_ID, docId, AGENT_ID, 'editor');
      const { token } = await mintAgentToken(app, ['documents:read', 'documents:write']);

      const rest = await sendEvents(app, token, docId);
      expect(rest.status).toBe(403);
      expect(((await rest.json()) as { error: string }).error).toBe('insufficient_scope');

      expect(await mcpToolsList(app, token)).not.toContain('primer_send_events');

      // The same editor with the scope gets through: the role allowed it all along.
      const scoped = await mintAgentToken(app, ['events:write']);
      expect((await sendEvents(app, scoped.token, docId)).status).toBe(201);
    });
  });
});
