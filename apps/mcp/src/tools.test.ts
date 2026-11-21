import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { PrimerApiError, type PrimerClient } from './client.ts';
import * as deviceLogin from './deviceLogin.ts';
import { buildToolHandlers, type ToolDeps, type ToolResult } from './tools.ts';

// ─────────────────── Test helpers ───────────────────

interface FakeClient {
  whoami: ReturnType<typeof vi.fn>;
  getEvents: ReturnType<typeof vi.fn>;
  sendEvents: ReturnType<typeof vi.fn>;
  getDocument: ReturnType<typeof vi.fn>;
  listVersions: ReturnType<typeof vi.fn>;
  getVersionThreads: ReturnType<typeof vi.fn>;
  replyToThread: ReturnType<typeof vi.fn>;
  resolveThread: ReturnType<typeof vi.fn>;
  getVersionContent: ReturnType<typeof vi.fn>;
  createDocument: ReturnType<typeof vi.fn>;
  addVersion: ReturnType<typeof vi.fn>;
  revokeToken: ReturnType<typeof vi.fn>;
  lookupUser: ReturnType<typeof vi.fn>;
  addCollaborator: ReturnType<typeof vi.fn>;
  listCollaborators: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return {
    whoami: vi.fn(),
    getEvents: vi.fn(),
    sendEvents: vi.fn(),
    getDocument: vi.fn(),
    listVersions: vi.fn(),
    getVersionThreads: vi.fn(),
    replyToThread: vi.fn(),
    resolveThread: vi.fn(),
    getVersionContent: vi.fn(),
    createDocument: vi.fn(),
    addVersion: vi.fn(),
    revokeToken: vi.fn(),
    lookupUser: vi.fn(),
    addCollaborator: vi.fn(),
    listCollaborators: vi.fn(),
  };
}

interface FakeStore {
  saveToken: ReturnType<typeof vi.fn>;
  loadToken: ReturnType<typeof vi.fn>;
  clearToken: ReturnType<typeof vi.fn>;
  resolveToken: ReturnType<typeof vi.fn>;
}

function makeStore(opts?: { token?: string | undefined; entry?: { tokenId: string; token: string; prefix: string; savedAt: string } | null }): FakeStore {
  return {
    saveToken: vi.fn(async () => {}),
    loadToken: vi.fn(async () => opts?.entry ?? null),
    clearToken: vi.fn(async () => {}),
    resolveToken: vi.fn(async () => opts?.token),
  };
}

interface BuildDepsArgs {
  client?: FakeClient | null;
  store?: FakeStore;
  baseUrl?: string;
}

function buildDeps(args: BuildDepsArgs = {}): { deps: ToolDeps; client: FakeClient | null; store: FakeStore } {
  const client = args.client === undefined ? makeFakeClient() : args.client;
  const store = args.store ?? makeStore();
  const baseUrl = args.baseUrl ?? 'http://localhost:3000';
  const deps: ToolDeps = {
    baseUrl,
    store: store as unknown as ToolDeps['store'],
    clientBuilder: async () => (client === null ? null : (client as unknown as PrimerClient)),
  };
  return { deps, client, store };
}

function parseErrorPayload(result: ToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  expect(result.content[0]?.type).toBe('text');
  const text = (result.content[0] as { type: 'text'; text: string }).text;
  return JSON.parse(text) as { code: string; message: string };
}

function parseSuccessPayload<T = unknown>(result: ToolResult): T {
  expect(result.isError).toBeFalsy();
  expect(result.content[0]?.type).toBe('text');
  const text = (result.content[0] as { type: 'text'; text: string }).text;
  return JSON.parse(text) as T;
}

// ─────────────────── primer_login ───────────────────

