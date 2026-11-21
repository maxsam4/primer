import * as Y from 'yjs';
import { Node as PmNode } from '@tiptap/pm/model';
import type { Transform } from '@tiptap/pm/transform';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Refusal } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { commentReactions, comments, docFiles, docUpdates, documents, threads, versions, widgets } from '../db/schema.ts';
import { readableLiveDoc } from '../lib/liveThreads.ts';
import { logger } from '../logger.ts';
import type { Storage } from '../storage/types.ts';
import { blockVersion } from './blocks.ts';
import { referencedFiles } from './bundle.ts';
import { captureState, writeCheckpoint } from './checkpoint.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { fragmentDoc } from './marks.ts';
import { applyPlan, contentVersion, indexBlocks, type PlannedEdit } from './pipeline.ts';
import { isOwnSourceKey, sourceKeyOf } from '../page/publish.ts';
import { isTabFragment, pageBlocks, reachableFragments, tabFragmentName, tabsOf, targetOfFragment } from './reach.ts';
import { rewriteSources, trustedMeta, trustedSources } from './sources.ts';
import { rebuildTaskIndex } from './tasks.ts';
import { widgetBlocks } from '../widgets/bundle.ts';
import { renderBoth, widgetIdPrefix } from '../widgets/render.ts';

export type CopyResult = { ok: true; documentId: string } | { ok: false; status: 400 | 404; refusal: Refusal };

/**
 * What a copy keeps (C12):
 * - `branch`: a private draft of the source, proposed back later
 *   (live/branch.ts). Comment marks stay, re-pointed at copies of their
 *   threads (with comments and reactions); open suggestions are copied; the
 *   source's state at this moment is kept as the branch's base.
 * - `fork`: a new document of its own (a remix, or "New from template").
 *   Comment marks are stripped and no threads or suggestions come along;
 *   shared records do, personal ones don't.
 * Both copy the files the content references (new ids, `primer-blob://`
 * rewritten), the mentions already announced (so nobody is told again) and
 * the latest original as checkpoint 1's. The Y.Doc is copied as state, so
 * block ids and CRDT identity are kept, and with them every fragment: tabs,
 * page text, embeds and widget labels. Comment marks in all of them follow
 * the policy above.
 * - Widgets: each widget block gets a copy of its `widgets` row under a new
 *   id (published source, rows and records binding; a pending draft stays
 *   with the source), rendered again under that id so the copy's hash and
 *   svg ids are its own. Their threads need nothing more: a widget part or
 *   data point is anchored by block id, which a copy keeps.
 */
export type CopyKind = 'branch' | 'fork';

