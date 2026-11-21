import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../app.ts';
import { publishDocument, type PublishInput } from '../lib/publish.ts';
import { similarity } from '../lib/similarity.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { exportMarkdown } from './export.ts';
import { getLiveDoc } from './read.ts';
import { comment, ops, withLiveDoc } from './live.testlib.ts';
import { listSuggestions } from './suggest.ts';
import { align } from './merge.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };

async function withStorage<T>(fn: (storage: FilesystemStorage) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-merge-'));
  try {
    return await fn(new FilesystemStorage(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function md(source: string, extra: Partial<PublishInput> = {}): PublishInput {
  return { actor: owner, title: 'Doc', content: new TextEncoder().encode(source), filename: 'doc.md', format: 'markdown', ...extra };
}

async function publish(storage: FilesystemStorage, input: PublishInput) {
  const out = await publishDocument(storage, input);
  if (!out.ok) throw new Error(out.refusal.message);
  return out;
}

/** Blocks of the main tab: id, version and Markdown, in order. */
async function blocks(documentId: string) {
  const out = await getLiveDoc(documentId, owner, { format: 'markdown' });
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value.blocks.map((b) => ({ id: b.target.blockId, version: b.version, markdown: b.markdown! }));
}

const target = (blockId: string) => ({ tabId: 'main', blockId });

describe('three-way Markdown republish', () => {
  it('republish merges by block and keeps comment marks and concurrent edits', async () => {
    await withStorage(async (storage) => {
      const first = await publish(storage, md('# Plan\n\nAlpha stays as it is.\n\nBeta is edited by a person.\n\nGamma is changed upstream.\n'));
      const [, alpha, beta] = await blocks(first.documentId);
      const threadId = await comment(first.documentId, alpha!.id, 'stays');
      await ops(first.documentId, owner, { ops: [{ op: 'update', target: target(beta!.id), block: 'Beta, edited by a person.', expectVersion: beta!.version }] });

      const second = await publish(
        storage,
        md('# Plan\n\nAlpha stays as it is.\n\nBeta is edited by a person.\n\nGamma is changed upstream, here.\n\nDelta is new.\n', { documentId: first.documentId }),
      );
      expect(second.versionNumber).toBe(2);
      expect(second.reconciliation!.outcomes.map((o) => o.status)).toEqual(['applied', 'applied']);

      const now = await blocks(first.documentId);
      expect(now.map((b) => b.markdown)).toEqual([
        '# Plan',
        'Alpha stays as it is.',
        'Beta, edited by a person.',
        'Gamma is changed upstream, here.',
        'Delta is new.',
      ]);
      expect(now[1]!.id).toBe(alpha!.id);
      const marked = await withLiveDoc(first.documentId, (doc) => JSON.stringify(doc.getXmlFragment('document-store').toJSON()));
      expect(marked).toContain(threadId);

      // What nobody edited exports as the new file; the person's edit is serialised.
      const exported = await withLiveDoc(first.documentId, (doc) => exportMarkdown(doc, first.documentId));
      expect(exported).toBe('# Plan\n\nAlpha stays as it is.\n\nBeta, edited by a person.\n\nGamma is changed upstream, here.\n\nDelta is new.\n');
    });
  });

  it('reordered identical groups move', async () => {
    await withStorage(async (storage) => {
      const first = await publish(storage, md('Alpha one.\n\nBeta two.\n\nGamma three.\n'));
      const before = await blocks(first.documentId);
      const second = await publish(storage, md('Gamma three.\n\nAlpha one.\n\nBeta two.\n', { documentId: first.documentId }));
      expect(second.reconciliation!.outcomes.map((o) => o.status)).toEqual(['applied']);
      const now = await blocks(first.documentId);
      expect(now.map((b) => b.markdown)).toEqual(['Gamma three.', 'Alpha one.', 'Beta two.']);
      expect(now.map((b) => b.id).sort()).toEqual(before.map((b) => b.id).sort());
    });
  });

  it('a reworded paragraph counts as changed, not deleted plus inserted', async () => {
    await withStorage(async (storage) => {
      const first = await publish(storage, md('Intro.\n\nThe quarterly numbers grew in every region we track.\n'));
      const before = await blocks(first.documentId);
      const next = 'Intro.\n\nThe quarterly numbers grew in nearly every region we track.\n';
      expect(similarity(before[1]!.markdown, 'The quarterly numbers grew in nearly every region we track.')).toBeGreaterThan(0.5);

      const second = await publish(storage, md(next, { documentId: first.documentId }));
      expect(second.reconciliation!.outcomes).toMatchObject([{ status: 'applied', target: { blockId: before[1]!.id } }]);
      const after = await blocks(first.documentId);
      expect(after.map((b) => b.id)).toEqual(before.map((b) => b.id));
      expect(await withLiveDoc(first.documentId, (doc) => exportMarkdown(doc, first.documentId))).toBe(next);
    });
  });

  it('both changed yields a suggestion', async () => {
    await withStorage(async (storage) => {
      const first = await publish(storage, md('Shipping date is March.\n\nOther text.\n'));
      const [para] = await blocks(first.documentId);
      await ops(first.documentId, owner, { ops: [{ op: 'update', target: target(para!.id), block: 'Shipping date is April.', expectVersion: para!.version }] });

      const second = await publish(storage, md('Shipping date is late March.\n\nOther text.\n', { documentId: first.documentId }));
      expect(second.reconciliation!.outcomes).toMatchObject([{ status: 'suggested', suggestionId: expect.any(String) }]);
      expect((await blocks(first.documentId)).map((b) => b.markdown)).toEqual(['Shipping date is April.', 'Other text.']);
      const list = await listSuggestions(owner, first.documentId);
      expect(list.ok && list.value[0]!.edits[0]).toMatchObject({
        kind: 'replace',
        current: { markdown: 'Shipping date is April.' },
        proposed: { markdown: 'Shipping date is late March.' },
      });
    });
  });

  it('a file rewritten from scratch replaces every untouched group', async () => {
    await withStorage(async (storage) => {
      const first = await publish(storage, md('Old one.\n\nOld two.\n'));
      const second = await publish(storage, md('# Brand new\n\n- a list\n', { documentId: first.documentId }));
      expect(second.reconciliation!.outcomes.every((o) => o.status === 'applied')).toBe(true);
      expect(await withLiveDoc(first.documentId, (doc) => exportMarkdown(doc, first.documentId))).toBe('# Brand new\n\n- a list\n');
    });
  });

  it('a 1,000-block republish of near-identical 4 KB paragraphs finishes under a fixed time budget', () => {
    const para = (k: number, v: string) => `${'Lorem ipsum dolor sit amet. '.repeat(142)}${v} ${k}\n`;
    const group = (slice: string) => ({ entry: { slice, gap: '\n', groupIds: ['x'], version: '', refs: [], defines: [] }, lead: 'paragraph_open' });
    const base = Array.from({ length: 1000 }, (_, k) => group(para(k, 'old')));
    const their = Array.from({ length: 1000 }, (_, k) => group(para(k, 'new')));
    expect(base[0]!.entry.slice.length).toBeLessThanOrEqual(4096);

    const started = Date.now();
    const { identityOnly } = align(base, their);
    expect(Date.now() - started).toBeLessThan(5000);
    // The budget ran out: the rest aligned by identical text only, and says so.
    expect(identityOnly).toBe(true);
  });
});

