// The one publish path. REST (`POST /api/upload`, `POST
// /api/documents/:docId/versions`) and MCP (`primer_create_document`,
// `primer_add_version`) are thin adapters over `publishDocument`, so the two
// can't drift.
//
// Every publish keeps the uploaded bytes verbatim (`v1/<versionId>.orig`)
// next to the rendered HTML. The new version number and the optional
// `baseVersionNumber` check run inside the transaction, after locking the
// document row, so two publishes on the same base can't both win.
//
// The version row, the carried threads and `primer.version.published` commit
// together. Carried placements emit no event of their own: they are part of
// the version, and a reader that sees version.published lists the new
// version's threads.
//
// Markdown and text publish live documents (M2b): the import is built as a
// detached Y.Doc and stored as the document's first update, together with the
// document, checkpoint 1 and its render bundle. A legacy document that gets a
// Markdown or text version becomes live the same way; its open threads are
// re-anchored by quote, and those whose quote isn't found are orphaned. A
// Markdown or text version of a live document is merged three ways into it
// (live/merge.ts) and checkpointed, unless the merge applied nothing (e.g. an
// agent in suggest mode, whose changes all become suggestions): then no
// version is made and the result carries only the reconciliation. HTML
// publishes the same way as a live page document (page/publish.ts): one page
// block over the stamped upload, whose republishes carry people's text over.
// Legacy documents keep their versions and render them as before; their next
// version makes them live, unless an agent in suggest mode publishes it.
import * as Y from 'yjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { PublishFormat, Reconciliation, Refusal } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { docUpdates, documents, threadPlacements, threads, versions } from '../db/schema.ts';
import { deleteBundle, quoteOf, renderBundle } from '../live/bundle.ts';
import { captureState, writeCheckpoint } from '../live/checkpoint.ts';
import { anchorThreads, buildLiveDoc, importMarkdown, importText, type ImportResult } from '../live/import.ts';
import { mergeRepublish } from '../live/merge.ts';
import type { Storage } from '../storage/types.ts';
import { anchorPageThreads, buildPageDoc, preparePage, sourceKeyOf, republishPage } from '../page/publish.ts';
import { MAX_BYTES, MAX_DESCRIPTION, MAX_TITLE } from '../upload/validate.ts';
import { transactionWithEvents } from './events.ts';
import { canEdit, canRead, effectiveAgentMode, loadEffectiveRole, type Visibility } from './permissions.ts';

export const MAX_VERSION_NOTE = 500;

export interface PublishInput {
  actor: AuthUser;
  /** Absent: create a new document (needs `title`). Present: add a version. */
  documentId?: string;
  title?: string;
  description?: string | null;
  content: Uint8Array;
  filename: string;
  format: PublishFormat;
  versionNote?: string | null;
  /** The version the caller read. When set and the document has moved on,
   *  the publish is refused with `stale_base`. */
  baseVersionNumber?: number;
}

export type Published = { ok: true; documentId: string; versionId: string; versionNumber: number; reconciliation?: Reconciliation };
/** A republish onto a live document that applied nothing (an agent in suggest
 *  mode, or no change): no new version, only what became of each group. */
export type Suggested = { ok: true; documentId: string; versionId?: never; versionNumber?: never; reconciliation: Reconciliation };
export type Refused = { ok: false; status: 400 | 403 | 404 | 409; refusal: Refusal };
export type PublishResult = Published | Suggested | Refused;

/** `details.error` keeps the REST error code clients already branch on. */
function refuse(
  status: 400 | 403 | 404 | 409,
  code: Refusal['code'],
  message: string,
  fix: string,
  restError: string = code,
): Refused {
  return { ok: false, status, refusal: { code, message, fix, details: { error: restError } } };
}

class StaleBase extends Error {
  constructor(readonly latest: number) {
    super('stale base');
  }
}

class Republish extends Error {}