describe('primer_login', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns deviceCode/userCode/verificationUri/expiresIn/interval and DROPS verificationUriComplete', async () => {
    const spy = vi.spyOn(deviceLogin, 'startDeviceLogin').mockResolvedValue({
      deviceCode: 'dev-abc',
      userCode: 'WXYZ-1234',
      verificationUri: 'http://localhost:3000/device',
      verificationUriComplete: 'http://localhost:3000/device?code=WXYZ-1234',
      expiresIn: 600,
      interval: 5,
    });

    const { deps } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_login({ clientLabel: 'custom-label' });

    const payload = parseSuccessPayload<Record<string, unknown>>(result);
    expect(payload).toEqual({
      deviceCode: 'dev-abc',
      userCode: 'WXYZ-1234',
      verificationUri: 'http://localhost:3000/device',
      expiresIn: 600,
      interval: 5,
    });
    expect(payload.verificationUriComplete).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ baseUrl: 'http://localhost:3000', clientLabel: 'custom-label' });
  });

  it('falls back to os.hostname() when clientLabel not provided', async () => {
    const spy = vi.spyOn(deviceLogin, 'startDeviceLogin').mockResolvedValue({
      deviceCode: 'd',
      userCode: 'U',
      verificationUri: 'v',
      verificationUriComplete: 'vc',
      expiresIn: 600,
      interval: 5,
    });

    const { deps } = buildDeps();
    const handlers = buildToolHandlers(deps);
    await handlers.primer_login({});

    expect(spy).toHaveBeenCalledWith({ baseUrl: 'http://localhost:3000', clientLabel: os.hostname() });
  });

  it('surfaces network failure as isError with code "network"', async () => {
    vi.spyOn(deviceLogin, 'startDeviceLogin').mockRejectedValue(
      new PrimerApiError('network', 'ECONNREFUSED'),
    );
    const { deps } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_login({});
    const err = parseErrorPayload(result);
    expect(err.code).toBe('network');
  });
});

// ─────────────────── primer_login_status ───────────────────