const MAX_TITLE = 200;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export async function copyDocument(
  storage: Storage,
  actor: AuthUser,
  sourceId: string,
  kind: CopyKind,
  rawTitle?: unknown,
): Promise<CopyResult> {
  const notFound: CopyResult = {
    ok: false,
    status: 404,
    refusal: { code: 'not_found', message: 'Live document not found.', fix: 'Check the document id; only live documents can be branched or forked.' },
  };
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) return notFound;
  const source = await readableLiveDoc(sourceId, actor);
  if (!source) return notFound;
  if (rawTitle !== undefined && typeof rawTitle !== 'string') {
    return { ok: false, status: 400, refusal: { code: 'bad_request', message: 'title must be a string.', fix: 'Pass a title, or leave it out.' } };
  }
  const title = (typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : `${source.title} (${kind === 'branch' ? 'branch' : 'copy'})`).slice(0, MAX_TITLE);
  const [row] = await db
    .select({ description: documents.description, format: documents.format, metadata: documents.metadata })
    .from(documents)
    .where(eq(documents.id, sourceId));

  const captured = await captureState(sourceId, actor);
  const documentId = uuidv7();

  // The copy's first update: the source's state, with only what the server
  // signed for the source signed again for the copy.
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, captured.state);
  rewriteSources(ydoc, documentId, trustedSources(ydoc, sourceId), { ...trustedMeta(ydoc, sourceId), format: row!.format! });
  const state = Y.encodeStateAsUpdate(ydoc);

  // Ids that change (source id → copy id). Files are only this document's
  // own: block props are editor-writable.
  const ids = new Map<string, string>();
  const files = await copyFiles(storage, sourceId, documentId, await referencedFiles(ydoc, sourceId), ids);
  // The latest original is checkpoint 1's; a page's stamped source is keyed by
  // that checkpoint's id, which is where purging looks for it.
  const original = await copyOriginal(storage, sourceId);
  const firstVersionId = original?.versionId ?? uuidv7();
  const pageSources = await copyPageSources(storage, sourceId, documentId, pageBlocks(ydoc), firstVersionId);
  const widgetHashes = new Map<string, string>();
  const widgetRows = await copyWidgets(sourceId, documentId, widgetBlocks(ydoc), ids, widgetHashes);
  const tabs = tabsOf(ydoc);
  // Page text, embed and widget label fragments: their marks follow the policy too.
  const subFragments = reachableFragments(ydoc).filter((name) => !isTabFragment(name));
  const sourceBlocks = new Map<string, PmNode>();
  if (files.length > 0) {
    for (const tab of tabs) for (const [id, b] of indexBlocks(fragmentDoc(ydoc.getXmlFragment(tabFragmentName(tab.id))))) sourceBlocks.set(id, b.node);
  }
  ydoc.destroy();
  const rewrite = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(UUID, (id) => ids.get(id.toLowerCase()) ?? id)) as T;
  // A suggestion's `base` is a hash of the block it was made against; the
  // rewrite changes file links inside it, so the hash is taken again.
  const rewriteEdits = (edits: unknown): unknown =>
    (rewrite(edits) as { target: { blockId: string }; base: string | null }[]).map((e) => {
      const node = e.base ? sourceBlocks.get(e.target.blockId) : undefined;
      if (!node) return e;
      const moved = PmNode.fromJSON(node.type.schema, rewrite(node.toJSON()));
      const base = e.base === contentVersion(node) ? contentVersion(moved) : e.base === blockVersion(node) ? blockVersion(moved) : e.base;
      return { ...e, base };
    });

  await db.transaction(async (tx) => {
    await tx.insert(documents).values({
      id: documentId,
      title,
      description: row!.description,
      uploaderId: actor.id,
      // A branch is private to its creator; a fork stays as private as its source.
      visibility: kind === 'branch' ? 'private' : source.visibility,
      format: row!.format,
      metadata: row!.metadata,
      ...(kind === 'branch'
        ? { branchOf: sourceId, branchBaseState: captured.state, branchBaseDocVersion: captured.docVersion }
        : { forkedFrom: sourceId }),
    });
    await tx.insert(docUpdates).values({ documentId, update: state, actorId: null, runId: null, touched: [] });
    if (files.length > 0) await tx.insert(docFiles).values(files);
    if (widgetRows.length > 0) await tx.insert(widgets).values(widgetRows);
    if (kind === 'branch') {
      await copyThreads(tx, sourceId, documentId, ids);
      await copySuggestions(tx, sourceId, documentId, ids, rewriteEdits);
      await tx.execute(sql`
        INSERT INTO doc_decisions (document_id, block_id, decision_id, option_id, question, option_label, rationale, evidence, open_questions, decided_by, decided_at, archived_at)
        SELECT ${documentId}, block_id, decision_id, option_id, question, option_label, rationale, evidence, open_questions, decided_by, decided_at, archived_at
          FROM doc_decisions WHERE document_id = ${sourceId}
      `);
    } else {
      await tx.execute(sql`
        INSERT INTO doc_records (document_id, collection, record_id, scope, owner_user_id, data, contributors, version, updated_at, updated_by)
        SELECT ${documentId}, collection, record_id, scope, owner_user_id, data, contributors, version, updated_at, updated_by
          FROM doc_records WHERE document_id = ${sourceId} AND scope = 'shared'
      `);
    }
    await tx.execute(sql`
      INSERT INTO doc_mentions (document_id, block_id, user_id, created_at)
      SELECT ${documentId}, block_id, user_id, created_at FROM doc_mentions WHERE document_id = ${sourceId}
    `);
  });

  // The rows are committed: a failure past here removes the copy again (its
  // rows go with the document; the storage objects are deleted by hand).
  const stored = [...files.map((f) => f.storageKey), ...pageSources.values()];
  if (original) stored.push(original.originalKey);
  try {
    // Marks and file links are rewritten through the pipeline, by the system
    // (no mention, task or suggestion follows from it).
    await applyPlan(documentId, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      annotation: true,
      edits: [
        ...tabs.map((tab): PlannedEdit => ({
          target: { tabId: tab.id, blockId: '' },
          inverse: false,
          build: (tr) => rewriteIds(tr, kind, ids, { widgetHashes, pageSources }),
        })),
        ...subFragments.map((name): PlannedEdit => ({
          target: targetOfFragment(name)!,
          inverse: false,
          build: (tr) => rewriteIds(tr, kind, ids),
        })),
      ],
    });
    // A fork's task blocks are its own tracked tasks; a branch's stay the parent's.
    if (kind === 'fork') await rebuildTaskIndex(documentId);

    await writeCheckpoint(storage, documentId, actor, null, await captureState(documentId, actor), original, { fixedVersionId: firstVersionId });
    return { ok: true, documentId };
  } catch (err) {
    await db.delete(documents).where(eq(documents.id, documentId)).catch(() => undefined);
    for (const key of stored) await storage.delete(key).catch(() => undefined);
    throw err;
  }
}

