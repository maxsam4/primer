import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Two real server processes against one database and one storage root: the
// second process must verify the first one's import signatures.
const apiRoot = join(import.meta.dirname, '../..');
let storageRoot: string | null = null;

async function startServer(port: number): Promise<{ child: ChildProcess; output: () => string }> {
  let out = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: apiRoot,
    env: { ...process.env, PORT: String(port), AUTH_MODE: 'mock', STORAGE_BACKEND: 'filesystem', STORAGE_ROOT: storageRoot!, PURGE_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${out}`);
    if (out.includes('primer api listening')) return { child, output: () => out };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start:\n${out}`);
}

async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
}

function post(port: number, path: string, form: FormData): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, { method: 'POST', body: form, headers: { 'x-primer-csrf': '1' } });
}

function markdownFile(text: string): FormData {
  const form = new FormData();
  form.set('file', new File([text], 'doc.md', { type: 'text/markdown' }));
  form.set('title', 'Restart');
  return form;
}

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  storageRoot = null;
});

describe('a server restart', () => {
  it('keeps import signatures valid, so an identical republish changes nothing', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'primer-restart-'));
    const port = 31000 + Math.floor(Math.random() * 2000);
    const source = 'One paragraph.\n';

    const first = await startServer(port);
    const uploaded = (await (await post(port, '/api/upload', markdownFile(source))).json()) as { documentId: string };
    expect(uploaded.documentId).toBeTruthy();
    await stop(first.child);

    const second = await startServer(port);
    try {
      const res = await post(port, `/api/documents/${uploaded.documentId}/versions`, markdownFile(source));
      const body = (await res.json()) as { versionNumber?: number };
      expect(body.versionNumber).toBeUndefined();
      const exported = await (await fetch(`http://localhost:${port}/api/documents/${uploaded.documentId}/export`)).text();
      expect(exported.match(/One paragraph\./g)).toHaveLength(1);
      expect(second.output()).not.toContain('process-local');
    } finally {
      await stop(second.child);
    }
  }, 60_000);
});