describe('primer_login_status', () => {
  afterEach(() => vi.restoreAllMocks());

  it('on approved: persists token via store.saveToken and returns tokenPrefix + expiresAt', async () => {
    vi.spyOn(deviceLogin, 'pollUntil').mockResolvedValue({
      status: 'approved',
      token: 'primer_pat_secret',
      tokenPrefix: 'primer_pat_AAAA',
      tokenId: 'tok-1',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });

    const { deps, store } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_login_status({ deviceCode: 'dev-abc' });

    expect(store.saveToken).toHaveBeenCalledTimes(1);
    expect(store.saveToken).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:3000',
      tokenId: 'tok-1',
      token: 'primer_pat_secret',
      prefix: 'primer_pat_AAAA',
    });
    const payload = parseSuccessPayload<{ status: string; tokenPrefix: string; expiresAt: string | null }>(result);
    expect(payload.status).toBe('approved');
    expect(payload.tokenPrefix).toBe('primer_pat_AAAA');
    expect(payload.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('on pending: returns { status: "pending" } without touching the store', async () => {
    vi.spyOn(deviceLogin, 'pollUntil').mockResolvedValue({ status: 'pending' });
    const { deps, store } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_login_status({ deviceCode: 'dev' });
    const payload = parseSuccessPayload<{ status: string }>(result);
    expect(payload.status).toBe('pending');
    expect(store.saveToken).not.toHaveBeenCalled();
  });

  it('on denied: passes through as { status: "denied" }', async () => {
    vi.spyOn(deviceLogin, 'pollUntil').mockResolvedValue({ status: 'denied' });
    const { deps } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_login_status({ deviceCode: 'dev' });
    const payload = parseSuccessPayload<{ status: string }>(result);
    expect(payload.status).toBe('denied');
  });

  it('on expired: passes through as { status: "expired" }', async () => {
    vi.spyOn(deviceLogin, 'pollUntil').mockResolvedValue({ status: 'expired' });
    const { deps } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_login_status({ deviceCode: 'dev' });
    const payload = parseSuccessPayload<{ status: string }>(result);
    expect(payload.status).toBe('expired');
  });

  it('surfaces network failure as isError with code "network"', async () => {
    vi.spyOn(deviceLogin, 'pollUntil').mockRejectedValue(
      new PrimerApiError('network', 'fetch failed'),
    );
    const { deps } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_login_status({ deviceCode: 'dev' });
    const err = parseErrorPayload(result);
    expect(err.code).toBe('network');
  });
});

// ─────────────────── primer_logout ───────────────────

describe('primer_logout', () => {
  it('with a stored entry: calls client.revokeToken(tokenId) then store.clearToken(baseUrl)', async () => {
    const client = makeFakeClient();
    client.revokeToken.mockResolvedValue(undefined);
    const store = makeStore({
      entry: { tokenId: 'tok-1', token: 'primer_pat_x', prefix: 'primer_pat_AAAA', savedAt: '2026-01-01T00:00:00.000Z' },
    });
    const { deps } = buildDeps({ client, store });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_logout({});
    const payload = parseSuccessPayload<{ ok: boolean }>(result);

    expect(payload.ok).toBe(true);
    expect(client.revokeToken).toHaveBeenCalledWith('tok-1');
    expect(store.clearToken).toHaveBeenCalledWith('http://localhost:3000');
  });

  it('without a stored entry: still returns ok and clears (idempotent)', async () => {
    const store = makeStore({ entry: null });
    const { deps, client } = buildDeps({ store });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_logout({});
    const payload = parseSuccessPayload<{ ok: boolean }>(result);

    expect(payload.ok).toBe(true);
    expect(client?.revokeToken).not.toHaveBeenCalled();
    expect(store.clearToken).toHaveBeenCalledWith('http://localhost:3000');
  });

  it('swallows 404 from revoke (already invalid) and still clears', async () => {
    const client = makeFakeClient();
    client.revokeToken.mockRejectedValue(new PrimerApiError('not_found', 'token gone', 404));
    const store = makeStore({
      entry: { tokenId: 'tok-1', token: 'primer_pat_x', prefix: 'primer_pat_AAAA', savedAt: '2026-01-01T00:00:00.000Z' },
    });
    const { deps } = buildDeps({ client, store });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_logout({});
    const payload = parseSuccessPayload<{ ok: boolean }>(result);

    expect(payload.ok).toBe(true);
    expect(store.clearToken).toHaveBeenCalledWith('http://localhost:3000');
  });

  it('swallows 401 from revoke (already invalid) and still clears', async () => {
    const client = makeFakeClient();
    client.revokeToken.mockRejectedValue(new PrimerApiError('not_authenticated', 'expired', 401));
    const store = makeStore({
      entry: { tokenId: 'tok-1', token: 'primer_pat_x', prefix: 'primer_pat_AAAA', savedAt: '2026-01-01T00:00:00.000Z' },
    });
    const { deps } = buildDeps({ client, store });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_logout({});
    const payload = parseSuccessPayload<{ ok: boolean }>(result);
    expect(payload.ok).toBe(true);
    expect(store.clearToken).toHaveBeenCalled();
  });
});

// ─────────────────── primer_whoami ───────────────────

describe('primer_whoami', () => {
  it('no token → isError with code "not_authenticated"', async () => {
    const store = makeStore({ token: undefined });
    const { deps } = buildDeps({ client: null, store });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_whoami({});
    const err = parseErrorPayload(result);
    expect(err.code).toBe('not_authenticated');
    expect(err.message).toMatch(/primer_login/);
  });

  it('with token → calls client.whoami() and returns the user', async () => {
    const client = makeFakeClient();
    client.whoami.mockResolvedValue({ id: 'u1', email: 'a@b.com', displayName: 'Alice' });
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_whoami({});
    const payload = parseSuccessPayload<{ id: string; email: string; displayName: string }>(result);
    expect(payload).toEqual({ id: 'u1', email: 'a@b.com', displayName: 'Alice' });
  });

  it('PrimerApiError from client surfaces with its code preserved', async () => {
    const client = makeFakeClient();
    client.whoami.mockRejectedValue(new PrimerApiError('forbidden', 'nope', 403));
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_whoami({});
    const err = parseErrorPayload(result);
    expect(err.code).toBe('forbidden');
  });
});

// ─────────────────── data tools ───────────────────

describe('primer_create_document', () => {
  it('no token → not_authenticated', async () => {
    const { deps } = buildDeps({ client: null });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_create_document({
      title: 't',
      content: 'c',
      format: 'markdown',
    });
    const err = parseErrorPayload(result);
    expect(err.code).toBe('not_authenticated');
  });

  it('with token → delegates to client.createDocument and returns the result', async () => {
    const client = makeFakeClient();
    const created = { documentId: 'd1', versionId: 'v1', url: '/d/d1' };
    client.createDocument.mockResolvedValue(created);
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_create_document({
      title: 'Hello',
      content: '# h',
      format: 'markdown',
      description: 'desc',
    });

    expect(client.createDocument).toHaveBeenCalledWith({
      title: 'Hello',
      content: '# h',
      format: 'markdown',
      description: 'desc',
    });
    expect(parseSuccessPayload(result)).toEqual(created);
  });

  it('contentPath → server reads the file; content never transits the model', async () => {
    const client = makeFakeClient();
    const created = { documentId: 'd1', versionId: 'v1', url: '/d/d1' };
    client.createDocument.mockResolvedValue(created);
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'primer-mcp-test-'));
    const file = nodePath.join(dir, 'artifact.html');
    // Raw bytes, not valid UTF-8: they must reach the client untouched.
    const bytes = Buffer.concat([Buffer.from('<h1>from disk</h1>'), Buffer.from([0xff, 0xfe])]);
    await fsp.writeFile(file, bytes);

    const result = await handlers.primer_create_document({
      title: 'Hello',
      contentPath: file,
      format: 'html',
    });

    expect(client.createDocument).toHaveBeenCalledWith({
      title: 'Hello',
      content: bytes,
      format: 'html',
      description: undefined,
    });
    expect(parseSuccessPayload(result)).toEqual(created);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('both content and contentPath → bad_request', async () => {
    const client = makeFakeClient();
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_create_document({
      title: 't',
      content: 'c',
      contentPath: '/tmp/x.html',
      format: 'html',
    });
    const err = parseErrorPayload(result);
    expect(err.code).toBe('bad_request');
    expect(client.createDocument).not.toHaveBeenCalled();
  });

  it('neither content nor contentPath → bad_request', async () => {
    const client = makeFakeClient();
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_create_document({ title: 't', format: 'html' });
    const err = parseErrorPayload(result);
    expect(err.code).toBe('bad_request');
    expect(client.createDocument).not.toHaveBeenCalled();
  });

  it('unreadable contentPath → bad_request with the fs error', async () => {
    const client = makeFakeClient();
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_create_document({
      title: 't',
      contentPath: '/nonexistent/padd.html',
      format: 'html',
    });
    const err = parseErrorPayload(result);
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain('Could not read contentPath');
    expect(client.createDocument).not.toHaveBeenCalled();
  });
});

describe('primer_add_version', () => {
  it('delegates to client.addVersion', async () => {
    const client = makeFakeClient();
    const added = { versionId: 'v2', versionNumber: 2, url: '/d/d1' };
    client.addVersion.mockResolvedValue(added);
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_add_version({
      documentId: 'd1',
      content: '# new',
      format: 'markdown',
      versionNote: 'minor',
    });

    expect(client.addVersion).toHaveBeenCalledWith({
      documentId: 'd1',
      content: '# new',
      format: 'markdown',
      versionNote: 'minor',
    });
    expect(parseSuccessPayload(result)).toEqual(added);
  });

  it('no token → not_authenticated', async () => {
    const { deps } = buildDeps({ client: null });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_add_version({
      documentId: 'd1',
      content: 'c',
      format: 'html',
    });
    expect(parseErrorPayload(result).code).toBe('not_authenticated');
  });
});

describe('primer_get_document', () => {
  it('delegates to client.getDocument', async () => {
    const client = makeFakeClient();
    const detail = {
      document: { id: 'd1', title: 'T', description: null, uploaderId: 'u1', uploaderDisplayName: 'A', createdAt: '2026-01-01T00:00:00.000Z' },
      latestVersion: { id: 'v1', versionNumber: 1, versionNote: null, sizeBytes: 1, createdAt: '2026-01-01T00:00:00.000Z' },
    };
    client.getDocument.mockResolvedValue(detail);
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_get_document({ documentId: 'd1' });
    expect(client.getDocument).toHaveBeenCalledWith('d1');
    expect(parseSuccessPayload(result)).toEqual(detail);
  });

  it('no token → not_authenticated', async () => {
    const { deps } = buildDeps({ client: null });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_document({ documentId: 'd1' });
    expect(parseErrorPayload(result).code).toBe('not_authenticated');
  });
});

describe('primer_list_versions', () => {
  it('delegates to client.listVersions', async () => {
    const client = makeFakeClient();
    const list = { versions: [] };
    client.listVersions.mockResolvedValue(list);
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_list_versions({ documentId: 'd1' });
    expect(client.listVersions).toHaveBeenCalledWith('d1');
    expect(parseSuccessPayload(result)).toEqual(list);
  });

  it('no token → not_authenticated', async () => {
    const { deps } = buildDeps({ client: null });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_list_versions({ documentId: 'd1' });
    expect(parseErrorPayload(result).code).toBe('not_authenticated');
  });
});

describe('primer_get_version_content', () => {
  const detailFixture = {
    document: { id: 'd1', title: 'T', description: null, uploaderId: 'u1', uploaderDisplayName: 'A', createdAt: '2026-01-01T00:00:00.000Z' },
    latestVersion: { id: 'v9', versionNumber: 7, versionNote: null, sizeBytes: 18, createdAt: '2026-01-01T00:00:00.000Z' },
  };

  it('with versionId: fetches content directly and returns it inline', async () => {
    const client = makeFakeClient();
    client.getVersionContent.mockResolvedValue('<h1>stored html</h1>');
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_get_version_content({ versionId: 'v1' });

    expect(client.getVersionContent).toHaveBeenCalledWith('v1');
    expect(client.getDocument).not.toHaveBeenCalled();
    expect(parseSuccessPayload(result)).toEqual({
      documentId: undefined,
      versionId: 'v1',
      versionNumber: undefined,
      sizeBytes: Buffer.byteLength('<h1>stored html</h1>', 'utf8'),
      content: '<h1>stored html</h1>',
    });
  });

  it('with documentId: resolves the latest version via getDocument first', async () => {
    const client = makeFakeClient();
    client.getDocument.mockResolvedValue(detailFixture);
    client.getVersionContent.mockResolvedValue('<p>latest</p>');
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_get_version_content({ documentId: 'd1' });

    expect(client.getDocument).toHaveBeenCalledWith('d1');
    expect(client.getVersionContent).toHaveBeenCalledWith('v9');
    const payload = parseSuccessPayload<Record<string, unknown>>(result);
    expect(payload).toEqual({
      documentId: 'd1',
      versionId: 'v9',
      versionNumber: 7,
      sizeBytes: Buffer.byteLength('<p>latest</p>', 'utf8'),
      content: '<p>latest</p>',
    });
  });

  it('toDisk → writes to a fresh server-owned temp file and returns metadata WITHOUT content', async () => {
    const client = makeFakeClient();
    client.getVersionContent.mockResolvedValue('<h1>saved to disk</h1>');
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_get_version_content({
      versionId: 'v1',
      toDisk: true,
    });

    const payload = parseSuccessPayload<Record<string, unknown>>(result);
    const savedTo = payload.savedTo as string;
    // Destination is server-chosen under os.tmpdir() — never an agent path.
    expect(nodePath.isAbsolute(savedTo)).toBe(true);
    expect(savedTo.startsWith(fs.realpathSync(os.tmpdir()) + nodePath.sep)
      || savedTo.startsWith(os.tmpdir() + nodePath.sep)).toBe(true);
    expect(nodePath.basename(savedTo)).toBe('content.html');
    expect(payload.sizeBytes).toBe(Buffer.byteLength('<h1>saved to disk</h1>', 'utf8'));
    expect(payload.content).toBeUndefined();
    expect(await fsp.readFile(savedTo, 'utf8')).toBe('<h1>saved to disk</h1>');
    await fsp.rm(nodePath.dirname(savedTo), { recursive: true, force: true });
  });

  it('two toDisk calls land in distinct temp dirs — no overwrite surface', async () => {
    const client = makeFakeClient();
    client.getVersionContent.mockResolvedValueOnce('<p>one</p>').mockResolvedValueOnce('<p>two</p>');
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const first = parseSuccessPayload<Record<string, unknown>>(
      await handlers.primer_get_version_content({ versionId: 'v1', toDisk: true }),
    );
    const second = parseSuccessPayload<Record<string, unknown>>(
      await handlers.primer_get_version_content({ versionId: 'v1', toDisk: true }),
    );

    expect(first.savedTo).not.toBe(second.savedTo);
    expect(await fsp.readFile(first.savedTo as string, 'utf8')).toBe('<p>one</p>');
    expect(await fsp.readFile(second.savedTo as string, 'utf8')).toBe('<p>two</p>');
    await fsp.rm(nodePath.dirname(first.savedTo as string), { recursive: true, force: true });
    await fsp.rm(nodePath.dirname(second.savedTo as string), { recursive: true, force: true });
  });

  it('both versionId and documentId → bad_request', async () => {
    const client = makeFakeClient();
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_version_content({ versionId: 'v1', documentId: 'd1' });
    expect(parseErrorPayload(result).code).toBe('bad_request');
    expect(client.getVersionContent).not.toHaveBeenCalled();
  });

  it('neither versionId nor documentId → bad_request', async () => {
    const client = makeFakeClient();
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_version_content({});
    expect(parseErrorPayload(result).code).toBe('bad_request');
  });

  it('unknown version → not_found from the client is passed through', async () => {
    const client = makeFakeClient();
    client.getVersionContent.mockRejectedValue(new PrimerApiError('not_found', 'version not found', 404));
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_version_content({ versionId: 'nope' });
    expect(parseErrorPayload(result).code).toBe('not_found');
  });

  it('no token → not_authenticated', async () => {
    const { deps } = buildDeps({ client: null });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_version_content({ versionId: 'v1' });
    expect(parseErrorPayload(result).code).toBe('not_authenticated');
  });
});

describe('primer_get_comments', () => {
  function threadsFixture() {
    return {
      asOf: '2026-06-05T12:00:00.000Z',
      threads: [
        {
          id: 't1',
          versionId: 'v1',
          versionNumber: 1,
          contextChanged: false,
          anchor: { type: 'text-range', selectorText: 'snippet', prefix: '', suffix: '', containerPath: 'body' },
          resolvedAt: null,
          resolvedBy: null,
          resolvedByDisplayName: null,
          createdAt: '2026-06-05T10:00:00.000Z',
          comments: [
            {
              id: 'c1',
              threadId: 't1',
              authorId: 'u1',
              authorDisplayName: 'Alice',
              authorKind: 'person',
              authorVia: null,
              body: 'Note',
              createdAt: '2026-06-05T10:00:00.000Z',
              updatedAt: null,
              deletedAt: null,
              mentions: [],
            },
          ],
        },
      ],
    };
  }

  it('with versionId: calls getVersionThreads directly and formats', async () => {
    const client = makeFakeClient();
    client.getVersionThreads.mockResolvedValue(threadsFixture());
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_get_comments({ versionId: 'v1' });

    expect(client.getVersionThreads).toHaveBeenCalledWith('v1');
    expect(result.isError).toBeFalsy();
    const out = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(out.markdown).toContain('> snippet');
    expect(out.markdown).toContain('**Alice** — Note');
    expect(out.comments).toEqual([
      {
        thread_id: 't1',
        comment_id: 'c1',
        author_id: 'u1',
        author_name: 'Alice',
        body: 'Note',
        created_at: '2026-06-05T10:00:00.000Z',
        anchor_text: 'snippet',
        version_number: 1,
        resolved: false,
        context_changed: false,
      },
    ]);
  });

  it('primer_reply_to_thread posts the reply and returns the created ids', async () => {
    const client = makeFakeClient();
    client.replyToThread.mockResolvedValue({ comment: { id: 'c2' }, thread: { id: 't1' } });
    const { deps } = buildDeps({ client });
    const result = await buildToolHandlers(deps).primer_reply_to_thread({ thread_id: 't1', body: 'Addressed in v2.' });
    expect(client.replyToThread).toHaveBeenCalledWith('t1', 'Addressed in v2.');
    expect(JSON.parse((result.content[0] as { type: 'text'; text: string }).text)).toEqual({ thread_id: 't1', comment_id: 'c2' });
  });

  it('with documentId: resolves latest via getDocument, then getVersionThreads, includes title + version in header', async () => {
    const client = makeFakeClient();
    client.getDocument.mockResolvedValue({
      document: { id: 'd1', title: 'My Doc', description: null, uploaderId: 'u1', uploaderDisplayName: 'A', createdAt: '2026-01-01T00:00:00.000Z' },
      latestVersion: { id: 'v9', versionNumber: 7, versionNote: null, sizeBytes: 1, createdAt: '2026-01-01T00:00:00.000Z' },
    });
    client.getVersionThreads.mockResolvedValue(threadsFixture());
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);

    const result = await handlers.primer_get_comments({ documentId: 'd1' });

    expect(client.getDocument).toHaveBeenCalledWith('d1');
    expect(client.getVersionThreads).toHaveBeenCalledWith('v9');
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('# Comments on My Doc (v7)');
  });

  it('errors when neither versionId nor documentId provided', async () => {
    const client = makeFakeClient();
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_comments({});
    const err = parseErrorPayload(result);
    expect(err.code).toBe('bad_request');
  });

  it('errors when both versionId and documentId provided', async () => {
    const client = makeFakeClient();
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_comments({ versionId: 'v1', documentId: 'd1' });
    const err = parseErrorPayload(result);
    expect(err.code).toBe('bad_request');
  });

  it('no token → not_authenticated', async () => {
    const { deps } = buildDeps({ client: null });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_comments({ versionId: 'v1' });
    expect(parseErrorPayload(result).code).toBe('not_authenticated');
  });

  it('propagates PrimerApiError code from getVersionThreads', async () => {
    const client = makeFakeClient();
    client.getVersionThreads.mockRejectedValue(new PrimerApiError('not_found', 'no version', 404));
    const { deps } = buildDeps({ client });
    const handlers = buildToolHandlers(deps);
    const result = await handlers.primer_get_comments({ versionId: 'v1' });
    expect(parseErrorPayload(result).code).toBe('not_found');
  });
});