/** Comment marks re-pointed through `ids` (a branch; marks of threads not in
 *  `ids` are stripped) or all stripped (a fork); `primer-blob://` ids
 *  re-pointed through `ids`. A branch's proposal maps back the same way. */
export function rewriteIds(
  tr: Transform,
  kind: CopyKind,
  ids: Map<string, string>,
  extra: { widgetHashes?: Map<string, string>; pageSources?: Map<string, string> } = {},
): void {
  const comment = tr.doc.type.schema.marks.comment!;
  tr.doc.descendants((node: PmNode, pos: number) => {
    const attrs =
      rewriteBlobAttrs(node.attrs, ids) ??
      (node.type.name === 'widget' ? rewriteWidgetAttrs(node.attrs, ids, extra.widgetHashes) : null) ??
      (node.type.name === 'page' ? rewritePageSource(node.attrs, extra.pageSources) : null);
    if (attrs) tr.setNodeMarkup(pos, undefined, attrs, node.marks);
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type !== comment) continue;
      const to = ids.get(String(mark.attrs.threadId));
      tr.removeMark(pos, pos + node.nodeSize, mark);
      if (kind === 'branch' && to) tr.addMark(pos, pos + node.nodeSize, comment.create({ ...mark.attrs, threadId: to }));
    }
    return false;
  });
}

/** A page block pointed at the copy's own stamped source. */
function rewritePageSource(attrs: PmNode['attrs'], sources?: Map<string, string>): Record<string, unknown> | null {
  const to = typeof attrs.sourceKey === 'string' ? sources?.get(attrs.sourceKey) : undefined;
  return to ? { ...attrs, sourceKey: to } : null;
}

/** A widget block pointed at the copy's row (`ids`) and its new hash. */
function rewriteWidgetAttrs(attrs: PmNode['attrs'], ids: Map<string, string>, hashes?: Map<string, string>): Record<string, unknown> | null {
  const to = typeof attrs.widgetId === 'string' ? ids.get(attrs.widgetId.toLowerCase()) : undefined;
  if (!to) return null;
  return { ...attrs, widgetId: to, hash: hashes?.get(to) ?? attrs.hash };
}

