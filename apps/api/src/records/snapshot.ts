// A checkpoint's frozen records (C11 `records.json`): the document's shared
// records when the checkpoint was taken. Records are not versioned (C12), so
// a checkpoint keeps its own copy: shares and checkpoint views show data as it
// was at publish, never live data, and the data tables and bound charts of
// one checkpoint draw from the same rows. Personal records are never frozen.
import { sql } from 'drizzle-orm';
import type { RecordsSnapshot } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { actorNameOf } from '../lib/actors.ts';
import type { Storage } from '../storage/types.ts';

/** The document's shared records now, with the last change id they include,
 *  read in one statement so the two agree. */
export async function snapshotRecords(documentId: string): Promise<RecordsSnapshot> {
  const rows = (await db.execute(sql`
    WITH last AS (SELECT COALESCE(MAX(id), 0)::bigint AS id FROM doc_record_changes WHERE document_id = ${documentId})
    SELECT r.collection, r.record_id AS "recordId", r.data, r.version, r.updated_at AS "updatedAt",
           ${actorNameOf('u')} AS "writtenBy", (SELECT id FROM last) AS "toChangeId"
      FROM (SELECT 1) one
      LEFT JOIN doc_records r ON r.document_id = ${documentId} AND r.scope = 'shared'
      LEFT JOIN users u ON u.id = r.updated_by
     ORDER BY r.collection, r.record_id
  `)) as unknown as {
    collection: string | null;
    recordId: string;
    data: Record<string, unknown>;
    version: number;
    updatedAt: Date | string;
    writtenBy: string;
    toChangeId: number | string;
  }[];
  // No prototype: a collection may be named `constructor` or `toString`.
  const collections: RecordsSnapshot['collections'] = Object.create(null);
  for (const r of rows) {
    if (r.collection === null) continue;
    (collections[r.collection] ??= []).push({
      recordId: r.recordId,
      data: r.data,
      version: r.version,
      updatedAt: new Date(r.updatedAt).toISOString(),
      writtenBy: r.writtenBy,
    });
  }
  return { capturedAt: new Date().toISOString(), toChangeId: Number(rows[0]?.toChangeId ?? 0), collections };
}

/** A collection of a snapshot as widget rows: each record's data with `id` =
 *  its record id, as widgets/records.ts `collectionRows` reads live records. */
export function snapshotRows(snapshot: RecordsSnapshot, collection: string): (Record<string, unknown> & { id: string })[] {
  return (Object.hasOwn(snapshot.collections, collection) ? snapshot.collections[collection]! : []).map((r) => ({ ...r.data, id: r.recordId }));
}

/** A bundle's frozen records, or null for a bundle without them (one taken
 *  before records were frozen, or a legacy version). */
export async function readFrozenRecords(storage: Storage, bundleKey: string): Promise<RecordsSnapshot | null> {
  try {
    const text = await new Response(await storage.get(`${bundleKey}records.json`)).text();
    return JSON.parse(text) as RecordsSnapshot;
  } catch {
    return null;
  }
}