// ─────────────────── Document events (issue #78) ───────────────────

describe('primer_get_events', () => {
  it('passes filters through to client.getEvents and returns the raw page JSON', async () => {
    const { deps, client } = buildDeps();
    const page = {
      events: [{ id: 3, namespace: 'padd', type: 'export', audience: 'artifact', payload: {} }],
      nextPageToken: null,
    };
    client!.getEvents.mockResolvedValue(page);
    const handlers = buildToolHandlers(deps);
    const res = await handlers.primer_get_events({
      documentId: 'doc-1',
      namespace: 'padd/*',
      type: 'export',
      since: 2,
      limit: 10,
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual(page);
    expect(client!.getEvents).toHaveBeenCalledWith('doc-1', {
      since: 2,
      namespace: 'padd/*',
      type: 'export',
      versionId: undefined,
      pageToken: undefined,
      limit: 10,
    });
  });

  it('requires documentId and surfaces API errors as typed codes', async () => {
    const { deps, client } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const missing = await handlers.primer_get_events({});
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0].text).code).toBe('bad_request');

    client!.getEvents.mockRejectedValue(new PrimerApiError('not_found', 'document not found', 404));
    const notFound = await handlers.primer_get_events({ documentId: 'nope' });
    expect(notFound.isError).toBe(true);
    expect(JSON.parse(notFound.content[0].text).code).toBe('not_found');
  });
});

