import * as Y from 'yjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { isLiveAnchor, type CheckpointResponse, type DataPointAnchor, type Reconciliation, type WidgetPartAnchor } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, threadPlacements, threads, versions } from '../db/schema.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { effectiveAgentMode } from '../lib/permissions.ts';
import type { Storage } from '../storage/types.ts';
import { deleteBundle, loadBundleDoc, renderBundle } from './bundle.ts';
import { liveDocName, liveInstance, withLiveDocument } from './instance.ts';
import { originFor } from './origin.ts';
import { persistedUpTo } from './persist.ts';
import { applyPlan, type PlannedEdit } from './pipeline.ts';
import { docQueue } from './queue.ts';
import { fragmentName, isTabFragment, reachableFragments, tabFragmentName, tabsOf, targetOfFragment, type Tab } from './reach.ts';
import { redrawBoundWidgets, restoreWidgets, widgetsChangedSince } from '../widgets/bundle.ts';
import { widgetAnchorPublished } from '../widgets/anchors.ts';
import { pmDocOf, rewriteSources, trustedMeta, trustedSources } from './sources.ts';
import { splitFrontMatter } from '../upload/markdown.ts';

/** A live document's state frozen at one docVersion. */
export type CapturedState = { state: Uint8Array; docVersion: number };

/**
 * Freezes the live state on the document's queue: the encoding is synchronous,
 * so every update in it was queued for storage before this job, and nothing
 * applied later can slip in. The docVersion is awaited outside the job (an
 * insert queued behind the job would otherwise wait on it forever).
 */
export async function captureState(documentId: string, actor: AuthUser): Promise<CapturedState> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), originFor(actor));
  try {
    const doc = connection.document!;
    const captured = await docQueue(documentId)(async () => ({
      state: Y.encodeStateAsUpdate(doc),
      stored: persistedUpTo(doc),
    }));
    return { state: captured.state, docVersion: await captured.stored };
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}

/** A checkpoint: the live state now, as a new version with its bundle. */
export async function createCheckpoint(
  storage: Storage,
  documentId: string,
  actor: AuthUser,
  note: string | null,
  opts: { automatic?: boolean } = {},
): Promise<CheckpointResponse> {
  return writeCheckpoint(storage, documentId, actor, note, await captureState(documentId, actor), undefined, opts);
}

/**
 * The latest checkpoint's number when no one edited the content after it
 * (comment marks and system writes change no content); else null. A document
 * with no live checkpoint yet has changed. Records and comments aren't
 * content: a checkpoint still freezes them.
 */
export async function contentUnchangedSince(documentId: string): Promise<number | null> {
  // Edits still queued for storage count: wait for them.
  await withLiveDocument(documentId, (doc) => persistedUpTo(doc));
  const [latest] = (await db.execute(sql`
    SELECT id, version_number AS "versionNumber", doc_version AS "docVersion"
      FROM versions WHERE document_id = ${documentId}
     ORDER BY version_number DESC LIMIT 1
  `)) as unknown as { id: string; versionNumber: number; docVersion: number | string | null }[];
  if (!latest || latest.docVersion === null) return null;
  const docVersion = Number(latest.docVersion);
  const [edit] = (await db.execute(sql`
    SELECT 1 FROM doc_updates
     WHERE document_id = ${documentId} AND id > ${docVersion}
       AND actor_id IS NOT NULL AND touched <> '{}'::text[]
     LIMIT 1
  `)) as unknown as unknown[];
  return edit ? null : latest.versionNumber;
}

/**
 * Renders the bundle from a captured state (outside the queue, so editing
 * goes on meanwhile) and then adds the version row.
 */
