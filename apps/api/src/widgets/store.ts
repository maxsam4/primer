import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type {
  Refusal,
  Target,
  WidgetDTO,
  WidgetLabelDTO,
  WidgetDraftRequest,
  WidgetDraftResponse,
  WidgetError,
  WidgetLabelOutcome,
  WidgetPublishResponse,
  WidgetRowInput,
} from '@polygonlabs/primer-api-types';
import { RECORD_COLLECTION_RE } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, widgets } from '../db/schema.ts';
import { canEdit, canRead, effectiveAgentMode, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { serverEditor } from '../live/editor.ts';
import { originFor } from '../live/origin.ts';
import { applyPlan, type PlannedEdit } from '../live/pipeline.ts';
import { MAIN_TAB, tabsOf } from '../live/reach.ts';
import { carryEdit, carryFor, fragmentLabels, readLabel, tabOfBlock } from './labels.ts';
import { withLiveDocument } from '../live/instance.ts';
import { fenceStrings, fenceUntrusted } from '../lib/untrusted.ts';
import { blockVersion, findBlock } from '../live/blocks.ts';
import { fragmentFor } from '../live/reach.ts';
import { pmDocOf } from '../live/sources.ts';

import { rasterise } from './raster.ts';
import { renderBoth, widgetIdPrefix, type WidgetRow, type WidgetTheme } from './render.ts';
import { labelsOf, withLabels } from './serialize.ts';
import { collectionRows } from './records.ts';

export type WidgetResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409 | 422; refusal: Refusal };

const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_ROWS_BYTES = 1024 * 1024;

const NOT_FOUND: Refusal = { code: 'not_found', message: 'No such widget or document.', fix: 'Check the id; you may not have access.' };

type WidgetRowRecord = typeof widgets.$inferSelect;

function invalid(message: string, errors: WidgetError[]): WidgetResult<never> {
  return {
    ok: false,
    status: 422,
    refusal: {
      code: 'widget_invalid',
      message,
      fix: 'Fix each error (its line and fix are in details.errors) and draft again; the live widget is unchanged.',
      details: { errors },
    },
  };
}

async function documentAccess(
  documentId: string,
  actor: AuthUser,
  need: 'read' | 'edit',
): Promise<{ ok: true } | { ok: false; status: 400 | 403 | 404; refusal: Refusal }> {
  const [doc] = await db
    .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, format: documents.format, deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc || doc.deletedAt) return { ok: false, status: 404, refusal: NOT_FOUND };
  const visibility = doc.visibility as Visibility;
  const role = await loadEffectiveRole({ id: documentId, uploaderId: doc.uploaderId, visibility }, actor);
  if (!canRead(visibility, role)) return { ok: false, status: 404, refusal: NOT_FOUND };
  if (need === 'edit' && !canEdit(role)) {
    return { ok: false, status: 403, refusal: { code: 'forbidden', message: 'Only the owner and editors change widgets.', fix: 'Ask the owner for editor access.' } };
  }
  // A widget's publish replaces what people see at once, so an agent that may
  // only suggest here doesn't draw.
  if (need === 'edit' && actor.kind === 'agent' && (await effectiveAgentMode(documentId, actor.id)) === 'suggest') {
    return {
      ok: false,
      status: 403,
      refusal: {
        code: 'forbidden',
        message: 'You may only suggest changes in this document, and a widget publishes directly.',
        fix: 'Ask the owner to let you edit (agent mode), or describe the drawing in a comment.',
      },
    };
  }
  if (doc.format === null) {
    return {
      ok: false,
      status: 400,
      refusal: { code: 'bad_request', message: 'Widgets live in live documents; this one is a legacy HTML document.', fix: 'Draw the widget in a Markdown or text document.' },
    };
  }
  // A stamped page renders as itself: its exports, shares and print have no place for a drawing.
  if (doc.format === 'html' && need === 'edit') {
    return {
      ok: false,
      status: 400,
      refusal: { code: 'bad_request', message: 'Widgets are not drawn in HTML page documents.', fix: 'Draw the widget in a Markdown or text document.' },
    };
  }
  return { ok: true };
}

async function loadWidget(widgetId: string): Promise<WidgetRowRecord | null> {
  if (!/^[0-9a-f-]{36}$/.test(widgetId)) return null;
  const [row] = await db.select().from(widgets).where(eq(widgets.id, widgetId));
  return row ?? null;
}