describe('primer_send_events', () => {
  const batch = [
    { namespace: 'padd', type: 'reconciliation', payload: { itemId: 'q1' }, audience: 'artifact' },
  ];

  it('passes the batch through verbatim and returns the created rows', async () => {
    const { deps, client } = buildDeps();
    const created = { events: [{ id: 12, ...batch[0], documentId: 'doc-1', authorId: 'svc' }] };
    client!.sendEvents.mockResolvedValue(created);
    const handlers = buildToolHandlers(deps);
    const res = await handlers.primer_send_events({ documentId: 'doc-1', events: batch });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toEqual(created);
    expect(client!.sendEvents).toHaveBeenCalledWith('doc-1', batch);
  });

  it('rejects a missing/empty batch locally and maps server rejections', async () => {
    const { deps, client } = buildDeps();
    const handlers = buildToolHandlers(deps);
    const empty = await handlers.primer_send_events({ documentId: 'doc-1', events: [] });
    expect(empty.isError).toBe(true);

    client!.sendEvents.mockRejectedValue(new PrimerApiError('forbidden', 'not a collaborator', 403));
    const forbidden = await handlers.primer_send_events({ documentId: 'doc-1', events: batch });
    expect(JSON.parse(forbidden.content[0].text).code).toBe('forbidden');
  });
});

