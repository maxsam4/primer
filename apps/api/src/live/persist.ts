import * as Y from 'yjs';
import { sql } from 'drizzle-orm';
import { primerSchema } from '@primer/blocks';
import { db } from '../db/client.ts';
import { docUpdates } from '../db/schema.ts';
import { docQueue } from './queue.ts';
import { originOf } from './origin.ts';
import { isTabFragment } from './reach.ts';
import { logger } from '../logger.ts';

/** Compaction folds the update log into the snapshot above this many rows. */
export const COMPACT_ABOVE = 500;
/** How often (in appended rows) persistence asks for a compaction. */
const COMPACT_CHECK_EVERY = 100;

type Row = { id: number | string; update: Uint8Array };

/**
 * A live document's Y.Doc, rebuilt from its snapshot and the updates after it,
 * read in one snapshot so a concurrent compaction can't drop rows from view.
 * `docVersion` is the id of the latest update row (0 for a new document).
 */
export async function loadYDoc(documentId: string): Promise<{ doc: Y.Doc; docVersion: number }> {
  const loaded = await db.transaction(
    async (tx) => {
      const [snapshot] = (await tx.execute(sql`
        SELECT state FROM doc_snapshots WHERE document_id = ${documentId}
      `)) as unknown as { state: Uint8Array }[];
      const rows = (await tx.execute(sql`
        SELECT id, update FROM doc_updates
         WHERE document_id = ${documentId} AND update IS NOT NULL
         ORDER BY id
      `)) as unknown as Row[];
      const [latest] = (await tx.execute(sql`
        SELECT max(id) AS id FROM doc_updates WHERE document_id = ${documentId}
      `)) as unknown as { id: number | string | null }[];
      const doc = new Y.Doc();
      doc.transact(() => {
        if (snapshot) Y.applyUpdate(doc, snapshot.state);
        for (const row of rows) Y.applyUpdate(doc, row.update);
      });
      return { doc, docVersion: Number(latest?.id ?? 0), rows: rows.length };
    },
    { isolationLevel: 'repeatable read' },
  );
  // The append-driven check resets with every attach, so many short sessions
  // never reach it: a load that finds a long log compacts it.
  if (loaded.rows > COMPACT_ABOVE) void compact(documentId).catch(compactFailed(documentId));
  return { doc: loaded.doc, docVersion: loaded.docVersion };
}

const compactFailed = (documentId: string) => (err: unknown) =>
  logger.warn({ documentId, error: String(err) }, 'live: compaction failed');

type PersistState = {
  /** Resolves to the id of the newest queued insert, once it is stored. */
  last: Promise<number>;
  failed: Error | null;
  inserted: number;
};

const states = new WeakMap<Y.Doc, PersistState>();
const TOUCHED = Symbol('primer:touched');

/**
 * Appends every update of `doc` to `doc_updates`, in order, on the document's
 * queue: the update bytes, who made it (`originOf`) and what it touched
 * (ancestor and deleted `blockContainer` ids, plus the names of non-tab root
 * types). Attach only after the stored state is applied, or the load itself is
 * stored again.
 *
 * After a failed insert nothing more is stored for this doc (a gap would
 * corrupt the log): `onFailure` runs once and `persistedUpTo` rejects.
 * Returns a detach function that waits for queued inserts.
 */
export function attachPersistence(
  doc: Y.Doc,
  documentId: string,
  opts: { docVersion?: number; onFailure?: (err: Error) => void } = {},
): () => Promise<void> {
  const state: PersistState = { last: Promise.resolve(opts.docVersion ?? 0), failed: null, inserted: 0 };
  states.set(doc, state);
  const queue = docQueue(documentId);

  // Deleted content is garbage-collected before `update` fires, so the
  // touched ids are collected while the transaction is still intact.
  const onAfterTransaction = (tr: Y.Transaction) => {
    tr.meta.set(TOUCHED, commentMarksOnly(doc, tr) ? [] : touchedBy(doc, tr));
  };
  const onUpdate = (update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
    if (state.failed) return;
    const by = originOf(origin);
    const actorId = by.kind === 'system' ? null : by.actorId;
    const touched = (tr.meta.get(TOUCHED) as string[] | undefined) ?? [];
    const job = queue(async () => {
      if (state.failed) throw state.failed;
      const [row] = await db
        .insert(docUpdates)
        .values({ documentId, update, actorId, runId: by.runId, touched })
        .returning({ id: docUpdates.id });
      return row!.id;
    });
    state.last = job;
    job.then(
      () => {
        if (++state.inserted % COMPACT_CHECK_EVERY === 0) void compact(documentId).catch(compactFailed(documentId));
      },
      (err: unknown) => {
        if (state.failed) return;
        state.failed = err instanceof Error ? err : new Error(String(err));
        opts.onFailure?.(state.failed);
      },
    );
  };

  doc.on('afterTransaction', onAfterTransaction);
  doc.on('update', onUpdate);
  return async () => {
    doc.off('afterTransaction', onAfterTransaction);
    doc.off('update', onUpdate);
    await state.last.catch(() => undefined);
    states.delete(doc);
  };
}

/** The block ids (and non-tab root names) a stored transaction touched;
 *  read in `update` handlers, which run after persistence collected them. */
export function touchedOf(tr: Y.Transaction): string[] {
  return (tr.meta.get(TOUCHED) as string[] | undefined) ?? [];
}

/** The docVersion once every update made so far to `doc` is stored. Rejects
 *  if persistence failed. */
export function persistedUpTo(doc: Y.Doc): Promise<number> {
  const state = states.get(doc);
  if (!state) return Promise.reject(new Error('live document has no persistence attached'));
  if (state.failed) return Promise.reject(state.failed);
  return state.last;
}

