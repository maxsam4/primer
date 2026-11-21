// Data-table blocks (M9b) on the server: finding them in a document state,
// checking comments on their rows, and drawing them from a checkpoint's
// frozen records. The block's props come from the client-writable Y.Doc, so
// they are read through `parseDataTable` (the collection must match
// RECORD_COLLECTION_RE, column keys RECORD_KEY_RE) and every lookup by them
// is scoped by the document id.
import * as Y from 'yjs';
import { sql } from 'drizzle-orm';
import {
  MAX_DATA_TABLE_ROWS,
  RECORD_ID_RE,
  parseDataTable,
  recordCellText,
  type DataPointAnchor,
  type DataTableSpec,
  type RecordsSnapshot,
} from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { withLiveDocument } from '../live/instance.ts';
import { tabFragmentName, tabsOf } from '../live/reach.ts';

const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type PlacedTable = { tabId: string; blockId: string; spec: DataTableSpec | null };

function tableOf(el: Y.XmlElement): DataTableSpec | null {
  return parseDataTable({ collection: el.getAttribute('collection'), scope: el.getAttribute('scope'), columns: el.getAttribute('columns') });
}

/** Every data-table block in a document state, in reading order, with its
 *  props validated (`spec` null when they name no valid collection). */
export function placedTables(doc: Y.Doc): PlacedTable[] {
  const out: PlacedTable[] = [];
  for (const tab of tabsOf(doc)) {
    const walk = (node: Y.XmlFragment | Y.XmlElement) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === 'dataTable') {
          const blockId = (child.parent as Y.XmlElement | null)?.getAttribute('id');
          if (blockId && BLOCK_ID.test(blockId)) out.push({ tabId: tab.id, blockId, spec: tableOf(child) });
        } else walk(child);
      }
    };
    walk(doc.getXmlFragment(tabFragmentName(tab.id)));
  }
  return out;
}

/** Whether the target names a data-table block of the document. */
export async function isDataTableTarget(documentId: string, target: { tabId: string; blockId: string }): Promise<boolean> {
  return withLiveDocument(documentId, (doc) => placedTables(doc).some((t) => t.tabId === target.tabId && t.blockId === target.blockId));
}

/**
 * Why a comment can't hang on this row of a data table, or null when it can.
 * A row comment is a `data-point` anchor on the table block: `row` is the
 * record id and `column` a column key, or '' for the whole row. The record
 * must exist in the table's collection. Only shared tables take row comments:
 * a thread is document-wide, so a personal record id in its anchor would reach
 * every reader (and match their own record of the same id).
 */
export async function dataTableAnchorProblem(documentId: string, anchor: DataPointAnchor): Promise<string | null> {
  const { tabId, blockId } = anchor.target;
  if (anchor.target.pid || anchor.target.textId || anchor.target.embedId) return 'A row comment targets the data-table block itself.';
  const table = await withLiveDocument(documentId, (doc) => placedTables(doc).find((t) => t.tabId === tabId && t.blockId === blockId));
  if (!table) return `Block ${blockId} is not a data table.`;
  if (!table.spec) return 'The data table names no valid collection.';
  if (table.spec.scope === 'personal') return 'Rows of a personal data table cannot be commented on: its records belong to each viewer.';
  if (!RECORD_ID_RE.test(anchor.row)) return 'row must be a record id.';
  if (anchor.column !== '' && !table.spec.columns.some((c) => c.key === anchor.column)) return `The table has no column "${anchor.column}".`;
  const [found] = (await db.execute(sql`
    SELECT 1 AS one FROM doc_records
     WHERE document_id = ${documentId} AND collection = ${table.spec.collection} AND scope = 'shared'
       AND owner_user_id IS NULL AND record_id = ${anchor.row}
  `)) as unknown as { one: number }[];
  return found ? null : `The table has no row "${anchor.row}".`;
}

/**
 * Whether a checkpoint holds this data-table row: the table block is in the
 * captured state and its collection's frozen records have the row (and the
 * column). Null when the anchor's block is no data table.
 */
export function dataTableAnchorFrozen(captured: Y.Doc, snapshot: RecordsSnapshot | null, anchor: DataPointAnchor): boolean | null {
  const { tabId, blockId } = anchor.target;
  const table = placedTables(captured).find((t) => t.tabId === tabId && t.blockId === blockId);
  if (!table) return null;
  if (!snapshot || !table.spec || table.spec.scope === 'personal') return false;
  const records = Object.hasOwn(snapshot.collections, table.spec.collection) ? snapshot.collections[table.spec.collection]! : [];
  if (!records.some((r) => r.recordId === anchor.row)) return false;
  return anchor.column === '' || table.spec.columns.some((c) => c.key === anchor.column);
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A data table drawn from frozen records, as static HTML (shares, print,
 * checkpoint previews, email): the columns the block names, one row per
 * record. Every value is escaped. A personal table shows no rows: personal
 * records are never frozen.
 */
export function staticTableHtml(spec: DataTableSpec | null, snapshot: RecordsSnapshot): string {
  if (!spec) return '<div class="primer-data-table"><p>Data table unavailable</p></div>';
  if (spec.scope === 'personal') return '<div class="primer-data-table"><p>Personal data is not part of checkpoints.</p></div>';
  const records = Object.hasOwn(snapshot.collections, spec.collection) ? snapshot.collections[spec.collection]! : [];
  const columns = spec.columns.length > 0 ? spec.columns : [...new Set(records.flatMap((r) => Object.keys(r.data)))].slice(0, 30).map((key) => ({ key, label: key }));
  const head = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const body = records
    .slice(0, MAX_DATA_TABLE_ROWS)
    .map((r) => `<tr>${columns.map((c) => `<td>${escapeHtml(recordCellText(r.data[c.key]))}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="primer-data-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const TABLE_CSS =
  '.primer-data-table{overflow-x:auto;margin:1em 0}.primer-data-table table{border-collapse:collapse;width:100%}' +
  '.primer-data-table th,.primer-data-table td{border:1px solid #d4d4d4;padding:4px 8px;text-align:left;vertical-align:top}' +
  'html[data-theme="dark"] .primer-data-table th,html[data-theme="dark"] .primer-data-table td{border-color:#404040}';

/** Puts each data table's frozen rows in place of its placeholder in a static rendering. */
export function embedTables(doc: Y.Doc, snapshot: RecordsSnapshot): (html: string) => string {
  const tables = new Map(placedTables(doc).map((t) => [t.blockId, t.spec]));
  return (html) => {
    if (!html.includes('class="primer-data-table"')) return html;
    const replaced = html.replace(/<div class="primer-data-table" data-block-id="([^"]+)"><\/div>/g, (_whole, blockId: string) =>
      staticTableHtml(tables.get(blockId) ?? null, snapshot),
    );
    return replaced.replace('</head>', `<style>${TABLE_CSS}</style></head>`);
  };
}