/** A new document always gets version 1. */
export function publishDocument(storage: Storage, input: PublishInput & { documentId?: undefined }): Promise<Published | Refused>;
export function publishDocument(storage: Storage, input: PublishInput): Promise<PublishResult>;
export async function publishDocument(storage: Storage, input: PublishInput): Promise<PublishResult> {
  const { actor, documentId: existingId } = input;

  if (input.content.byteLength > MAX_BYTES) {
    return refuse(400, 'bad_request', `File exceeds the ${MAX_BYTES}-byte limit.`, 'Publish a smaller file.', 'too_large');
  }

  let title: string | undefined;
  let description: string | null = null;
  if (existingId === undefined) {
    title = (input.title ?? '').trim();
    if (title.length === 0 || title.length > MAX_TITLE) {
      return refuse(400, 'bad_request', `Title must be 1–${MAX_TITLE} characters.`, 'Pass a non-empty title.', 'missing_title');
    }
    description = input.description?.trim() || null;
    if (description !== null && description.length > MAX_DESCRIPTION) {
      return refuse(400, 'bad_request', `Description must be ${MAX_DESCRIPTION} characters or fewer.`, 'Shorten the description.', 'validation_failed');
    }
  } else {
    const [doc] = await db
      .select({
        uploaderId: documents.uploaderId,
        visibility: documents.visibility,
        deletedAt: documents.deletedAt,
        format: documents.format,
        title: documents.title,
      })
      .from(documents)
      .where(eq(documents.id, existingId));
    const notFound = refuse(404, 'not_found', 'Document not found.', 'Check the document id, or create a new document.');
    if (!doc || doc.deletedAt !== null) return notFound;
    const eff = await loadEffectiveRole({ id: existingId, uploaderId: doc.uploaderId, visibility: doc.visibility as Visibility }, actor);
    if (!canRead(doc.visibility as Visibility, eff)) return notFound;
    if (!canEdit(eff)) {
      return refuse(403, 'forbidden', 'Only the document owner or an editor can add versions.', 'Ask the owner for editor access, or leave a comment instead.');
    }
    title = doc.title;
    if (doc.format !== null) {
      const versionNote = input.versionNote?.trim() || null;
      if (versionNote !== null && versionNote.length > MAX_VERSION_NOTE) {
        return refuse(400, 'bad_request', `versionNote must be ≤${MAX_VERSION_NOTE} chars.`, 'Shorten the version note.', 'invalid_body');
      }
      return republishing(existingId, () => republishLive(storage, input, doc.format!, versionNote));
    }
    // Making a legacy document live replaces what it shows: an agent that may
    // only suggest here can't, since there is nothing to suggest against.
    if (actor.kind === 'agent' && (await effectiveAgentMode(existingId, actor.id)) === 'suggest') {
      return refuse(
        403,
        'forbidden',
        'This document predates live documents, and you may only suggest changes to it.',
        'Comment with your proposed version instead, or ask the owner to publish it or to switch your mode to edit.',
      );
    }
  }

  const versionNote = input.versionNote?.trim() || null;
  if (versionNote !== null && versionNote.length > MAX_VERSION_NOTE) {
    return refuse(400, 'bad_request', `versionNote must be ≤${MAX_VERSION_NOTE} chars.`, 'Shorten the version note.', 'invalid_body');
  }

  return publishLive(storage, input, { title: title!, description, versionNote });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Locks the document row and returns its latest version number, refusing a
 *  stale base and a document that went live meanwhile. */
async function lockForVersion(tx: Tx, documentId: string, base: number | undefined): Promise<number> {
  const [doc] = (await tx.execute(sql`SELECT format FROM documents WHERE id = ${documentId} FOR UPDATE`)) as unknown as {
    format: string | null;
  }[];
  if (doc?.format) throw new Republish();
  const [row] = (await tx.execute(sql`
    SELECT COALESCE(MAX(version_number), 0)::int AS latest FROM versions WHERE document_id = ${documentId}
  `)) as unknown as { latest: number }[];
  const latest = row?.latest ?? 0;
  if (base !== undefined && base !== latest) throw new StaleBase(latest);
  return latest;
}

function refusalFor(err: unknown, base: number | undefined): Refused {
  if (err instanceof StaleBase) {
    return refuse(
      409,
      'stale_base',
      `The document is at version ${err.latest}, not ${base}.`,
      `Read version ${err.latest}, merge your changes into it, and publish again with baseVersionNumber ${err.latest}.`,
    );
  }
  if (err instanceof Republish) return formatRefusal('html', 'markdown');
  throw err;
}

function formatRefusal(format: PublishFormat, live: string): Refused {
  return refuse(
    400,
    'bad_request',
    `This live document is ${live}; a ${format} version can't be merged into it.`,
    `Publish the document as ${live}, or edit it with primer_apply_ops.`,
  );
}

const republishTails = new Map<string, Promise<unknown>>();

/**
 * Runs a document's republishes one at a time, so the base-version check,
 * the merge and the checkpoint of one never interleave with another's: two
 * publishes on the same base can't both win. In-process, like docQueue
 * (Primer runs one API instance); not the document queue itself, since the
 * merge's applyPlan runs on that.
 */
function republishing<T>(documentId: string, job: () => Promise<T>): Promise<T> {
  const run = (republishTails.get(documentId) ?? Promise.resolve()).then(job, job);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  republishTails.set(documentId, tail);
  void tail.then(() => {
    if (republishTails.get(documentId) === tail) republishTails.delete(documentId);
  });
  return run;
}

/**
 * A new Markdown or text version of a live document: merged three ways into
 * the live blocks (live/merge.ts), so people's edits and comments stay and
 * groups both sides changed become suggestions; then checkpointed as the new
 * version, with the uploaded file kept as its original. When nothing was
 * applied (an agent in suggest mode gets every change as a suggestion), the
 * live document is unchanged, so no original is stored and no checkpoint
 * written: an agent's suggestions never become the published version.
 */
async function republishLive(
  storage: Storage,
  input: PublishInput,
  live: string,
  versionNote: string | null,
): Promise<PublishResult> {
  const documentId = input.documentId!;
  if (input.format !== live) return formatRefusal(input.format, live);
  if (input.baseVersionNumber !== undefined) {
    const [row] = (await db.execute(sql`
      SELECT COALESCE(MAX(version_number), 0)::int AS latest FROM versions WHERE document_id = ${documentId}
    `)) as unknown as { latest: number }[];
    if ((row?.latest ?? 0) !== input.baseVersionNumber) return refusalFor(new StaleBase(row?.latest ?? 0), input.baseVersionNumber);
  }
  const source = new TextDecoder('utf-8').decode(input.content);
  const versionId = uuidv7();
  let reconciliation: Reconciliation;
  if (live === 'html') {
    const out = await republishPage(storage, documentId, input.actor, source, versionId);
    if ('refusal' in out) return { ok: false, status: out.refusal.code === 'not_found' ? 404 : 400, refusal: out.refusal };
    reconciliation = out.reconciliation;
  } else {
    let imported: ImportResult;
    try {
      imported = live === 'markdown' ? await importMarkdown(source) : importText(source);
    } catch (err) {
      return refuse(400, 'bad_request', `Import failed: ${(err as Error).message}`, 'Fix the content and publish again.', 'parse_failed');
    }
    if (imported.blocks.length === 0) {
      return refuse(400, 'bad_request', 'Document body is empty.', 'Publish a file with some content.', 'parse_failed');
    }
    reconciliation = await mergeRepublish(documentId, input.actor, imported);
    if (reconciliation.outcomes.some((o) => o.status === 'applied')) {
      await db.update(documents).set({ metadata: imported.metadata }).where(eq(documents.id, documentId));
    }
  }
  if (!reconciliation.outcomes.some((o) => o.status === 'applied')) return { ok: true, documentId, reconciliation };
  const originalKey = `v1/${versionId}.orig`;
  await storage.put(originalKey, input.content);
  try {
    const captured = await captureState(documentId, input.actor);
    const checkpoint = await writeCheckpoint(storage, documentId, input.actor, versionNote, captured, {
      versionId,
      originalKey,
      sourceFormat: live as PublishFormat,
    });
    return { ok: true, documentId, versionId: checkpoint.versionId, versionNumber: checkpoint.versionNumber, reconciliation };
  } catch (err) {
    await storage.delete(originalKey).catch(() => undefined);
    throw err;
  }
}

/**
 * A Markdown or text publish: a new live document, or a legacy document
 * becoming live. Everything is built detached first (import, Y.Doc, thread
 * marks, bundle); then the document, its first update and checkpoint 1 commit
 * together, so nobody can open the live document half made.
 */
async function publishLive(
  storage: Storage,
  input: PublishInput,
  doc: { title: string; description: string | null; versionNote: string | null },
): Promise<Published | Refused> {
  const format = input.format;
  const source = new TextDecoder('utf-8').decode(input.content);
  if (source.trim().length === 0) {
    return refuse(400, 'bad_request', 'Document body is empty.', 'Publish a file with some content.', 'parse_failed');
  }
  const existingId = input.documentId;
  const documentId = existingId ?? uuidv7();
  const open = existingId === undefined ? [] : await openThreadQuotes(existingId);
  const versionId = uuidv7();
  const written: string[] = [];
  let ydoc: Y.Doc;
  let anchored: Set<string>;
  let metadata: Record<string, unknown> = {};
  if (format === 'html') {
    const page = preparePage(source);
    if ('refusal' in page) return { ok: false, status: 400, refusal: page.refusal };
    const sourceKey = sourceKeyOf(documentId, versionId);
    await storage.put(sourceKey, new TextEncoder().encode(page.stamped));
    written.push(sourceKey);
    const built = await buildPageDoc(documentId, doc.title, page, sourceKey);
    ydoc = built.doc;
    anchored = anchorPageThreads(ydoc, built.blockId, page, open);
  } else {
    let imported: ImportResult;
    try {
      imported = format === 'markdown' ? await importMarkdown(source) : importText(source);
    } catch (err) {
      return refuse(400, 'bad_request', `Import failed: ${(err as Error).message}`, 'Fix the content and publish again.', 'parse_failed');
    }
    if (imported.blocks.length === 0) {
      return refuse(400, 'bad_request', 'Document body is empty.', 'Publish a file with some content.', 'parse_failed');
    }
    metadata = imported.metadata;
    ydoc = buildLiveDoc(imported, format, documentId);
    anchored = anchorThreads(ydoc, open);
  }
  const state = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();

  const originalKey = `v1/${versionId}.orig`;
  await storage.put(originalKey, input.content);
  written.push(originalKey);
  const cleanup = async () => {
    for (const key of written) await storage.delete(key).catch(() => undefined);
  };
  let bundle: Awaited<ReturnType<typeof renderBundle>>;
  try {
    bundle = await renderBundle(storage, { versionId, documentId, title: doc.title, state });
  } catch (err) {
    await cleanup();
    throw err;
  }

  let versionNumber: number;
  try {
    versionNumber = await transactionWithEvents(async (tx, emit) => {
      let next = 1;
      if (existingId === undefined) {
        await tx.insert(documents).values({
          id: documentId,
          title: doc.title,
          description: doc.description,
          uploaderId: input.actor.id,
          format,
          metadata,
        });
      } else {
        next = (await lockForVersion(tx, documentId, input.baseVersionNumber)) + 1;
        await tx.update(documents).set({ format, metadata }).where(eq(documents.id, documentId));
      }
      // The import is the system's first update: docVersion 1 of the log.
      const [first] = await tx
        .insert(docUpdates)
        .values({ documentId, update: state, actorId: null, runId: null, touched: [] })
        .returning({ id: docUpdates.id });
      await tx.insert(versions).values({
        id: versionId,
        documentId,
        versionNumber: next,
        storageKey: bundle.staticKey,
        sizeBytes: bundle.staticBytes,
        versionNote: doc.versionNote,
        originalKey,
        sourceFormat: format,
        bundleKey: bundle.bundleKey,
        docVersion: first!.id,
      });
      // Converted threads stay listed on the new version: anchored where
      // their quote was found, "context changed" (orphaned) elsewhere.
      for (const thread of open) {
        await tx.insert(threadPlacements).values({
          threadId: thread.threadId,
          versionId,
          anchor: anchored.has(thread.threadId) ? thread.anchor : null,
        });
      }
      emit({
        documentId,
        versionId,
        actorId: input.actor.id,
        type: 'version.published',
        payload: { document_id: documentId, version_id: versionId, number: next, author_id: input.actor.id },
      });
      return next;
    });
  } catch (err) {
    await deleteBundle(storage, bundle.bundleKey);
    await cleanup();
    return refusalFor(err, input.baseVersionNumber);
  }
  return { ok: true, documentId, versionId, versionNumber };
}

async function openThreadQuotes(documentId: string) {
  const rows = await db
    .select({ threadId: threads.id, anchor: threads.anchor })
    .from(threads)
    .where(and(eq(threads.documentId, documentId), isNull(threads.resolvedAt)));
  return rows.map((r) => ({ ...r, quote: quoteOf(r.anchor) }));
}
