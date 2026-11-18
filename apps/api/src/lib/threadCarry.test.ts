// End to end: threads started on one version show on the next, by their
// quoted text, and agents can answer them over MCP.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadDTO, ThreadsListResponse } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { buildMcpToolHandlers } from '../mcp/tools.ts';
import { asUserJson } from '../test/harness.ts';
import { bodyText } from './threadCarry.ts';

const user = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User' };

async function withPrimer<T>(
  fn: (p: {
    app: ReturnType<typeof createApp>;
    tools: ReturnType<typeof buildMcpToolHandlers>;
    storage: FilesystemStorage;
  }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-carry-test-'));
  try {
    const storage = new FilesystemStorage(root);
    const notifier = new NoopNotifier();
    const app = createApp({ storage, notifier });
    const tools = buildMcpToolHandlers({ storage, notifier, apiBaseUrl: 'https://primer.example.com' });
    return await fn({ app, tools, storage });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type Tools = ReturnType<typeof buildMcpToolHandlers>;
type Json = Record<string, unknown>;

async function call(tools: Tools, name: keyof Tools, args: Json): Promise<Json> {
  const res = await tools[name](args, user);
  expect(res.isError, res.content[0].text).toBeFalsy();
  return JSON.parse(res.content[0].text) as Json;
}

/** A position anchor on the first occurrence of `quote`, as the companion
 *  would capture it (raw offsets into the body text). */
async function anchorOn(storage: FilesystemStorage, versionId: string, quote: string) {
  const html = await new Response(await storage.get(`v1/${versionId}.html`)).text();
  const body = bodyText(html);
  const i = body.text.indexOf(quote);
  expect(i).toBeGreaterThanOrEqual(0);
  return {
    type: 'text-range' as const,
    selectorText: quote,
    start: body.rawOffset[i],
    end: body.rawOffset[i + quote.length - 1] + 1,
  };
}

async function startThread(
  p: { app: ReturnType<typeof createApp>; storage: FilesystemStorage },
  versionId: string,
  quote: string,
  body: string,
): Promise<string> {
  const res = await p.app.request(`/api/versions/${versionId}/threads`, {
    method: 'POST',
    headers: asUserJson(user.id),
    body: JSON.stringify({ anchor: await anchorOn(p.storage, versionId, quote), body }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as ThreadDTO).id;
}

async function threadsOn(app: ReturnType<typeof createApp>, versionId: string): Promise<ThreadDTO[]> {
  const res = await app.request(`/api/versions/${versionId}/threads`, { headers: asUserJson(user.id) });
  expect(res.status).toBe(200);
  return ((await res.json()) as ThreadsListResponse).threads;
}

const V1 = `<h1>Plan</h1>
<p>The launch date is Friday, pending review.</p>
<p>Budget stays at ten thousand.</p>
<p>Owner: the platform team.</p>`;

describe('threads across versions', () => {
  it('carries open threads to a new version by their quoted text, or marks the context changed', async () => {
    await withPrimer(async (p) => {
      const created = await call(p.tools, 'primer_create_document', { title: 'Plan', content: V1, format: 'html' });
      const documentId = created.documentId as string;
      const v1 = created.versionId as string;

      const kept = await startThread(p, v1, 'launch date', 'Is this confirmed?');
      const changed = await startThread(p, v1, 'ten thousand', 'Too low.');
      const resolved = await startThread(p, v1, 'platform team', 'Which one?');
      await call(p.tools, 'primer_resolve_thread', { thread_id: resolved });

      // v2: a new paragraph above, reformatted whitespace, the budget rewritten.
      const v2 = (await call(p.tools, 'primer_add_version', {
        documentId,
        format: 'html',
        content: `<h1>Plan</h1><p>New: a summary paragraph.</p>
          <p>The   launch date
          is Friday, pending review.</p>
          <p>Budget is twelve thousand.</p>
          <p>Owner: the platform team.</p>`,
      })).versionId as string;

      const onV2 = new Map((await threadsOn(p.app, v2)).map((t) => [t.id, t]));
      expect([...onV2.keys()].sort()).toEqual([kept, changed].sort());
      expect(onV2.get(kept)).toMatchObject({
        versionId: v1,
        contextChanged: false,
        anchor: { type: 'text-range', selectorText: 'launch date', containerPath: 'body' },
      });
      expect(onV2.get(changed)).toMatchObject({ contextChanged: true, anchor: { selectorText: 'ten thousand' } });

      // The originating version still lists all three, as started.
      const onV1 = await threadsOn(p.app, v1);
      expect(onV1.map((t) => t.id).sort()).toEqual([kept, changed, resolved].sort());
      expect(onV1.every((t) => !t.contextChanged)).toBe(true);
    });
  });

  it('does not place a quote whose text and context occur twice', async () => {
    await withPrimer(async (p) => {
      const created = await call(p.tools, 'primer_create_document', { title: 'Plan', content: V1, format: 'html' });
      const thread = await startThread(p, created.versionId as string, 'launch date', 'Is this confirmed?');
      const v2 = (await call(p.tools, 'primer_add_version', {
        documentId: created.documentId,
        format: 'html',
        content: `${V1}<h1>Plan</h1>\n<p>The launch date is Friday, pending review.</p>\n<p>Budget stays at ten thousand.</p>`,
      })).versionId as string;
      const [t] = await threadsOn(p.app, v2);
      expect(t).toMatchObject({ id: thread, contextChanged: true });
    });
  });

  it('lets an agent read, answer and resolve carried threads over MCP', async () => {
    await withPrimer(async (p) => {
      const created = await call(p.tools, 'primer_create_document', { title: 'Plan', content: V1, format: 'html' });
      const thread = await startThread(p, created.versionId as string, 'launch date', 'Is this confirmed?');
      await call(p.tools, 'primer_add_version', { documentId: created.documentId, format: 'html', content: V1 });

      const listed = await call(p.tools, 'primer_get_comments', { documentId: created.documentId });
      expect(listed.comments).toEqual([
        expect.objectContaining({
          thread_id: thread,
          author_id: user.id,
          body: 'Is this confirmed?',
          anchor_text: 'launch date',
          version_number: 1,
          resolved: false,
          context_changed: false,
        }),
      ]);
      expect(listed.markdown).toContain(`thread ${thread}`);

      const reply = await call(p.tools, 'primer_reply_to_thread', { thread_id: thread, body: 'Addressed in v2.' });
      expect(reply).toMatchObject({ thread_id: thread, comment_id: expect.any(String) });
      expect(await call(p.tools, 'primer_resolve_thread', { thread_id: thread })).toEqual({ thread_id: thread, resolved: true });

      const after = await call(p.tools, 'primer_get_comments', { documentId: created.documentId });
      expect(after.comments).toEqual([
        expect.objectContaining({ comment_id: expect.any(String), resolved: true }),
        expect.objectContaining({ comment_id: reply.comment_id, body: 'Addressed in v2.', resolved: true }),
      ]);

      // Resolved threads stay behind on the next version.
      const v3 = await call(p.tools, 'primer_add_version', { documentId: created.documentId, format: 'html', content: V1 });
      expect(await threadsOn(p.app, v3.versionId as string)).toEqual([]);
    });
  });
});