function rewriteBlobAttrs(attrs: PmNode['attrs'], ids: Map<string, string>): Record<string, unknown> | null {
  let changed = false;
  const out: Record<string, unknown> = { ...attrs };
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value !== 'string' || !value.includes('primer-blob://')) continue;
    out[key] = value.replace(/primer-blob:\/\/([0-9a-f-]{36})/gi, (whole, id: string) => {
      const to = ids.get(id.toLowerCase());
      if (!to) return whole;
      changed = true;
      return `primer-blob://${to}`;
    });
  }
  return changed ? out : null;
}

type FileRow = typeof docFiles.$inferInsert;

/** Copies each file object to the new document's storage, returning the rows. */
async function copyFiles(storage: Storage, sourceId: string, documentId: string, fileIds: string[], ids: Map<string, string>): Promise<FileRow[]> {
  if (fileIds.length === 0) return [];
  const rows = await db
    .select()
    .from(docFiles)
    .where(and(eq(docFiles.documentId, sourceId), inArray(docFiles.id, fileIds)));
  const out: FileRow[] = [];
  for (const file of rows) {
    const id = uuidv7();
    const storageKey = `files/${documentId}/${id}`;
    await storage.put(storageKey, new Uint8Array(await new Response(await storage.get(file.storageKey)).arrayBuffer()));
    ids.set(file.id.toLowerCase(), id);
    out.push({ ...file, id, documentId, storageKey, createdAt: undefined, copiedFrom: file.id });
  }
  return out;
}

/** Copies each page block's stamped source into the new document's prefix.
 *  Only a key inside the source's own prefix is read: block props are
 *  editor-writable. Returns old key → new key. */
async function copyPageSources(
  storage: Storage,
  sourceId: string,
  documentId: string,
  pages: ReturnType<typeof pageBlocks>,
  firstVersionId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const page of pages) {
    if (out.has(page.sourceKey) || !isOwnSourceKey(sourceId, page.sourceKey)) continue;
    // A key naming no object (an editor wrote it) is left uncopied: the page shows as unavailable, the copy still happens.
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await new Response(await storage.get(page.sourceKey)).arrayBuffer());
    } catch (err) {
      logger.warn({ sourceId, blockId: page.blockId, err }, 'copy: page source unreadable, not copied');
      continue;
    }
    const to = sourceKeyOf(documentId, out.size === 0 ? firstVersionId : uuidv7());
    await storage.put(to, bytes);
    out.set(page.sourceKey, to);
  }
  return out;
}

type WidgetInsert = typeof widgets.$inferInsert;

/**
 * Copies the `widgets` rows of the source's widget blocks under new ids (C12).
 * The ids come from the Y.Doc, which clients write: only a row of the source
 * document that sits under that very block is copied (a block naming
 * another document's widget draws nothing, here and in the copy). A
 * published widget is rendered again under its new id; the old hash only
 * stands when that fails.
 */