/** The words people see on each published label now: the fragment's, else the publish's. */
async function currentLabels(row: WidgetRowRecord): Promise<Record<string, string>> {
  const published = row.publishedSvgLight ? labelsOf(row.publishedSvgLight) : {};
  const mine = await fragmentLabels(row, Object.keys(published));
  return Object.fromEntries(Object.entries(published).map(([id, text]) => [id, mine[id] ?? text]));
}

/** Each published label with its target and version, for reads and ops. */
async function labelList(row: WidgetRowRecord, actor: AuthUser): Promise<WidgetLabelDTO[]> {
  const published = row.publishedSvgLight ? labelsOf(row.publishedSvgLight) : {};
  return withLiveDocument(row.documentId, (doc) => {
    const tabId = tabOfBlock(doc, row.blockId) ?? MAIN_TAB;
    return Object.entries(published).map(([textId, words]) => {
      const target: Target = { tabId, blockId: row.blockId, textId };
      const at = findBlock(pmDocOf(fragmentFor(doc, target)), row.blockId);
      const text = readLabel(doc, row.blockId, textId) ?? words;
      return { textId, target, text: fenced(actor, text), version: at ? blockVersion(at.node) : null };
    });
  });
}

/** Rows drawn from a records collection are what viewers and other agents
 *  wrote: an agent reads every key and value fenced (each row's top-level id,
 *  a record id Primer validated, stays plain). */
function fencedRows(actor: AuthUser, rows: unknown, collection: string | null): WidgetRowInput[] | null {
  if (rows === null || collection === null || actor.kind !== 'agent') return rows as WidgetRowInput[] | null;
  return (rows as WidgetRowInput[]).map(({ id, ...rest }) => ({ id, ...fenceStrings(rest, 'record') }));
}

/** Words people wrote reach an agent fenced as untrusted data. */
function fenced(actor: AuthUser, text: string): string {
  return actor.kind === 'agent' ? fenceUntrusted(text, 'label') : text;
}

function checkInput(source: unknown, rows: unknown, collection: unknown): WidgetError[] {
  if (collection !== undefined && (typeof collection !== 'string' || !RECORD_COLLECTION_RE.test(collection) || rows !== undefined)) {
    return [{ line: 0, message: 'collection is a records collection name, sent instead of rows.', fix: 'Send rows or collection, not both.' }];
  }
  if (typeof source !== 'string' || source.trim() === '') return [{ line: 0, message: 'source is required.', fix: 'Send the whole module as `source`.' }];
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return [{ line: 0, message: 'source is over 1 MB.', fix: 'Draw from rows instead of typing data into the module.' }];
  if (rows !== undefined && JSON.stringify(rows).length > MAX_ROWS_BYTES) return [{ line: 0, message: 'rows are over 1 MB.', fix: 'Aggregate the rows first.' }];
  return [];
}

/**
 * Renders a draft for both themes and stores it beside the live publish. A new
 * widget's block is placed now (it shows nothing until the first publish); a
 * draft with errors creates nothing and changes no live widget. The previews
 * show the draft as people will see it once published, label edits carried.
 */
