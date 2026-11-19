// Threads across versions + lifecycle events together: an agent's MCP reply on
// a thread carried to a newer version is one `primer.comment.created` on the
// version the reply was posted on, delivered on the owner's stream.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventRowDTO, EventsListResponse, ThreadDTO } from '@polygonlabs/primer-api-types';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { buildMcpToolHandlers } from '../mcp/tools.ts';
import { asUser, asUserJson } from '../test/harness.ts';

const user = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person' as const, viaUserId: null };
const DOC = '<h1>Plan</h1><p>The launch date is Friday.</p>';

async function frames(res: Response, ms: number): Promise<EventRowDTO[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const rows: EventRowDTO[] = [];
  let buffer = '';
  const deadline = Date.now() + ms;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const next = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left)),
      ]);
      if (next === 'timeout' || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (let sep = buffer.indexOf('\n\n'); sep !== -1; sep = buffer.indexOf('\n\n')) {
        const data = buffer.slice(0, sep).split('\n').find((l) => l.startsWith('data:'));
        buffer = buffer.slice(sep + 2);
        if (data) rows.push(JSON.parse(data.slice(5)) as EventRowDTO);
      }
    }
  } finally {
    await reader.cancel();
  }
  return rows;
}

describe('MCP reply on a carried thread', () => {
  it('emits exactly one comment.created on the latest version, visible on the scope=me stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-carried-reply-'));
    try {
      const storage = new FilesystemStorage(root);
      const notifier = new NoopNotifier();
      const app = createApp({ storage, notifier, userResolver: mockMultiResolver });
      const tools = buildMcpToolHandlers({ storage, notifier, apiBaseUrl: 'https://primer.example.com' });
      const call = async (name: keyof typeof tools, args: Record<string, unknown>) => {
        const res = await tools[name](args, user);
        expect(res.isError, res.content[0].text).toBeFalsy();
        return JSON.parse(res.content[0].text) as Record<string, string>;
      };

      const { documentId, versionId: v1 } = await call('primer_create_document', { title: 'Plan', content: DOC, format: 'html' });
      const started = await app.request(`/api/versions/${v1}/threads`, {
        method: 'POST',
        headers: asUserJson(user.id),
        body: JSON.stringify({ anchor: { type: 'text-range', selectorText: 'launch date', prefix: 'The ', suffix: ' is', containerPath: 'body' }, body: 'Confirmed?' }),
      });
      expect(started.status).toBe(201);
      const threadId = ((await started.json()) as ThreadDTO).id;
      const { versionId: v2 } = await call('primer_add_version', { documentId, format: 'html', content: DOC });

      const before = (await (await app.request(`/api/documents/${documentId}/events?namespace=primer`, {
        headers: asUser(user.id),
      })).json()) as EventsListResponse;
      const since = before.events.at(-1)!.id;

      const stream = await app.request(`/api/events/stream?scope=me&since=${since}`, { headers: asUser(user.id) });
      expect(stream.status).toBe(200);
      const { comment_id } = await call('primer_reply_to_thread', { thread_id: threadId, body: 'Addressed in v2.' });

      const rows = await frames(stream, 500);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ namespace: 'primer', type: 'comment.created', documentId, versionId: v2 });
      expect(rows[0].payload).toEqual({
        document_id: documentId,
        version_id: v2,
        thread_id: threadId,
        comment_id,
        author_id: user.id,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
