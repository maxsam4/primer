import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { WidgetError } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { widgets } from '../db/schema.ts';
import { withLiveDocument } from '../live/instance.ts';
import { SYSTEM_ORIGIN } from '../live/origin.ts';
import { applyPlan } from '../live/pipeline.ts';
import { docQueue } from '../live/queue.ts';
import { MAIN_TAB } from '../live/reach.ts';
import { logger } from '../logger.ts';
import { carryEdit, tabOfBlock } from './labels.ts';
import { labelsOf } from './serialize.ts';
import { MAX_ROWS, renderBoth, widgetIdPrefix, type WidgetRow } from './render.ts';

/**
 * A collection's shared records as widget rows, in record id order: each
 * record's data with `id` = its record id, so a mark's `data-row` names the
 * record and comments stay on it when records change.
 */
export async function collectionRows(documentId: string, collection: string): Promise<WidgetRow[] | { errors: WidgetError[] }> {
  const records = (await db.execute(sql`
    SELECT record_id AS "recordId", data FROM doc_records
     WHERE document_id = ${documentId} AND collection = ${collection} AND scope = 'shared'
     ORDER BY record_id
     LIMIT ${MAX_ROWS + 1}
  `)) as unknown as { recordId: string; data: unknown }[];
  if (records.length > MAX_ROWS) {
    return { errors: [{ line: 0, message: `Collection "${collection}" has more than ${MAX_ROWS} records.`, fix: 'Aggregate into a smaller collection for the chart.' }] };
  }
  return records.map((r) => ({ ...(typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data) ? r.data : { value: r.data }), id: r.recordId }));
}

/**
 * Redraws the published widgets bound to any of `collections` from their
 * records (after a coalesced `data.changed`), keeping the published source.
 * A render that fails leaves the last good publish live.
 */
export function refreshBoundWidgets(documentId: string, collections: string[]): Promise<void> {
  if (collections.length === 0) return Promise.resolve();
  // One refresh at a time per document: two (one per actor's window) must not
  // render from different snapshots and have the newer discarded.
  return docQueue(`widgets:${documentId}`)(() => refresh(documentId, collections));
}

async function refresh(documentId: string, collections: string[]): Promise<void> {
  const bound = await db
    .select()
    .from(widgets)
    .where(and(eq(widgets.documentId, documentId), inArray(widgets.collection, collections), isNotNull(widgets.publishedSource)));
  for (const widget of bound) {
    const rows = await collectionRows(documentId, widget.collection!);
    if ('errors' in rows) {
      logger.warn({ widgetId: widget.id, errors: rows.errors }, 'widget: bound collection is too large to draw');
      continue;
    }
    const rendered = await renderBoth(widget.publishedSource!, rows, widgetIdPrefix(widget.id));
    if ('errors' in rendered) {
      logger.warn({ widgetId: widget.id, errors: rendered.errors }, 'widget: records no longer render; the last publish stays');
      continue;
    }
    if (rendered.hash === widget.publishedHash) continue;
    const updated = await db
      .update(widgets)
      .set({ publishedSvgLight: rendered.light.svg, publishedSvgDark: rendered.dark.svg, publishedHash: rendered.hash, rows, updatedAt: new Date() })
      .where(and(eq(widgets.id, widget.id), eq(widgets.documentId, documentId), sql`${widgets.publishedHash} IS NOT DISTINCT FROM ${widget.publishedHash}`))
      .returning({ id: widgets.id });
    if (updated.length === 0) continue; // a publish landed meanwhile
    const tabId = (await withLiveDocument(documentId, (doc) => tabOfBlock(doc, widget.blockId))) ?? MAIN_TAB;
    // The redraw may draw other labels (a no-data note): their fragments and
    // the block's text ids follow, with people's edits to kept labels carried.
    const theirs = rendered.light.labels;
    const base = widget.publishedSvgLight ? labelsOf(widget.publishedSvgLight) : {};
    await applyPlan(documentId, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        ...Object.entries(theirs).map(([textId, agentText]) => carryEdit({ tabId, blockId: widget.blockId, textId }, base[textId], agentText)),
        {
          target: { tabId, blockId: widget.blockId },
          inverse: false,
          build: (tr, at) => {
            if (!at) return;
            const content = at.node.firstChild!;
            tr.setNodeMarkup(at.pos + 1, undefined, { ...content.attrs, hash: rendered.hash, textIds: Object.keys(theirs).join(' ') });
          },
        },
      ],
    });
  }
}