async function copyWidgets(
  sourceId: string,
  documentId: string,
  blocks: ReturnType<typeof widgetBlocks>,
  ids: Map<string, string>,
  hashes: Map<string, string>,
): Promise<WidgetInsert[]> {
  if (blocks.length === 0) return [];
  const rows = await db
    .select()
    .from(widgets)
    .where(and(eq(widgets.documentId, sourceId), inArray(widgets.id, blocks.map((b) => b.widgetId))));
  const out: WidgetInsert[] = [];
  for (const block of blocks) {
    const row = rows.find((r) => r.id === block.widgetId && r.blockId === block.blockId);
    if (!row) continue;
    const id = uuidv7();
    ids.set(row.id.toLowerCase(), id);
    const copy: WidgetInsert = {
      id,
      documentId,
      blockId: row.blockId,
      publishedSource: row.publishedSource,
      publishedSvgLight: row.publishedSvgLight,
      publishedSvgDark: row.publishedSvgDark,
      publishedHash: row.publishedHash,
      rows: row.rows,
      collection: row.collection,
      updatedBy: row.updatedBy,
    };
    if (row.publishedSource) {
      const rendered = await renderBoth(row.publishedSource, (row.rows ?? []) as never, widgetIdPrefix(id));
      if (!('errors' in rendered)) {
        copy.publishedSvgLight = rendered.light.svg;
        copy.publishedSvgDark = rendered.dark.svg;
        copy.publishedHash = rendered.hash;
      }
    }
    if (copy.publishedHash) hashes.set(id, copy.publishedHash);
    out.push(copy);
  }
  return out;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A branch's copies of the source's live threads, with their comments and
 *  reactions; no events (nothing new was said). */
async function copyThreads(tx: Tx, sourceId: string, documentId: string, ids: Map<string, string>): Promise<void> {
  const rows = await tx.select().from(threads).where(and(eq(threads.documentId, sourceId), isNull(threads.versionId)));
  if (rows.length === 0) return;
  for (const t of rows) ids.set(t.id.toLowerCase(), uuidv7());
  await tx.insert(threads).values(rows.map((t) => ({ ...t, id: ids.get(t.id.toLowerCase())!, documentId, copiedFrom: t.id })));
  const commentRows = await tx.select().from(comments).where(inArray(comments.threadId, rows.map((t) => t.id)));
  if (commentRows.length === 0) return;
  const commentIds = new Map(commentRows.map((c) => [c.id, uuidv7()]));
  await tx.insert(comments).values(commentRows.map((c) => ({ ...c, id: commentIds.get(c.id)!, threadId: ids.get(c.threadId.toLowerCase())! })));
  const reactions = await tx.select().from(commentReactions).where(inArray(commentReactions.commentId, [...commentIds.keys()]));
  if (reactions.length > 0) await tx.insert(commentReactions).values(reactions.map((r) => ({ ...r, commentId: commentIds.get(r.commentId)! })));
}

/** A branch's copies of the source's open suggestions (same blocks, so the
 *  same targets), not tied to any run. */
async function copySuggestions(
  tx: Tx,
  sourceId: string,
  documentId: string,
  ids: Map<string, string>,
  rewriteEdits: (edits: unknown) => unknown,
): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT author_id AS "authorId", change_set_id AS "changeSetId", tab_id AS "tabId", target_ids AS "targetIds", edits, conflict, created_at AS "createdAt"
      FROM suggestions WHERE document_id = ${sourceId} AND status = 'open' ORDER BY created_at, id
  `)) as unknown as { authorId: string; changeSetId: string | null; tabId: string; targetIds: string[]; edits: unknown; conflict: boolean; createdAt: Date }[];
  for (const r of rows) {
    if (r.changeSetId && !ids.has(r.changeSetId)) ids.set(r.changeSetId, uuidv7());
    await tx.execute(sql`
      INSERT INTO suggestions (id, document_id, author_id, run_id, change_set_id, tab_id, target_ids, edits, conflict, created_at)
      VALUES (${uuidv7()}, ${documentId}, ${r.authorId}, NULL, ${r.changeSetId ? ids.get(r.changeSetId)! : null}, ${r.tabId},
              ${sql`ARRAY[${sql.join(r.targetIds.map((id) => sql`${id}`), sql`, `)}]::text[]`},
              ${JSON.stringify(rewriteEdits(r.edits))}::jsonb, ${r.conflict}, ${r.createdAt})
    `);
  }
}

/** The source's latest original, copied to be the copy's checkpoint 1's. */
async function copyOriginal(storage: Storage, sourceId: string) {
  const [latest] = await db
    .select({ originalKey: versions.originalKey, sourceFormat: versions.sourceFormat })
    .from(versions)
    .where(and(eq(versions.documentId, sourceId), isNotNull(versions.originalKey)))
    .orderBy(desc(versions.versionNumber))
    .limit(1);
  if (!latest?.originalKey || (latest.sourceFormat !== 'markdown' && latest.sourceFormat !== 'text' && latest.sourceFormat !== 'html')) return undefined;
  const versionId = uuidv7();
  const originalKey = `v1/${versionId}.orig`;
  await storage.put(originalKey, new Uint8Array(await new Response(await storage.get(latest.originalKey)).arrayBuffer()));
  return { versionId, originalKey, sourceFormat: latest.sourceFormat };
}
