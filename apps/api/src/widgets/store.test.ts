import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WidgetDTO } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, suggestions, threadPlacements, users, versions, widgets } from '../db/schema.ts';
import { v7 as uuidv7 } from 'uuid';
import { createLiveThread } from '../lib/liveThreads.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { applyOps } from '../live/ops.ts';
import { recordsApi } from '../records/store.ts';
import { flushDataChanged } from '../records/changed.ts';
import { readBundleFile } from '../live/bundle.ts';
import { createCheckpoint, restoreCheckpoint } from '../live/checkpoint.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { createLiveDoc, makeAgent, paragraph, seedBlocks, withLiveDoc } from '../live/live.testlib.ts';
import { applyPlan } from '../live/pipeline.ts';
import { readBlocks } from '../live/editor.ts';
import { reachableFragments } from '../live/reach.ts';
import { labelEdit, readLabel } from './labels.ts';
import { draftWidget, getWidget, publishWidget, widgetImage } from './store.ts';
import { renderBoth, widgetIdPrefix } from './render.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock', kind: 'person', viaUserId: null };

const flow = (review: string, merge = 'Merge') => `export default function render({ tokens }) {
  return (
    <svg viewBox="0 0 400 80">
      <g data-anchor="step-review"><text data-text-id="review" x="20" y="40" fill={tokens.fg}>${review}</text></g>
      <g data-anchor="step-merge"><text data-text-id="merge" x="200" y="40" fill={tokens.fg}>${merge}</text></g>
    </svg>
  );
}`;

const labelMap = (dto: WidgetDTO) => Object.fromEntries(dto.labels.map((l) => [l.textId, l.text]));

async function draftAndPublish(documentId: string, source: string, widgetId?: string) {
  const draft = await draftWidget(owner, documentId, { widgetId, source, afterBlockId: widgetId ? undefined : 'intro' });
  if (!draft.ok) throw new Error(JSON.stringify(draft.refusal));
  const published = await publishWidget(owner, draft.value.widgetId, draft.value.previewHash);
  if (!published.ok) throw new Error(JSON.stringify(published.refusal));
  return { draft: draft.value, published: published.value };
}

/** A person types into a label (as the overlay does, through the same fragment). */
async function personEdits(documentId: string, blockId: string, textId: string, text: string) {
  await applyPlan(documentId, { kind: 'person', actorId: owner.id, runId: null }, {
    onConflict: 'refuse',
    edits: [labelEdit({ tabId: 'main', blockId, textId }, text)],
  });
}