// ─────────────────── collaborator tools ───────────────────

describe('collaborator tools', () => {
  it('primer_add_collaborator resolves an email, then adds the user at the role', async () => {
    const { deps, client } = buildDeps();
    const row = { userId: 'u-2', displayName: 'Two', role: 'editor', grantedBy: 'agent', createdAt: 't' };
    client!.lookupUser.mockResolvedValue({ id: 'u-2', email: 'two@example.com', displayName: 'Two' });
    client!.addCollaborator.mockResolvedValue(row);
    const result = await buildToolHandlers(deps).primer_add_collaborator({
      documentId: 'doc-1',
      email: ' Two@Example.com ',
      role: 'editor',
    });
    expect(parseSuccessPayload(result)).toEqual(row);
    expect(client!.lookupUser).toHaveBeenCalledWith('Two@Example.com');
    expect(client!.addCollaborator).toHaveBeenCalledWith('doc-1', 'u-2', 'editor');
  });

  it('primer_add_collaborator needs exactly one of email or userId, and a valid role', async () => {
    const { deps, client } = buildDeps();
    const h = buildToolHandlers(deps);
    expect(parseErrorPayload(await h.primer_add_collaborator({ documentId: 'd', role: 'editor' })).code).toBe('bad_request');
    expect(
      parseErrorPayload(await h.primer_add_collaborator({ documentId: 'd', email: 'a@b.c', userId: 'u', role: 'editor' })).code,
    ).toBe('bad_request');
    expect(parseErrorPayload(await h.primer_add_collaborator({ documentId: 'd', userId: 'u', role: 'owner' })).code).toBe('bad_request');
    expect(client!.addCollaborator).not.toHaveBeenCalled();
  });

  it('surfaces the server refusal and an unknown email as errors', async () => {
    const { deps, client } = buildDeps();
    const h = buildToolHandlers(deps);
    client!.lookupUser.mockRejectedValue(new PrimerApiError('not_found', 'not_found', 404));
    expect(parseErrorPayload(await h.primer_add_collaborator({ documentId: 'd', email: 'x@y.z', role: 'editor' })).code).toBe('not_found');
    client!.addCollaborator.mockRejectedValue(new PrimerApiError('forbidden', 'forbidden', 403));
    expect(parseErrorPayload(await h.primer_add_collaborator({ documentId: 'd', userId: 'u', role: 'editor' })).code).toBe('forbidden');
  });

  it('primer_list_collaborators and primer_lookup_user pass through', async () => {
    const { deps, client } = buildDeps();
    const h = buildToolHandlers(deps);
    client!.listCollaborators.mockResolvedValue({ collaborators: [] });
    expect(parseSuccessPayload(await h.primer_list_collaborators({ documentId: 'd' }))).toEqual({ collaborators: [] });
    const found = { id: 'u-9', email: 'a@b.c', displayName: 'Nine' };
    client!.lookupUser.mockResolvedValue(found);
    expect(parseSuccessPayload(await h.primer_lookup_user({ email: 'a@b.c' }))).toEqual(found);
  });
});
