import * as Y from 'yjs';
import { and, eq } from 'drizzle-orm';
import type { DataPointAnchor, WidgetPartAnchor } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { widgets } from '../db/schema.ts';
import { withLiveDocument } from '../live/instance.ts';
import { tabFragmentName } from '../live/reach.ts';
import { UUID } from './bundle.ts';
import type { WidgetRow } from './render.ts';

/**
 * Why a comment can't hang on this widget part or data point, or null when it
 * can: the target must be a widget block in the document, and the live
 * publish must draw that part (`data-anchor`) or have that row and column.
 * The widget id comes from the block (client-written), so the lookup is
 * scoped by the document and the block.
 */
export async function widgetAnchorProblem(documentId: string, anchor: WidgetPartAnchor | DataPointAnchor): Promise<string | null> {
  const { tabId, blockId } = anchor.target;
  if (anchor.target.pid || anchor.target.textId || anchor.target.embedId) return 'A widget part or data point targets the widget block itself.';
  const widgetId = await withLiveDocument(documentId, (doc) => widgetIdOf(doc.getXmlFragment(tabFragmentName(tabId)), blockId));
  if (!widgetId || !UUID.test(widgetId)) return `Block ${blockId} is not a widget.`;
  const [row] = await db
    .select({ svg: widgets.publishedSvgLight, rows: widgets.rows })
    .from(widgets)
    .where(and(eq(widgets.id, widgetId), eq(widgets.documentId, documentId), eq(widgets.blockId, blockId)));
  return partProblem(row, anchor);
}

/** Whether the widget published on the anchor's block still draws its part
 *  or has its data point (where a checkpoint places the thread). */
export async function widgetAnchorPublished(documentId: string, anchor: WidgetPartAnchor | DataPointAnchor): Promise<boolean> {
  const [row] = await db
    .select({ svg: widgets.publishedSvgLight, rows: widgets.rows })
    .from(widgets)
    .where(and(eq(widgets.documentId, documentId), eq(widgets.blockId, anchor.target.blockId)));
  return partProblem(row, anchor) === null;
}

function partProblem(row: { svg: string | null; rows: unknown } | undefined, anchor: WidgetPartAnchor | DataPointAnchor): string | null {
  if (!row?.svg) return 'The widget has not been published.';
  if (anchor.type === 'widget-part') {
    return row.svg.includes(` data-anchor="${escapeAttr(anchor.anchor)}"`) ? null : `The widget draws no part named "${anchor.anchor}".`;
  }
  const record = ((row.rows ?? []) as WidgetRow[]).find((r) => String(r.id) === anchor.row);
  if (!record) return `The widget has no row "${anchor.row}".`;
  return Object.hasOwn(record, anchor.column) ? null : `Row "${anchor.row}" has no column "${anchor.column}".`;
}

function widgetIdOf(node: Y.XmlFragment | Y.XmlElement, blockId: string): string | null {
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === 'widget' && (child.parent as Y.XmlElement | null)?.getAttribute('id') === blockId) {
      return String(child.getAttribute('widgetId') ?? '');
    }
    const found = widgetIdOf(child, blockId);
    if (found !== null) return found;
  }
  return null;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