describe('widget drafts and publishes', () => {
  it('places the block, publishes, and seeds reachable label fragments', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro'), paragraph('outro', 'Outro')]);
    const { draft, published } = await draftAndPublish(documentId, flow('Review'));
    expect(draft.png.light.length).toBeGreaterThan(100);

    await withLiveDoc(documentId, (doc) => {
      const blocks = readBlocks(doc, 'main');
      expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'widget', 'paragraph']);
      expect(blocks[1]!.props).toEqual({ widgetId: draft.widgetId, hash: published.publishedHash, textIds: 'review merge' });
      expect(readLabel(doc, draft.blockId, 'review')).toBe('Review');
      expect(reachableFragments(doc)).toEqual(['document-store', `widget/${draft.blockId}/review`, `widget/${draft.blockId}/merge`]);
    });
  });

  it('a draft with errors never replaces the live widget', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const { draft, published } = await draftAndPublish(documentId, flow('Review'));

    const broken = await draftWidget(owner, documentId, { widgetId: draft.widgetId, source: flow('Review').replace('{tokens.fg}', '"#000"') });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.refusal.code).toBe('widget_invalid');
    expect(broken.refusal.details?.errors).toEqual([expect.objectContaining({ line: 4, message: 'Literal colour "#000" in `fill`.' })]);

    const [row] = await db.select().from(widgets).where(eq(widgets.id, draft.widgetId));
    expect(row!.publishedHash).toBe(published.publishedHash);
    expect(row!.draftErrors).not.toBeNull();
    // Publishing is refused while the draft has errors; the live SVG still serves.
    expect((await publishWidget(owner, draft.widgetId, draft.previewHash)).ok).toBe(false);
    const image = await widgetImage(owner, draft.widgetId, 'light', 'svg');
    expect(image.ok && 'svg' in image.value && image.value.svg).toContain('>Review</text>');
  });

  it('publish with a stale previewHash is refused', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const first = await draftWidget(owner, documentId, { source: flow('Review'), afterBlockId: 'intro' });
    if (!first.ok) throw new Error('draft failed');
    const second = await draftWidget(owner, documentId, { widgetId: first.value.widgetId, source: flow('Code review') });
    if (!second.ok) throw new Error('draft failed');

    const stale = await publishWidget(owner, first.value.widgetId, first.value.previewHash);
    expect(stale).toMatchObject({ ok: false, status: 409, refusal: { code: 'widget_invalid', details: { previewHash: second.value.previewHash } } });
    expect((await publishWidget(owner, first.value.widgetId, second.value.previewHash)).ok).toBe(true);
  });

  it('label edit survives republish when the text id is kept', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const { draft } = await draftAndPublish(documentId, flow('Review'));
    await personEdits(documentId, draft.blockId, 'review', 'Peer review');

    // The agent redraws: it keeps the review label, rewords the merge label.
    const redraw = await draftAndPublish(documentId, flow('Review', 'Ship it'), draft.widgetId);
    expect(redraw.draft.labels).toEqual([{ textId: 'review', status: 'carried', text: 'Peer review', agentText: 'Review' }]);
    const dto = await getWidget(owner, draft.widgetId);
    expect(dto.ok && labelMap(dto.value)).toEqual({ review: 'Peer review', merge: 'Ship it' });

    // Both changed the same label: the person's words stay and the agent is told.
    const clash = await draftAndPublish(documentId, flow('Approval', 'Ship it'), draft.widgetId);
    expect(clash.published.labels).toEqual([{ textId: 'review', status: 'kept', text: 'Peer review', agentText: 'Approval' }]);
    const image = await widgetImage(owner, draft.widgetId, 'dark', 'svg');
    expect(image.ok && 'svg' in image.value && image.value.svg).toContain('>Peer review</text>');
  });

  it('a stranger cannot draft', async () => {
    const stranger: AuthUser = { ...owner, id: 'someone-else' };
    const documentId = await createLiveDoc();
    expect(await draftWidget(stranger, documentId, { source: flow('Review') })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('widgets in checkpoints', () => {
  it('a checkpoint keeps the widget as it looked, and restore brings back its labels and publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-widget-bundle-'));
    const storage = new FilesystemStorage(root);
    try {
      const documentId = await createLiveDoc();
      await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
      const { draft } = await draftAndPublish(documentId, flow('Review'));
      await personEdits(documentId, draft.blockId, 'review', 'Peer review');
      const checkpoint = await createCheckpoint(storage, documentId, owner, null);
      const [version] = await db.select().from(versions).where(eq(versions.id, checkpoint.versionId));
      const file = async (name: string) => new TextDecoder().decode(await readBundleFile(storage, version!.bundleKey!, name));

      expect(await file(`widgets/${draft.widgetId}.dark.svg`)).toContain('>Peer review</text>');
      const staticHtml = await file('static.html');
      expect(staticHtml).toContain('class="primer-widget-light"');
      expect(staticHtml).toContain('>Peer review</text>');
      expect(await file('export.md')).toContain(`\`\`\`primer-widget\n${draft.widgetId}\n\`\`\``);

      // Later: the person edits again and the agent redraws; restore brings both back.
      await personEdits(documentId, draft.blockId, 'review', 'Second look');
      await draftAndPublish(documentId, flow('Review', 'Ship it'), draft.widgetId);
      await restoreCheckpoint(storage, { documentId, bundleKey: version!.bundleKey! }, owner);
      const dto = await getWidget(owner, draft.widgetId);
      expect(dto.ok && labelMap(dto.value)).toEqual({ review: 'Peer review', merge: 'Merge' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('an agent that may only suggest cannot restore a published widget, directly or by suggestion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-widget-bundle-'));
    const storage = new FilesystemStorage(root);
    try {
      const documentId = await createLiveDoc();
      await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
      const { draft } = await draftAndPublish(documentId, flow('Before'));
      const checkpoint = await createCheckpoint(storage, documentId, owner, null);
      const [version] = await db.select().from(versions).where(eq(versions.id, checkpoint.versionId));
      const after = await draftAndPublish(documentId, flow('After'), draft.widgetId);

      await db.update(documents).set({ agentMode: 'suggest' }).where(eq(documents.id, documentId));
      const restored = await restoreCheckpoint(storage, { documentId, bundleKey: version!.bundleKey! }, await makeAgent(owner.id));
      expect(restored.outcomes.map((o) => o.status === 'conflict' && o.refusal?.code)).toEqual(restored.outcomes.map(() => 'forbidden'));
      expect(await db.select().from(suggestions).where(eq(suggestions.documentId, documentId))).toEqual([]);
      const [row] = await db.select().from(widgets).where(eq(widgets.id, draft.widgetId));
      expect(row!.publishedSource).toContain('After');
      expect(row!.publishedHash).toBe(after.published.publishedHash);
      expect(row!.publishedSvgLight).toContain('>After</text>');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a checkpoint keeps the placement of threads on unchanged widget labels and parts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-widget-bundle-'));
    const storage = new FilesystemStorage(root);
    try {
      const documentId = await createLiveDoc();
      await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
      const { draft } = await draftAndPublish(documentId, flow('Review'));
      const start = async (anchor: Record<string, unknown>) => {
        const out = await createLiveThread(new NoopNotifier(), owner, documentId, { anchor, body: 'Note' });
        if (!out.ok) throw new Error(out.refusal.message);
        return out.value.id;
      };
      const target = { tabId: 'main', blockId: draft.blockId };
      const onLabel = await start({ type: 'prose', target: { ...target, textId: 'review' }, quote: 'Review' });
      const onPart = await start({ type: 'widget-part', target, anchor: 'step-merge' });

      const checkpoint = await createCheckpoint(storage, documentId, owner, null);
      const placed = await db.select().from(threadPlacements).where(eq(threadPlacements.versionId, checkpoint.versionId));
      const anchorOf = (id: string) => placed.find((p) => p.threadId === id)?.anchor;
      expect(anchorOf(onLabel)).toMatchObject({ type: 'prose', target: { textId: 'review' } });
      expect(anchorOf(onPart)).toMatchObject({ type: 'widget-part', anchor: 'step-merge' });

      // The redraw no longer draws the merge step: its thread is unplaced on the next checkpoint.
      await draftAndPublish(documentId, flow('Review').replace(' data-anchor="step-merge"', ''), draft.widgetId);
      const next = await createCheckpoint(storage, documentId, owner, null);
      const later = await db.select().from(threadPlacements).where(eq(threadPlacements.versionId, next.versionId));
      expect(later.find((p) => p.threadId === onPart)?.anchor).toBeNull();
      expect(later.find((p) => p.threadId === onLabel)?.anchor).toMatchObject({ type: 'prose' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a widget id from another document is neither bundled nor restored onto it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-widget-scope-'));
    const storage = new FilesystemStorage(root);
    try {
      const docB = await createLiveDoc();
      await seedBlocks(docB, [paragraph('intro', 'Intro')]);
      const b = (await draftAndPublish(docB, flow('Secret plan'))).draft;
      const [before] = await db.select().from(widgets).where(eq(widgets.id, b.widgetId));

      // An editor of A writes blocks naming B's widget (with B's block id) and a traversal-shaped id.
      const docA = await createLiveDoc();
      await seedBlocks(docA, [
        { id: b.blockId, type: 'widget', props: { widgetId: b.widgetId, hash: before!.publishedHash!, textIds: 'review' } },
        { id: 'evil', type: 'widget', props: { widgetId: `../../${docB}/x`, hash: 'h', textIds: '' } },
      ] as never);
      const checkpoint = await createCheckpoint(storage, docA, owner, null);
      const [version] = await db.select().from(versions).where(eq(versions.id, checkpoint.versionId));
      const bundleKey = version!.bundleKey!;
      const manifest = new TextDecoder().decode(await readBundleFile(storage, bundleKey, 'manifest.json'));
      expect(manifest).not.toContain('widgets/');
      const staticHtml = new TextDecoder().decode(await readBundleFile(storage, bundleKey, 'static.html'));
      expect(staticHtml).not.toContain('Secret plan');
      expect(staticHtml).toContain('Widget unavailable');

      // A crafted bundle entry for B's widget (one that renders its kept hash) is never applied to B through A's restore.
      const crafted = await renderBoth(flow('Overwritten'), [], widgetIdPrefix(b.widgetId));
      if ('errors' in crafted) throw new Error('crafted render failed');
      await storage.put(
        `${bundleKey}widgets/${b.widgetId}.json`,
        new TextEncoder().encode(JSON.stringify({ widgetId: b.widgetId, blockId: b.blockId, hash: crafted.hash, source: flow('Overwritten'), rows: null })),
      );
      await restoreCheckpoint(storage, { documentId: docA, bundleKey }, owner);
      const [after] = await db.select().from(widgets).where(eq(widgets.id, b.widgetId));
      expect(after!.publishedSource).toBe(before!.publishedSource);
      expect(after!.documentId).toBe(docB);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const CHART = `export default function render({ rows, tokens }) {
  return (
    <svg viewBox="0 0 300 120">
      <text data-text-id="title" x="10" y="20" fill={tokens.fg}>Signups</text>
      <g data-anchor="bars">{rows.map((r, i) => <rect data-row={r.id} data-col="signups" x={10 + i * 40} y={110 - r.signups / 5} width="30" height={r.signups / 5} fill={tokens.accent1} />)}</g>
    </svg>
  );
}`;

describe('widgets with comments, ops and records', () => {
  it('data-point comment anchors to row and column', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const draft = await draftWidget(owner, documentId, { source: CHART, rows: [{ id: 'w1', signups: 240 }, { id: 'w2', signups: 410 }], afterBlockId: 'intro' });
    if (!draft.ok) throw new Error('draft failed');
    await publishWidget(owner, draft.value.widgetId, draft.value.previewHash);
    const target = { tabId: 'main', blockId: draft.value.blockId };
    const comment = (anchor: Record<string, unknown>) => createLiveThread(new NoopNotifier(), owner, documentId, { anchor: { target, ...anchor }, body: 'Why so high?' });

    const point = await comment({ type: 'data-point', row: 'w2', column: 'signups' });
    expect(point.ok && point.value.anchor).toEqual({ type: 'data-point', target, row: 'w2', column: 'signups' });
    expect((await comment({ type: 'widget-part', anchor: 'bars' })).ok).toBe(true);
    expect(await comment({ type: 'data-point', row: 'w9', column: 'signups' })).toMatchObject({ ok: false, refusal: { message: 'The widget has no row "w9".' } });
    expect(await comment({ type: 'data-point', row: 'w1', column: 'nope' })).toMatchObject({ ok: false, status: 400 });
    expect(await comment({ type: 'widget-part', anchor: 'axis' })).toMatchObject({ ok: false, refusal: { message: 'The widget draws no part named "axis".' } });
    expect(
      await createLiveThread(new NoopNotifier(), owner, documentId, { anchor: { type: 'data-point', target: { tabId: 'main', blockId: 'intro' }, row: 'w1', column: 'signups' }, body: 'x' }),
    ).toMatchObject({ ok: false, refusal: { message: 'Block intro is not a widget.' } });
  });

  it('ops edit a label by its version; an agent that may only suggest proposes it instead', async () => {
    const agentId = `agent_${uuidv7()}`;
    await db.insert(users).values({ id: agentId, email: '', displayName: 'Helper', kind: 'agent', viaUserId: owner.id });
    const agent: AuthUser = { id: agentId, email: '', displayName: 'Helper', kind: 'agent', viaUserId: owner.id };
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const { draft } = await draftAndPublish(documentId, flow('Review'));
    const read = await getWidget(agent, draft.widgetId);
    if (!read.ok) throw new Error('read failed');
    const review = read.value.labels.find((l) => l.textId === 'review')!;
    expect(review.text).toMatch(/^<untrusted-label-[0-9a-f]+>\nReview\n<\/untrusted-label-/);

    const ops = await applyOps(documentId, agent, { baseVersion: 0, ops: [{ op: 'update', target: review.target, expectVersion: review.version, block: 'Code   review' }] });
    expect(ops).toMatchObject({ ok: true, value: { outcomes: [{ status: 'applied' }] } });
    await withLiveDoc(documentId, (doc) => expect(readLabel(doc, draft.blockId, 'review')).toBe('Code review'));

    await db.update(documents).set({ agentMode: 'suggest' }).where(eq(documents.id, documentId));
    expect(await draftWidget(agent, documentId, { widgetId: draft.widgetId, source: flow('Again') })).toMatchObject({ ok: false, status: 403 });
    const again = (await getWidget(agent, draft.widgetId)) as { ok: true; value: WidgetDTO };
    const label = again.value.labels.find((l) => l.textId === 'review')!;
    const suggested = await applyOps(documentId, agent, { baseVersion: 0, ops: [{ op: 'update', target: label.target, expectVersion: label.version, block: 'Peer review' }] });
    expect(suggested).toMatchObject({ ok: true, value: { outcomes: [{ status: 'suggested' }] } });
    const [row] = await db.select().from(suggestions).where(eq(suggestions.documentId, documentId));
    expect(JSON.stringify(row!.edits)).toContain('"textId":"review"');
    await withLiveDoc(documentId, (doc) => expect(readLabel(doc, draft.blockId, 'review')).toBe('Code review'));
  });

  it('chart re-renders when its collection changes', async () => {
    const documentId = await createLiveDoc();
    await seedBlocks(documentId, [paragraph('intro', 'Intro')]);
    const records = recordsApi(owner, documentId);
    await records.set({ collection: 'signups', scope: 'shared', recordId: 'w1', data: { signups: 240 } });
    await records.set({ collection: 'signups', scope: 'shared', recordId: 'w2', data: { signups: 410 } });
    await flushDataChanged();

    const draft = await draftWidget(owner, documentId, { source: CHART, collection: 'signups', afterBlockId: 'intro' });
    if (!draft.ok) throw new Error(JSON.stringify(draft.refusal));
    await publishWidget(owner, draft.value.widgetId, draft.value.previewHash);

    await records.update({ collection: 'signups', scope: 'shared', recordId: 'w2', data: { signups: 500 } });
    await flushDataChanged();
    const [row] = await db.select().from(widgets).where(eq(widgets.id, draft.value.widgetId));
    expect(row!.collection).toBe('signups');
    expect(row!.publishedHash).not.toBe(draft.value.previewHash);
    expect(row!.rows).toEqual([{ id: 'w1', signups: 240 }, { id: 'w2', signups: 500 }]);
    expect(row!.publishedSvgLight).toContain('height="100"');
    await withLiveDoc(documentId, (doc) => expect(readBlocks(doc, 'main')[1]!.props).toMatchObject({ hash: row!.publishedHash }));
  });
});
