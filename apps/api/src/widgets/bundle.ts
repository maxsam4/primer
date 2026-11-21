import * as Y from 'yjs';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { RecordsSnapshot } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { widgets } from '../db/schema.ts';
import { tabFragmentName, tabsOf } from '../live/reach.ts';
import type { Storage } from '../storage/types.ts';
import { readLabel } from './labels.ts';
import { snapshotRows } from '../records/snapshot.ts';
import { refreshBoundWidgets } from './records.ts';
import { MAX_ROWS, renderBoth, widgetIdPrefix, type WidgetRow } from './render.ts';
import { labelsOf, withLabels } from './serialize.ts';

/** A widget block in a document state. */
export type PlacedWidget = { blockId: string; widgetId: string; hash: string; textIds: string[]; element: Y.XmlElement };

/** What a checkpoint keeps of a widget (`widgets/<id>.json`): enough to republish it. */
type BundledWidget = { widgetId: string; blockId: string; hash: string; source: string; rows: WidgetRow[] | null; collection: string | null };

/** Ids read from a Y.Doc are client-written: only a UUID may name a widget
 *  (a lookup, or a storage key) and only a plain name a block. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The widget blocks in a document state whose ids are well formed. Their
 *  ids still say nothing about which document owns the widget: every lookup
 *  by them is also scoped by the document id. */
function placedWidgets(doc: Y.Doc): PlacedWidget[] {
  return widgetBlocks(doc).filter((w) => w.hash);
}

/** Every widget block with well-formed ids, published or not (a copy takes
 *  them all; a checkpoint only the published ones). */
export function widgetBlocks(doc: Y.Doc): PlacedWidget[] {
  const out: PlacedWidget[] = [];
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'widget') {
        const blockId = (child.parent as Y.XmlElement | null)?.getAttribute('id');
        const widgetId = String(child.getAttribute('widgetId') ?? '');
        const hash = String(child.getAttribute('hash') ?? '');
        const textIds = String(child.getAttribute('textIds') ?? '').split(' ').filter(Boolean);
        if (blockId && BLOCK_ID.test(blockId) && UUID.test(widgetId) && hash) out.push({ blockId, widgetId, hash, textIds, element: child });
      } else walk(child);
    }
  };
  for (const tab of tabsOf(doc)) walk(doc.getXmlFragment(tabFragmentName(tab.id)));
  return out;
}

/**
 * The widgets of a checkpoint's frozen state (C11): for each published widget
 * block, `widgets/<id>.light.svg` and `.dark.svg` with the labels as they
 * were, and `widgets/<id>.json` to republish it on restore. `embed` puts both
 * themes' SVG in place of the blocks' placeholders in the static rendering.
 *
 * A widget bound to a records collection is drawn again from the checkpoint's
 * frozen records (`records`), so its SVG shows exactly the rows `records.json`
 * holds, even when the live redraw after a write hasn't landed yet. A frozen
 * collection that no longer renders keeps the live publish, as a live redraw
 * that fails does.
 */
export async function bundleWidgets(
  doc: Y.Doc,
  documentId: string,
  records: RecordsSnapshot,
): Promise<{ files: Record<string, string>; embed: (html: string) => string }> {
  const placed = placedWidgets(doc);
  const rows =
    placed.length === 0
      ? []
      : await db
          .select()
          .from(widgets)
          .where(and(inArray(widgets.id, placed.map((w) => w.widgetId)), eq(widgets.documentId, documentId)));
  const files: Record<string, string> = {};
  const svgs = new Map<string, { light: string; dark: string }>();
  for (const widget of placed) {
    // A block naming another document's widget, or another block's, draws nothing.
    const row = rows.find((r) => r.id === widget.widgetId && r.blockId === widget.blockId);
    if (!row?.publishedSvgLight || !row.publishedSvgDark || !row.publishedSource) continue;
    // The block names one publish; a row already on the next one (a publish
    // landed after the state was captured) would mix two revisions.
    if (row.publishedHash !== widget.hash) continue;
    let drawn = { light: row.publishedSvgLight, dark: row.publishedSvgDark, hash: row.publishedHash!, rows: row.rows as WidgetRow[] | null };
    if (row.collection) {
      const frozen = snapshotRows(records, row.collection);
      const rendered = frozen.length <= MAX_ROWS ? await renderBoth(row.publishedSource, frozen, widgetIdPrefix(row.id)) : null;
      if (rendered && !('errors' in rendered)) drawn = { light: rendered.light.svg, dark: rendered.dark.svg, hash: rendered.hash, rows: frozen };
    }
    const labels = labelsOf(drawn.light);
    for (const textId of widget.textIds) labels[textId] = readLabel(doc, widget.blockId, textId) ?? labels[textId] ?? '';
    const light = withLabels(drawn.light, labels);
    const dark = withLabels(drawn.dark, labels);
    svgs.set(widget.widgetId, { light, dark });
    files[`widgets/${widget.widgetId}.light.svg`] = light;
    files[`widgets/${widget.widgetId}.dark.svg`] = dark;
    const kept: BundledWidget = {
      widgetId: row.id,
      blockId: widget.blockId,
      hash: drawn.hash,
      source: row.publishedSource,
      rows: drawn.rows,
      collection: row.collection,
    };
    files[`widgets/${widget.widgetId}.json`] = JSON.stringify(kept);
  }
  const embed = (html: string) => {
    if (!html.includes('class="primer-widget"')) return html;
    const replaced = html.replace(/<div class="primer-widget" data-widget-id="([^"]+)"><\/div>/g, (whole, id: string) => {
      const svg = svgs.get(id);
      return svg
        ? `<div class="primer-widget"><div class="primer-widget-light">${svg.light}</div><div class="primer-widget-dark">${namespaceIds(svg.dark, 'dk-')}</div></div>`
        : '<div class="primer-widget"><p>Widget unavailable</p></div>';
    });
    return replaced.replace('</head>', `<style>${THEME_CSS}</style></head>`);
  };
  return { files, embed };
}