export async function writeCheckpoint(
  storage: Storage,
  documentId: string,
  actor: AuthUser,
  note: string | null,
  captured: CapturedState,
  /** A republish: the uploaded file, kept with the version. */
  original?: { versionId: string; originalKey: string; sourceFormat: 'markdown' | 'text' | 'html' },
  opts: { automatic?: boolean } = {},
): Promise<CheckpointResponse> {
  const [doc] = await db.select({ title: documents.title }).from(documents).where(eq(documents.id, documentId));
  const versionId = original?.versionId ?? uuidv7();
  const bundle = await renderBundle(storage, { versionId, documentId, title: doc?.title ?? '', state: captured.state });
  const anchored = anchoredIn(captured.state);
  try {
    const versionNumber = await transactionWithEvents(async (tx, emit) => {
      await tx.execute(sql`SELECT id FROM documents WHERE id = ${documentId} FOR UPDATE`);
      const [row] = (await tx.execute(sql`
        SELECT COALESCE(MAX(version_number), 0)::int AS latest FROM versions WHERE document_id = ${documentId}
      `)) as unknown as { latest: number }[];
      const next = (row?.latest ?? 0) + 1;
      await tx.insert(versions).values({
        id: versionId,
        documentId,
        versionNumber: next,
        storageKey: bundle.staticKey,
        sizeBytes: bundle.staticBytes,
        versionNote: note,
        bundleKey: bundle.bundleKey,
        docVersion: captured.docVersion,
        automatic: opts.automatic ?? false,
        ...(original ? { originalKey: original.originalKey, sourceFormat: original.sourceFormat } : {}),
      });
      // Open threads stay listed on the checkpoint: anchored where the
      // captured content has their anchor, orphaned elsewhere.
      const open = await tx
        .select({ id: threads.id, anchor: threads.anchor })
        .from(threads)
        .where(and(eq(threads.documentId, documentId), isNull(threads.resolvedAt)));
      for (const thread of open) {
        const anchor = thread.anchor as WidgetPartAnchor | DataPointAnchor;
        const drawn = anchor.type !== 'widget-part' && anchor.type !== 'data-point' ? true : await widgetAnchorPublished(documentId, anchor);
        const placed = anchored(thread) && drawn;
        await tx.insert(threadPlacements).values({ threadId: thread.id, versionId, anchor: placed ? thread.anchor : null });
      }
      emit({
        documentId,
        versionId,
        actorId: actor.id,
        type: 'version.published',
        payload: {
          document_id: documentId,
          version_id: versionId,
          number: next,
          author_id: actor.id,
          ...(opts.automatic ? { automatic: true } : {}),
        },
      });
      return next;
    });
    return { versionId, versionNumber, docVersion: captured.docVersion };
  } catch (err) {
    await deleteBundle(storage, bundle.bundleKey);
    throw err;
  }
}

/**
 * Restores a checkpoint as a new edit by `actor` (C12 restore column): every
 * tab's content is replaced by the bundle's through the pipeline, which
 * writes only what differs, so untouched blocks keep their Yjs identity and
 * marks. Later history stays: the restore is one more update. The tab list
 * is restored first (a tab deleted since comes back, one added since goes),
 * as an edit by the same person.
 */