export async function draftWidget(actor: AuthUser, documentId: string, req: WidgetDraftRequest): Promise<WidgetResult<WidgetDraftResponse>> {
  const access = await documentAccess(documentId, actor, 'edit');
  if (!access.ok) return access;
  let existing: WidgetRowRecord | null = null;
  if (req.widgetId !== undefined) {
    existing = await loadWidget(req.widgetId);
    if (!existing || existing.documentId !== documentId) return { ok: false, status: 404, refusal: NOT_FOUND };
  }
  const inputErrors = checkInput(req.source, req.rows, req.collection);
  if (inputErrors.length > 0) return invalid('The draft request is invalid.', inputErrors);

  const widgetId = existing?.id ?? uuidv7();
  // A bound draft keeps the records it was drawn from, so its publish is the preview.
  const collection = req.collection ?? null;
  let rows = (req.rows ?? []) as WidgetRow[];
  if (collection !== null) {
    const read = await collectionRows(documentId, collection);
    if ('errors' in read) return invalid('The collection can\'t be drawn.', read.errors);
    rows = read;
  }
  const draftRows = collection !== null || req.rows !== undefined ? rows : null;
  const rendered = await renderBoth(req.source, rows, widgetIdPrefix(widgetId));
  if ('errors' in rendered) {
    if (existing) {
      await db
        .update(widgets)
        .set({ draftSource: req.source, draftRows, draftCollection: collection, draftErrors: rendered.errors, updatedBy: actor.id, updatedAt: new Date() })
        .where(eq(widgets.id, widgetId));
    }
    return invalid(`The draft has ${rendered.errors.length} error${rendered.errors.length === 1 ? '' : 's'}; the live widget is unchanged.`, rendered.errors);
  }

  let blockId: string;
  if (existing) {
    blockId = existing.blockId;
    await db
      .update(widgets)
      .set({ draftSource: req.source, draftRows, draftCollection: collection, draftErrors: null, updatedBy: actor.id, updatedAt: new Date() })
      .where(eq(widgets.id, widgetId));
  } else {
    const placed = await placeBlock(actor, documentId, widgetId, req);
    if (!placed.ok) return placed;
    blockId = placed.value;
    await db.insert(widgets).values({
      id: widgetId,
      documentId,
      blockId,
      draftSource: req.source,
      draftRows, draftCollection: collection,
      updatedBy: actor.id,
    });
  }

  const carried = await carryFor({ documentId, blockId, publishedSvgLight: existing?.publishedSvgLight ?? null }, rendered.light.labels);
  const [light, dark] = await Promise.all([
    rasterise(withLabels(rendered.light.svg, carried.texts), 'light'),
    rasterise(withLabels(rendered.dark.svg, carried.texts), 'dark'),
  ]);
  return {
    ok: true,
    value: {
      widgetId,
      blockId,
      previewHash: rendered.hash,
      png: { light: light.toString('base64'), dark: dark.toString('base64') },
      warnings: rendered.light.warnings,
      labels: carried.outcomes.map((o) => ({ ...o, text: fenced(actor, o.text) })),
    },
  };
}

/** Places a new, empty widget block after `afterBlockId` (or at the end of the tab). */
async function placeBlock(actor: AuthUser, documentId: string, widgetId: string, req: WidgetDraftRequest): Promise<WidgetResult<string>> {
  const tabId = req.tabId ?? MAIN_TAB;
  // A fragment for an unknown or deleted tab is written but never shown.
  if (!(await withLiveDocument(documentId, (doc) => tabsOf(doc).some((t) => t.id === tabId)))) {
    return { ok: false, status: 409, refusal: { code: 'target_missing', message: `Tab ${tabId} does not exist.`, fix: 'Read the document for its tabs and pass a current tabId.' } };
  }
  if (req.afterBlockId !== undefined) {
    const tab = await withLiveDocument(documentId, (doc) => tabOfBlock(doc, req.afterBlockId!));
    if (tab !== tabId) {
      return {
        ok: false,
        status: 409,
        refusal: { code: 'target_changed', message: `Block ${req.afterBlockId} is not in tab ${tabId}.`, fix: 'Read the document again and pass a current block id.' },
      };
    }
  }
  const blockId = uuidv7();
  const container = serverEditor()._blocksToProsemirrorNode([
    { id: blockId, type: 'widget', props: { widgetId, hash: '', textIds: '' } },
  ] as never).firstChild!.firstChild!;
  await applyPlan(documentId, originFor(actor), {
    onConflict: 'refuse',
    edits: [
      {
        target: { tabId, blockId: req.afterBlockId ?? '' },
        inverse: false,
        build: (tr, at) => {
          tr.insert(at ? at.pos + at.node.nodeSize : tr.doc.content.size - 1, container);
        },
      },
    ],
  });
  return { ok: true, value: blockId };
}

/**
 * Publishes the current draft, only if it still renders exactly the preview
 * the agent saw (`previewHash`). In one pipeline plan, each label fragment
 * gets its words (people's edits carried, see `carryLabels`) and the block
 * gets the new hash and text ids, so viewers redraw.
 */
