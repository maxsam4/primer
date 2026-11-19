import * as Y from 'yjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { CheckpointResponse, Reconciliation } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, threadPlacements, threads, versions } from '../db/schema.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { effectiveAgentMode } from '../lib/permissions.ts';
import type { Storage } from '../storage/types.ts';
import { deleteBundle, loadBundleDoc, renderBundle } from './bundle.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { originFor } from './origin.ts';
import { persistedUpTo } from './persist.ts';
import { applyPlan, type PlannedEdit } from './pipeline.ts';
import { docQueue } from './queue.ts';
import { tabFragmentName, tabsOf, type Tab } from './reach.ts';
import { pmDocOf } from './sources.ts';

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
): Promise<CheckpointResponse> {
  return writeCheckpoint(storage, documentId, actor, note, await captureState(documentId, actor));
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
  original?: { versionId: string; originalKey: string; sourceFormat: 'markdown' | 'text' },
): Promise<CheckpointResponse> {
  const [doc] = await db.select({ title: documents.title }).from(documents).where(eq(documents.id, documentId));
  const versionId = original?.versionId ?? uuidv7();
  const bundle = await renderBundle(storage, { versionId, documentId, title: doc?.title ?? '', state: captured.state });
  const marked = markedThreads(captured.state);
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
        ...(original ? { originalKey: original.originalKey, sourceFormat: original.sourceFormat } : {}),
      });
      // Open threads stay listed on the checkpoint: anchored where their
      // comment mark is in the captured content, orphaned elsewhere.
      const open = await tx
        .select({ id: threads.id, anchor: threads.anchor })
        .from(threads)
        .where(and(eq(threads.documentId, documentId), isNull(threads.resolvedAt)));
      for (const thread of open) {
        await tx.insert(threadPlacements).values({ threadId: thread.id, versionId, anchor: marked.has(thread.id) ? thread.anchor : null });
      }
      emit({
        documentId,
        versionId,
        actorId: actor.id,
        type: 'version.published',
        payload: { document_id: documentId, version_id: versionId, number: next, author_id: actor.id },
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
    // The tab list is no block edit, so it can't be suggested: an agent that
    // only suggests (the pipeline turns its edits below into suggestions)
    // leaves it as it is.
    if ((await effectiveAgentMode(checkpoint.documentId, actor.id)) === 'edit') {
      await restoreTabs(checkpoint.documentId, tabsOf(frozen), actor);
    }
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
    return await applyPlan(checkpoint.documentId, originFor(actor), { onConflict: 'refuse', edits });
  } finally {
    frozen.destroy();
  }
}

/** Thread ids whose comment mark is in a state's tabs. */
export function markedThreads(state: Uint8Array): Set<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const ids = new Set<string>();
  for (const tab of tabsOf(doc)) {
    pmDocOf(doc.getXmlFragment(tabFragmentName(tab.id))).descendants((node) => {
      for (const mark of node.marks) if (mark.type.name === 'comment' && !mark.attrs.orphan) ids.add(mark.attrs.threadId as string);
    });
  }
  doc.destroy();
  return ids;
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
