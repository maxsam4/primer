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
// (live/merge.ts) and checkpointed. HTML stays on the version path until pages
// land.
import * as Y from 'yjs';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { PublishFormat, Reconciliation, Refusal } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { docUpdates, documents, threadPlacements, threads, versions } from '../db/schema.ts';
import { deleteBundle, quoteOf, renderBundle } from '../live/bundle.ts';
import { ensureSigningKey } from '../live/signing.ts';
import { captureState, writeCheckpoint } from '../live/checkpoint.ts';
import { anchorThreads, buildLiveDoc, importMarkdown, importText, type ImportResult } from '../live/import.ts';
import { mergeRepublish } from '../live/merge.ts';
import type { Storage } from '../storage/types.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { MAX_BYTES, MAX_DESCRIPTION, MAX_TITLE } from '../upload/validate.ts';
import { transactionWithEvents } from './events.ts';
import { canEdit, canRead, loadEffectiveRole, type Visibility } from './permissions.ts';
import { carryOpenThreads, loadCarryOrigins } from './threadCarry.ts';

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

export type PublishResult =
  | { ok: true; documentId: string; versionId: string; versionNumber: number; reconciliation?: Reconciliation }
  | { ok: false; status: 400 | 403 | 404 | 409; refusal: Refusal };

/** `details.error` keeps the REST error code clients already branch on. */
function refuse(
  status: 400 | 403 | 404 | 409,
  code: Refusal['code'],
  message: string,
  fix: string,
  restError: string = code,
): PublishResult {
  return { ok: false, status, refusal: { code, message, fix, details: { error: restError } } };
}

class StaleBase extends Error {
  constructor(readonly latest: number) {
    super('stale base');
  }
}

class Republish extends Error {}

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
      return republishLive(storage, input, doc.format, versionNote);
    }
  }

  const versionNote = input.versionNote?.trim() || null;
  if (versionNote !== null && versionNote.length > MAX_VERSION_NOTE) {
    return refuse(400, 'bad_request', `versionNote must be ≤${MAX_VERSION_NOTE} chars.`, 'Shorten the version note.', 'invalid_body');
  }

  if (input.format !== 'html') return publishLive(storage, input, { title: title!, description, versionNote });

  const transformed = transformHtml(new TextDecoder('utf-8').decode(input.content));
  if (!transformed.ok) return refuse(400, 'bad_request', transformed.message, 'Fix the content and publish again.', 'parse_failed');
  const rendered = { html: transformed.html };

  const documentId = existingId ?? uuidv7();
  const versionId = uuidv7();
  const storageKey = `v1/${versionId}.html`;
  const originalKey = `v1/${versionId}.orig`;
  const htmlBytes = new TextEncoder().encode(rendered.html);
  const origins = existingId === undefined ? new Map() : await loadCarryOrigins(storage, documentId);

  const cleanup = async () => {
    for (const key of [storageKey, originalKey]) {
      try { await storage.delete(key); } catch {}
    }
  };
  await storage.put(storageKey, htmlBytes);
  await storage.put(originalKey, input.content);

  let versionNumber: number;
  try {
    versionNumber = await transactionWithEvents(async (tx, emit) => {
      let next = 1;
      if (existingId === undefined) {
        await tx.insert(documents).values({ id: documentId, title: title!, description, uploaderId: actor.id });
      } else {
        next = (await lockForVersion(tx, documentId, input.baseVersionNumber)) + 1;
      }
      await tx.insert(versions).values({
        id: versionId,
        documentId,
        versionNumber: next,
        storageKey,
        sizeBytes: htmlBytes.byteLength,
        versionNote,
        originalKey,
        sourceFormat: input.format,
      });
      if (existingId !== undefined) {
        await carryOpenThreads(tx, storage, { documentId, versionId, html: rendered.html, origins });
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
  } catch (err) {
    await cleanup();
    return refusalFor(err, input.baseVersionNumber);
  }

  return { ok: true, documentId, versionId, versionNumber };
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

function refusalFor(err: unknown, base: number | undefined): PublishResult {
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

function formatRefusal(format: PublishFormat, live: string): PublishResult {
  return refuse(
    400,
    'bad_request',
    `This live document is ${live}; a ${format} version can't be merged into it.`,
    `Publish the document as ${live}, or edit it with primer_apply_ops.`,
  );
}

/**
 * A new Markdown or text version of a live document: merged three ways into
 * the live blocks (live/merge.ts), so people's edits and comments stay and
 * groups both sides changed become suggestions; then checkpointed as the new
 * version, with the uploaded file kept as its original.
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
  let imported: ImportResult;
  try {
    imported = live === 'markdown' ? await importMarkdown(source) : importText(source);
  } catch (err) {
    return refuse(400, 'bad_request', `Import failed: ${(err as Error).message}`, 'Fix the content and publish again.', 'parse_failed');
  }
  if (imported.blocks.length === 0) {
    return refuse(400, 'bad_request', 'Document body is empty.', 'Publish a file with some content.', 'parse_failed');
  }

  const reconciliation = await mergeRepublish(documentId, input.actor, imported);
  if (reconciliation.outcomes.some((o) => o.status === 'applied')) {
    await db.update(documents).set({ metadata: imported.metadata }).where(eq(documents.id, documentId));
  }
  const versionId = uuidv7();
  const originalKey = `v1/${versionId}.orig`;
  await storage.put(originalKey, input.content);
  try {
    const captured = await captureState(documentId, input.actor);
    const checkpoint = await writeCheckpoint(storage, documentId, input.actor, versionNote, captured, {
      versionId,
      originalKey,
      sourceFormat: live as 'markdown' | 'text',
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
): Promise<PublishResult> {
  const format = input.format as 'markdown' | 'text';
  const source = new TextDecoder('utf-8').decode(input.content);
  let imported: ImportResult;
  try {
    imported = format === 'markdown' ? await importMarkdown(source) : importText(source);
  } catch (err) {
    return refuse(400, 'bad_request', `Import failed: ${(err as Error).message}`, 'Fix the content and publish again.', 'parse_failed');
  }
  if (imported.blocks.length === 0) {
    return refuse(400, 'bad_request', 'Document body is empty.', 'Publish a file with some content.', 'parse_failed');
  }

  const existingId = input.documentId;
  const documentId = existingId ?? uuidv7();
  await ensureSigningKey(storage);
  const ydoc = buildLiveDoc(imported, format, documentId);
  const open = existingId === undefined ? [] : await openThreadQuotes(existingId);
  const anchored = anchorThreads(ydoc, open);
  const state = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();

  const versionId = uuidv7();
  const originalKey = `v1/${versionId}.orig`;
  await storage.put(originalKey, input.content);
  let bundle: Awaited<ReturnType<typeof renderBundle>>;
  try {
    bundle = await renderBundle(storage, { versionId, documentId, title: doc.title, state });
  } catch (err) {
    await storage.delete(originalKey).catch(() => undefined);
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
          metadata: imported.metadata,
        });
      } else {
        next = (await lockForVersion(tx, documentId, input.baseVersionNumber)) + 1;
        await tx.update(documents).set({ format, metadata: imported.metadata }).where(eq(documents.id, documentId));
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
    await storage.delete(originalKey).catch(() => undefined);
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