export async function restoreCheckpoint(
  storage: Storage,
  checkpoint: { documentId: string; bundleKey: string },
  actor: AuthUser,
): Promise<Reconciliation> {
  const frozen = await loadBundleDoc(storage, checkpoint.bundleKey);
  try {
    // One decision for the whole restore. The tab list and import provenance
    // are no block edits, so they can't be suggested: an agent that only
    // suggests gets the content as suggestions and leaves them as they are.
    // Nor can a published widget, and accepting its block alone would point
    // the block at a publish that isn't there, so such a restore is refused.
    const suggesting = (await effectiveAgentMode(checkpoint.documentId, actor.id)) === 'suggest';
    if (!suggesting) await restoreTabs(checkpoint.documentId, tabsOf(frozen), actor);
    // The import provenance (front matter, verbatim source slices) comes back
    // with the content, in the same write.
    const sources = trustedSources(frozen, checkpoint.documentId);
    const meta = trustedMeta(frozen, checkpoint.documentId);
    let restoredMeta = false;
    const edits: PlannedEdit[] = tabsOf(frozen).map((tab) => {
      const content = pmDocOf(frozen.getXmlFragment(tabFragmentName(tab.id))).content;
      return {
        target: { tabId: tab.id, blockId: '' },
        inverse: false,
        build: (tr) => {
          tr.replaceWith(0, tr.doc.content.size, content);
        },
      };
    });
    // The sub-fragments the restored content reaches (widget labels) come back too.
    for (const name of reachableFragments(frozen).filter((n) => !isTabFragment(n))) {
      const target = targetOfFragment(name)!;
      const content = pmDocOf(frozen.getXmlFragment(name)).content;
      edits.push({ target, inverse: false, build: (tr) => void tr.replaceWith(0, tr.doc.content.size, content) });
    }
    // Widget rows first, as a publish does: viewers refetch when the block's hash changes.
    if (!suggesting) await restoreWidgets(storage, checkpoint.bundleKey, frozen, checkpoint.documentId);
    const out = await applyPlan(checkpoint.documentId, originFor(actor), {
      onConflict: 'refuse',
      ...(suggesting
        ? {
            mode: 'suggest' as const,
            guard: async () =>
              (await widgetsChangedSince(frozen, checkpoint.documentId))
                ? {
                    code: 'forbidden' as const,
                    message: 'This version has widgets that were published differently since; an agent that may only suggest cannot restore them.',
                    fix: 'Ask a person who edits the document to restore this version.',
                  }
                : null,
          }
        : {}),
      edits,
      alsoWrite: (doc, outcomes) => {
        if (suggesting || outcomes.some((o) => o.status === 'conflict')) return;
        rewriteSources(doc, checkpoint.documentId, sources, { ...meta, format: trustedMeta(doc, checkpoint.documentId).format });
        restoredMeta = true;
      },
      afterWrite: async () => {
        if (!restoredMeta) return;
        const metadata = meta.frontMatter ? splitFrontMatter(meta.frontMatter).data : {};
        await db.update(documents).set({ metadata }).where(eq(documents.id, checkpoint.documentId));
      },
    });
    if (!suggesting) await redrawBoundWidgets(checkpoint.documentId);
    return out;
  } finally {
    frozen.destroy();
  }
}

/**
 * Which open threads a captured state anchors, by the rules live anchoring
 * uses: a marked thread (prose, or carried over from before the document
 * went live) while its comment mark is in reachable content (tab, page text,
 * embed and widget label fragments), a structured one (block, widget part,
 * data point) while its target is; a widget part or data point also needs
 * the published widget to draw it (writeCheckpoint checks that).
 */
export function anchoredIn(state: Uint8Array): (thread: { id: string; anchor: unknown }) => boolean {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const marked = new Set<string>();
  // Reachable fragment names, and `<fragment> <blockId>` for their blocks.
  const present = new Set<string>();
  for (const name of reachableFragments(doc)) {
    present.add(name);
    pmDocOf(doc.getXmlFragment(name)).descendants((node) => {
      if (node.type.isInGroup('bnBlock')) present.add(`${name} ${node.attrs.id as string}`);
      for (const mark of node.marks) if (mark.type.name === 'comment' && !mark.attrs.orphan) marked.add(mark.attrs.threadId as string);
    });
  }
  doc.destroy();
  return ({ id, anchor }) => {
    if (marked.has(id)) return true;
    if (!isLiveAnchor(anchor) || anchor.type === 'prose') return false;
    const name = fragmentName(anchor.target);
    return present.has(isTabFragment(name) ? `${name} ${anchor.target.blockId}` : name);
  };
}

/** Sets the live tab list to `tabs` when it differs. The pipeline writes
 *  fragments only, so the list is written in its own transaction. */
async function restoreTabs(documentId: string, tabs: Tab[], actor: AuthUser): Promise<void> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), originFor(actor));
  try {
    const doc = connection.document!;
    if (JSON.stringify(tabsOf(doc)) === JSON.stringify(tabs)) return;
    await docQueue(documentId)(() =>
      connection.transact(() => {
        const array = doc.getArray<Tab>('tabs');
        array.delete(0, array.length);
        array.push(tabs);
      }),
    );
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}