export async function publishWidget(actor: AuthUser, widgetId: string, previewHash: string): Promise<WidgetResult<WidgetPublishResponse>> {
  const row = await loadWidget(widgetId);
  if (!row) return { ok: false, status: 404, refusal: NOT_FOUND };
  const access = await documentAccess(row.documentId, actor, 'edit');
  if (!access.ok) return access;
  if (row.draftSource === null || row.draftErrors !== null) {
    return invalid('There is no valid draft to publish.', (row.draftErrors as WidgetError[] | null) ?? []);
  }
  const rendered = await renderBoth(row.draftSource, (row.draftRows ?? []) as WidgetRow[], widgetIdPrefix(widgetId));
  if ('errors' in rendered) return invalid('The draft no longer renders.', rendered.errors);
  if (rendered.hash !== previewHash) {
    return {
      ok: false,
      status: 409,
      refusal: {
        code: 'widget_invalid',
        message: 'The current draft is not the preview you saw.',
        fix: 'Draft again, look at the new preview, and publish its previewHash.',
        details: { previewHash: rendered.hash },
      },
    };
  }

  const updated = await db
    .update(widgets)
    .set({
      publishedSource: row.draftSource,
      publishedSvgLight: rendered.light.svg,
      publishedSvgDark: rendered.dark.svg,
      publishedHash: rendered.hash,
      rows: row.draftRows,
      collection: row.draftCollection,
      draftSource: null,
      draftRows: null,
      draftCollection: null,
      draftErrors: null,
      updatedBy: actor.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(widgets.id, widgetId),
        eq(widgets.draftSource, row.draftSource),
        sql`${widgets.draftRows} IS NOT DISTINCT FROM ${row.draftRows === null ? null : JSON.stringify(row.draftRows)}::jsonb`,
        sql`${widgets.publishedHash} IS NOT DISTINCT FROM ${row.publishedHash}`,
      ),
    )
    .returning({ id: widgets.id });
  if (updated.length === 0) {
    return {
      ok: false,
      status: 409,
      refusal: { code: 'widget_invalid', message: 'The widget changed while publishing.', fix: 'Read the widget, draft again and publish the new preview.' },
    };
  }

  const theirs = rendered.light.labels;
  const carried = await carryFor(row, theirs);
  const tabId = (await withLiveDocument(row.documentId, (doc) => tabOfBlock(doc, row.blockId))) ?? MAIN_TAB;
  const base = row.publishedSvgLight ? labelsOf(row.publishedSvgLight) : {};
  const edits: PlannedEdit[] = Object.entries(theirs).map(([textId, agentText]) =>
    carryEdit({ tabId, blockId: row.blockId, textId }, base[textId], agentText),
  );
  edits.push({
    target: { tabId, blockId: row.blockId },
    inverse: false,
    build: (tr, at) => {
      if (!at) return; // a person deleted the block: the widget stays unplaced
      const content = at.node.firstChild!;
      tr.setNodeMarkup(at.pos + 1, undefined, { ...content.attrs, hash: rendered.hash, textIds: Object.keys(theirs).join(' ') });
    },
  });
  const result = await applyPlan(row.documentId, originFor(actor), { onConflict: 'refuse', edits });
  return {
    ok: true,
    value: { widgetId, blockId: row.blockId, publishedHash: rendered.hash, docVersion: result.docVersion, labels: carried.outcomes.map((o) => ({ ...o, text: fenced(actor, o.text) })) },
  };
}

export async function getWidget(actor: AuthUser, widgetId: string): Promise<WidgetResult<WidgetDTO>> {
  const row = await loadWidget(widgetId);
  if (!row) return { ok: false, status: 404, refusal: NOT_FOUND };
  const access = await documentAccess(row.documentId, actor, 'read');
  if (!access.ok) return access;
  const labels = await labelList(row, actor);
  return {
    ok: true,
    value: {
      id: row.id,
      documentId: row.documentId,
      blockId: row.blockId,
      source: row.publishedSource,
      rows: fencedRows(actor, row.rows, row.collection),
      collection: row.collection,
      publishedHash: row.publishedHash,
      labels,
      draft:
        row.draftSource === null
          ? null
          : { source: row.draftSource, rows: fencedRows(actor, row.draftRows, row.draftCollection), collection: row.draftCollection, errors: row.draftErrors as WidgetError[] | null },
      updatedAt: row.updatedAt.toISOString(),
    },
  };
}

/** The live widget as people see it (people's label edits applied), as SVG or PNG. */
export async function widgetImage(
  actor: AuthUser,
  widgetId: string,
  theme: WidgetTheme,
  format: 'svg' | 'png',
): Promise<WidgetResult<{ svg: string } | { png: Buffer }>> {
  const row = await loadWidget(widgetId);
  if (!row) return { ok: false, status: 404, refusal: NOT_FOUND };
  const access = await documentAccess(row.documentId, actor, 'read');
  if (!access.ok) return access;
  const published = theme === 'light' ? row.publishedSvgLight : row.publishedSvgDark;
  if (!published) {
    return { ok: false, status: 404, refusal: { code: 'not_found', message: 'The widget has not been published yet.', fix: 'Publish a draft first.' } };
  }
  const svg = withLabels(published, await currentLabels(row));
  return { ok: true, value: format === 'svg' ? { svg } : { png: await rasterise(svg, theme) } };
}

export type { WidgetLabelOutcome };