/**
 * Folds the update log into the snapshot when more than `above` rows are
 * uncompacted. A queue job, so it never interleaves with an append. Rows stay
 * (with `update` null) for their ids, attribution and `touched`.
 */
export function compact(documentId: string, opts: { above?: number } = {}): Promise<void> {
  const above = opts.above ?? COMPACT_ABOVE;
  return docQueue(documentId)(async () => {
    const [count] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM doc_updates WHERE document_id = ${documentId} AND update IS NOT NULL
    `)) as unknown as { n: number }[];
    if ((count?.n ?? 0) <= above) return;
    await db.transaction(async (tx) => {
      const [snapshot] = (await tx.execute(sql`
        SELECT state FROM doc_snapshots WHERE document_id = ${documentId}
      `)) as unknown as { state: Uint8Array }[];
      const rows = (await tx.execute(sql`
        SELECT id, update FROM doc_updates
         WHERE document_id = ${documentId} AND update IS NOT NULL
         ORDER BY id
      `)) as unknown as Row[];
      if (rows.length === 0) return;
      const doc = new Y.Doc();
      if (snapshot) Y.applyUpdate(doc, snapshot.state);
      for (const row of rows) Y.applyUpdate(doc, row.update);
      const state = Buffer.from(Y.encodeStateAsUpdate(doc));
      const upto = Number(rows[rows.length - 1]!.id);
      doc.destroy();
      await tx.execute(sql`
        INSERT INTO doc_snapshots (document_id, state, upto_update_id, updated_at)
        VALUES (${documentId}, ${state}, ${upto}, now())
        ON CONFLICT (document_id) DO UPDATE
          SET state = EXCLUDED.state, upto_update_id = EXCLUDED.upto_update_id, updated_at = now()
      `);
      await tx.execute(sql`
        UPDATE doc_updates SET update = NULL
         WHERE document_id = ${documentId} AND id <= ${upto} AND update IS NOT NULL
      `);
    });
  });
}

/** Elements that are blocks: BlockNote's container plus Primer's layout blocks. */
export const BLOCK_ELEMENTS = new Set([
  'blockContainer',
  ...Object.values(primerSchema.blockSpecs).flatMap((spec) => (spec.config.layoutOnly ? [spec.config.type] : [])),
]);

const COMMENT_KEY = /^comment(--|$)/;

/**
 * Whether a transaction only places, moves or clears comment marks (the
 * server anchoring a thread, or BlockNote flagging a resolved one): no
 * content changed, so it touches no block for delta reads and catch-up.
 */
function commentMarksOnly(doc: Y.Doc, tr: Y.Transaction): boolean {
  const isCommentFormat = (s: unknown) => s instanceof Y.Item && s.content instanceof Y.ContentFormat && COMMENT_KEY.test(s.content.key);
  let any = false;
  for (const [client, after] of tr.afterState) {
    const before = tr.beforeState.get(client) ?? 0;
    if (after <= before) continue;
    const structs = doc.store.clients.get(client) ?? [];
    for (let i = Y.findIndexSS(structs, before); i < structs.length && structs[i]!.id.clock < after; i++) {
      if (!isCommentFormat(structs[i])) return false;
      any = true;
    }
  }
  let others = false;
  Y.iterateDeletedStructs(tr, tr.deleteSet, (s) => {
    if (isCommentFormat(s)) any = true;
    else others = true;
  });
  return any && !others;
}

function touchedBy(doc: Y.Doc, tr: Y.Transaction): string[] {
  const touched = new Set<string>();
  const rootNames = new Map<unknown, string>();
  for (const [name, type] of doc.share) rootNames.set(type, name);

  for (const changed of tr.changed.keys()) {
    let type: Y.AbstractType<any> | null = changed;
    let root: Y.AbstractType<any> = changed;
    while (type) {
      const id = blockIdOf(type);
      if (id) touched.add(id);
      root = type;
      type = (type._item?.parent as Y.AbstractType<any> | undefined) ?? null;
    }
    const name = rootNames.get(root);
    if (name !== undefined && !isTabFragment(name)) touched.add(name);
  }
  // Blocks created in this transaction: their parent is in `changed`, but
  // they are not. Items are ordered by clock, so scan each client's tail.
  for (const [client, after] of tr.afterState) {
    const before = tr.beforeState.get(client) ?? 0;
    if (after <= before) continue;
    const structs = (tr.doc.store as unknown as { clients: Map<number, (Y.Item | Y.GC)[]> }).clients.get(client) ?? [];
    for (let i = structs.length - 1; i >= 0 && structs[i]!.id.clock + structs[i]!.length > before; i--) {
      const struct = structs[i]!;
      if (struct instanceof Y.Item && struct.content instanceof Y.ContentType) {
        const id = blockIdOf(struct.content.type);
        if (id) touched.add(id);
      }
    }
  }
  Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
    if (struct instanceof Y.Item && struct.content instanceof Y.ContentType) {
      const id = blockIdOf(struct.content.type);
      if (id) touched.add(id);
    }
  });
  return [...touched];
}

/** The id of a block element (a `blockContainer`, or a layout block such as
 *  a choice, a column list or a column), read from its attribute item so it still
 *  works for an element deleted in this transaction. */
function blockIdOf(type: Y.AbstractType<any>): string | null {
  if (!(type instanceof Y.XmlElement) || !BLOCK_ELEMENTS.has(type.nodeName)) return null;
  const item = type._map.get('id');
  const value = item?.content.getContent()[item.length - 1];
  return typeof value === 'string' ? value : null;
}