/** The SVG with its ids and their references under `ns`: both themes sit in
 *  one page, and a gradient, marker or `<use>` must resolve inside its own. */
function namespaceIds(svg: string, ns: string): string {
  return svg
    .replace(/(\s)id="([^"]*)"/g, `$1id="${ns}$2"`)
    .replace(/url\(#([^)]*)\)/g, `url(#${ns}$1)`)
    .replace(/(\shref)="#([^"]*)"/g, `$1="#${ns}$2"`);
}

/** A widget shows its light SVG unless the page is dark (Primer sets
 *  `data-theme` on pages it owns). */
const THEME_CSS =
  '.primer-widget svg{display:block;width:100%;height:auto}.primer-widget-dark{display:none}' +
  'html[data-theme="dark"] .primer-widget-light{display:none}html[data-theme="dark"] .primer-widget-dark{display:block}';

/** Whether a widget block of a checkpoint's frozen state differs from what
 *  is published for it now (a different hash, or no publish at all). */
export async function widgetsChangedSince(frozen: Y.Doc, documentId: string): Promise<boolean> {
  const placed = placedWidgets(frozen);
  if (placed.length === 0) return false;
  const rows = await db
    .select({ id: widgets.id, blockId: widgets.blockId, hash: widgets.publishedHash })
    .from(widgets)
    .where(and(inArray(widgets.id, placed.map((w) => w.widgetId)), eq(widgets.documentId, documentId)));
  return placed.some((w) => rows.find((r) => r.id === w.widgetId && r.blockId === w.blockId)?.hash !== w.hash);
}

/**
 * Restoring a checkpoint republishes each of its widgets from the bundle
 * (C12): the kept source and rows are rendered again and become the live
 * publish when they give the kept hash. A pending draft is left alone.
 * Records are not versioned, so a widget bound to a collection then draws
 * from the live records again (`refreshBoundWidgets`), as its data tables do.
 */
export async function restoreWidgets(storage: Storage, bundleKey: string, frozen: Y.Doc, documentId: string): Promise<void> {
  for (const widget of placedWidgets(frozen)) {
    let kept: BundledWidget;
    try {
      kept = JSON.parse(await new Response(await storage.get(`${bundleKey}widgets/${widget.widgetId}.json`)).text()) as BundledWidget;
    } catch {
      continue; // a checkpoint taken before the widget was ever published
    }
    if (kept.widgetId !== widget.widgetId || kept.blockId !== widget.blockId) continue;
    const rendered = await renderBoth(kept.source, kept.rows ?? [], widgetIdPrefix(kept.widgetId));
    if ('errors' in rendered || rendered.hash !== kept.hash) continue;
    await db
      .update(widgets)
      .set({
        publishedSource: kept.source,
        publishedSvgLight: rendered.light.svg,
        publishedSvgDark: rendered.dark.svg,
        publishedHash: rendered.hash,
        rows: kept.rows,
        collection: kept.collection ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(widgets.id, kept.widgetId), eq(widgets.documentId, documentId), eq(widgets.blockId, kept.blockId)));
    // The block shows the hash of the render just restored (the frozen state may name an earlier live redraw).
    widget.element.setAttribute('hash', rendered.hash);
  }
}

/** After a restore's edit landed: bound widgets draw from the live records again. */
export async function redrawBoundWidgets(documentId: string): Promise<void> {
  const bound = await db
    .selectDistinct({ collection: widgets.collection })
    .from(widgets)
    .where(and(eq(widgets.documentId, documentId), isNotNull(widgets.collection)));
  await refreshBoundWidgets(documentId, bound.map((b) => b.collection!));
}
