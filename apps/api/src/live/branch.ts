import * as Y from 'yjs';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { BlockPlace, ProposeBranchResponse, Refusal, Target } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents, widgets as widgetsTable } from '../db/schema.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { readableLiveDoc } from '../lib/liveThreads.ts';
import { canEdit, canManage } from '../lib/permissions.ts';
import type { Storage } from '../storage/types.ts';
import { blockVersion, findBlock } from './blocks.ts';
import { referencedFiles } from './bundle.ts';
import { rewriteIds } from './copy.ts';
import { withLiveDocument } from './instance.ts';
import { fragmentDoc } from './marks.ts';
import { removeBlock } from './ops.ts';
import { originFor } from './origin.ts';
import { applyPlan, contentVersion, indexBlocks, type PlannedEdit } from './pipeline.ts';
import { docQueue } from './queue.ts';
import { fragmentName, pageBlocks, tabFragmentName, tabsOf, targetOfFragment, widgetLabelFragments } from './reach.ts';
import { insertAt } from './undo.ts';
import { isOwnSourceKey } from '../page/publish.ts';
import { widgetBlocks } from '../widgets/bundle.ts';
import { renderBoth, widgetIdPrefix } from '../widgets/render.ts';

export type ProposeResult = { ok: true; value: ProposeBranchResponse } | { ok: false; status: 400 | 403 | 404; refusal: Refusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Proposes a branch back to its parent as one change set (plan M10c.1). Per
 * tab and per block id, three versions are compared: base (the parent as
 * branched), parent (now) and branch (now, its thread and file ids mapped
 * back to the parent's):
 *
 * | branch      | parent      | result                                   |
 * |-------------|-------------|------------------------------------------|
 * | unchanged   | any         | nothing (never a revert of the parent)   |
 * | changed     | unchanged   | a suggestion                             |
 * | changed     | changed     | a suggestion marked `conflict`           |
 * | same change | same change | nothing                                  |
 * | new         | —           | a suggestion (runs of new siblings: one) |
 * | removed     | unchanged   | a suggestion to remove it                |
 * | removed     | changed     | a conflict                               |
 * | changed     | removed     | a conflict that adds it back             |
 *
 * "Changed" is a block's own content (children compare as blocks of their
 * own) or its place among the blocks both sides still have. Every edit
 * checks the parent's live block inside the pipeline, so a parent edit made
 * meanwhile is a conflict too, never overwritten. The change set's id is the
 * branch's id; proposing again withdraws the set's open suggestions first.
 */
export async function proposeBranch(storage: Storage, actor: AuthUser, branchId: string): Promise<ProposeResult> {
  const notFound: ProposeResult = { ok: false, status: 404, refusal: { code: 'not_found', message: 'Branch not found.', fix: 'Check the document id.' } };
  if (!UUID.test(branchId)) return notFound;
  const branch = await readableLiveDoc(branchId, actor);
  if (!branch) return notFound;
  const [row] = await db
    .select({ parentId: documents.branchOf, base: documents.branchBaseState })
    .from(documents)
    .where(eq(documents.id, branchId));
  if (!row?.parentId || !row.base) {
    return { ok: false, status: 400, refusal: { code: 'bad_request', message: 'This document is not a branch.', fix: 'Branch the document first, then propose the branch.' } };
  }
  if (!canManage(branch.role)) {
    return { ok: false, status: 403, refusal: { code: 'forbidden', message: 'Only the branch\'s owner can propose it.', fix: 'Ask its owner.' } };
  }
  const parent = await readableLiveDoc(row.parentId, actor);
  if (!parent) {
    return { ok: false, status: 404, refusal: { code: 'not_found', message: 'The branch\'s parent document is gone.', fix: 'Fork the branch into a document of its own instead.' } };
  }
  if (!canEdit(parent.role)) {
    return {
      ok: false,
      status: 403,
      refusal: { code: 'forbidden', message: 'Only the owner and editors of the parent can propose a branch to it.', fix: 'Ask for editor access, or comment on the parent instead.' },
    };
  }
  const parentId = parent.id;

  const ids = await idsToParent(storage, branchId, parentId);
  const baseDoc = new Y.Doc();
  Y.applyUpdate(baseDoc, row.base);
  const owned = await ownedToParent(storage, branchId, parentId, baseDoc, ids);
  const baseTabs = new Set(tabsOf(baseDoc).map((t) => t.id));
  const fragments = await withLiveDocument(branchId, (doc) =>
    fragmentsOf(doc).map((target) => {
      const tr = new Transform(fragmentDoc(doc.getXmlFragment(fragmentName(target))));
      rewriteIds(tr, 'branch', ids, owned);
      return { target, branch: tr.doc };
    }),
  );
  const edits: PlannedEdit[] = [];
  for (const { target, branch } of fragments) {
    const base = fragmentDoc(baseDoc.getXmlFragment(fragmentName(target)));
    if (!target.blockId && !baseTabs.has(target.tabId)) edits.push(newTabEdit(target.tabId));
    else if (target.embedId) {
      if (!branch.eq(base)) edits.push(embedEdit(target));
    } else edits.push(...tabEdits(target, base, branch, owned.refused));
  }
  baseDoc.destroy();
  const plan = [...edits.filter((e) => !owned.refused.has(e.target.blockId)), ...owned.refused.values()];

  await docQueue(parentId)(() => withdrawOpenSet(parentId, branchId, actor));
  const result = await applyPlan(parentId, originFor(actor), { edits: plan, onConflict: 'suggest', mode: 'suggest', changeSetId: branchId });
  return { ok: true, value: { ...result, documentId: parentId, changeSetId: branchId } };
}

/**
 * Branch ids → the parent's: threads copied from the parent's own threads,
 * files copied from the parent's own files. Files the branch added are
 * copied into the parent once, so a suggestion's links resolve there. Every
 * lookup is scoped by document (the ids come from editable content).
 */
async function idsToParent(storage: Storage, branchId: string, parentId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const threadRows = (await db.execute(sql`
    SELECT t.id, t.copied_from AS "from" FROM threads t JOIN threads p ON p.id = t.copied_from AND p.document_id = ${parentId}
     WHERE t.document_id = ${branchId}
  `)) as unknown as { id: string; from: string }[];
  for (const t of threadRows) ids.set(t.id, t.from);

  const used = await withLiveDocument(branchId, (doc) => referencedFiles(doc, branchId));
  if (used.length === 0) return ids;
  const fileRows = (await db.execute(sql`
    SELECT f.id, f.storage_key AS "storageKey", f.content_type AS "contentType", f.size_bytes AS "sizeBytes", f.uploaded_by AS "uploadedBy",
           COALESCE(p.id, q.id) AS "parentFile"
      FROM doc_files f
      LEFT JOIN doc_files p ON p.id = f.copied_from AND p.document_id = ${parentId}
      -- A file the branch added and an earlier proposal already copied over.
      LEFT JOIN LATERAL (SELECT id FROM doc_files WHERE copied_from = f.id AND document_id = ${parentId} LIMIT 1) q ON true
     WHERE f.document_id = ${branchId} AND f.id IN (${sql.join(used.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { id: string; storageKey: string; contentType: string; sizeBytes: number; uploadedBy: string; parentFile: string | null }[];
  for (const f of fileRows) {
    if (f.parentFile) {
      ids.set(f.id, f.parentFile);
      continue;
    }
    const id = uuidv7();
    const storageKey = `files/${parentId}/${id}`;
    await storage.put(storageKey, new Uint8Array(await new Response(await storage.get(f.storageKey)).arrayBuffer()));
    await db.execute(sql`
      INSERT INTO doc_files (id, document_id, storage_key, content_type, size_bytes, uploaded_by, copied_from)
      VALUES (${id}, ${parentId}, ${storageKey}, ${f.contentType}, ${f.sizeBytes}, ${f.uploadedBy}, ${f.id})
    `);
    ids.set(f.id, id);
  }
  return ids;
}

/** Every fragment the branch's content reaches: each tab's, then the page
 *  text, embed and widget label fragments of its blocks, as targets. */
function fragmentsOf(doc: Y.Doc): Target[] {
  const out: Target[] = [];
  for (const tab of tabsOf(doc)) {
    out.push({ tabId: tab.id, blockId: '' });
    for (const name of widgetLabelFragments(doc.getXmlFragment(tabFragmentName(tab.id)))) out.push(targetOfFragment(name, tab.id)!);
  }
  for (const page of pageBlocks(doc)) {
    for (const pid of page.pids) out.push({ tabId: page.tabId, blockId: page.blockId, pid });
    for (const embedId of page.embeds) out.push({ tabId: page.tabId, blockId: page.blockId, embedId });
  }
  return out;
}

type Owned = { pageSources: Map<string, string>; widgetHashes: Map<string, string>; refused: Map<string, PlannedEdit> };

/**
 * The branch's own page sources and widget rows → the parent's, by block id
 * against the base (the copy made them for the same blocks): a page whose
 * stamped source is still the copy of the base's maps to the base's key, a
 * widget whose published row still renders, under the base's id, to the
 * base's hash maps to the base's row and hash. A page or widget republished
 * or added on the branch names something only the branch has: those blocks
 * are refused rather than proposed.
 */
async function ownedToParent(storage: Storage, branchId: string, parentId: string, baseDoc: Y.Doc, ids: Map<string, string>): Promise<Owned> {
  const owned: Owned = { pageSources: new Map(), widgetHashes: new Map(), refused: new Map() };
  const { pages, widgets } = await withLiveDocument(branchId, (doc) => ({ pages: pageBlocks(doc), widgets: widgetBlocks(doc) }));
  const basePages = new Map(pageBlocks(baseDoc).map((p) => [p.blockId, p]));
  const read = async (key: string) => new Response(await storage.get(key)).text();
  for (const page of pages) {
    if (!isOwnSourceKey(branchId, page.sourceKey)) continue;
    const base = basePages.get(page.blockId);
    if (base && isOwnSourceKey(parentId, base.sourceKey) && (await read(page.sourceKey)) === (await read(base.sourceKey))) {
      owned.pageSources.set(page.sourceKey, base.sourceKey);
    } else owned.refused.set(page.blockId, branchOnlyEdit(page, 'The page'));
  }
  const baseWidgets = new Map(widgetBlocks(baseDoc).map((w) => [w.blockId, w]));
  for (const widget of widgets) {
    const base = baseWidgets.get(widget.blockId);
    if (!base || (await widgetHash(branchId, widget.widgetId, base.widgetId)) !== base.hash) {
      owned.refused.set(widget.blockId, branchOnlyEdit(widget, 'The widget'));
      continue;
    }
    ids.set(widget.widgetId.toLowerCase(), base.widgetId);
    owned.widgetHashes.set(base.widgetId, base.hash);
  }
  return owned;
}

/** The hash the branch's widget row would publish under the parent's id
 * (the copy re-rendered it under the branch's own). */
async function widgetHash(branchId: string, widgetId: string, parentWidgetId: string): Promise<string> {
  const [row] = await db
    .select({ source: widgetsTable.publishedSource, rows: widgetsTable.rows })
    .from(widgetsTable)
    .where(sql`${widgetsTable.id} = ${widgetId} AND ${widgetsTable.documentId} = ${branchId}`);
  if (!row?.source) return '';
  const rendered = await renderBoth(row.source, (row.rows ?? []) as never, widgetIdPrefix(parentWidgetId));
  return 'errors' in rendered ? '' : rendered.hash;
}

function branchOnlyEdit(block: { tabId?: string; blockId: string }, what: string): PlannedEdit {
  return {
    target: { tabId: block.tabId ?? 'main', blockId: block.blockId },
    inverse: false,
    build: () => ({
      code: 'target_missing',
      message: `${what} in block ${block.blockId} was added or republished on the branch; it can't be proposed.`,
      fix: 'Publish it on the parent instead.',
      details: { blockId: block.blockId },
    }),
  };
}

/** Withdraws the open suggestions of an earlier proposal of this branch. */
async function withdrawOpenSet(parentId: string, branchId: string, actor: AuthUser): Promise<void> {
  await transactionWithEvents(async (tx, emit) => {
    const rows = (await tx.execute(sql`
      UPDATE suggestions SET status = 'withdrawn', decided_by = ${actor.id}, decided_at = now()
       WHERE document_id = ${parentId} AND change_set_id = ${branchId} AND status = 'open'
      RETURNING id
    `)) as unknown as { id: string }[];
    for (const r of rows) {
      emit({
        documentId: parentId,
        actorId: actor.id,
        type: 'suggestion.decided',
        payload: { document_id: parentId, suggestion_id: r.id, decision: 'withdrawn', by: actor.id },
      });
    }
  });
}

type Tree = { index: ReturnType<typeof indexBlocks>; order: string[]; siblings: Map<string, string[]> };

function tree(root: PmNode): Tree {
  const index = indexBlocks(root);
  const siblings = new Map<string, string[]>();
  for (const [id, b] of index) {
    const key = b.place.parentId ?? '';
    siblings.set(key, [...(siblings.get(key) ?? []), id]);
  }
  const order: string[] = [];
  root.descendants((node) => {
    if (node.type.name === 'blockContainer') order.push(node.attrs.id as string);
    return true;
  });
  return { index, order, siblings };
}

/**
 * The blocks `other` moved relative to `base`: those under another parent,
 * and, among siblings both still have under the same parent, those outside
 * the longest run kept in base order (so moving one block marks only it,
 * not its new neighbours).
 */
function movedBlocks(base: Tree, other: Tree): Set<string> {
  const moved = new Set<string>();
  for (const [parentKey, sibs] of other.siblings) {
    const kept: string[] = [];
    for (const id of sibs) {
      const b = base.index.get(id);
      if (!b) continue;
      if ((b.place.parentId ?? '') !== parentKey) moved.add(id);
      else kept.push(id);
    }
    const baseOrder = base.siblings.get(parentKey) ?? [];
    const rank = kept.map((id) => baseOrder.indexOf(id));
    const stay = new Set(longestIncreasing(rank).map((i) => kept[i]!));
    for (const id of kept) if (!stay.has(id)) moved.add(id);
  }
  return moved;
}

/** Indexes of a longest strictly increasing subsequence of `xs`. */
function longestIncreasing(xs: number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = new Array(xs.length).fill(-1);
  xs.forEach((x, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]!]! < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) out.unshift(i);
  return out;
}

/** The edits of one fragment (`at`: its target, without a block id). */
function tabEdits(at: Target, baseRoot: PmNode, branchRoot: PmNode, refused: Map<string, PlannedEdit>): PlannedEdit[] {
  const base = tree(baseRoot);
  const branch = tree(branchRoot);
  const movedOnBranch = movedBlocks(base, branch);
  const edits: PlannedEdit[] = [];
  let run: { nodes: PmNode[]; place: BlockPlace } | null = null;

  for (const id of branch.order) {
    const r = branch.index.get(id)!;
    const b = base.index.get(id);
    if (!b) {
      const parentNew = r.place.parentId !== null && !base.index.has(r.place.parentId);
      if (parentNew) continue;
      // A new block holding a refused one isn't proposed: it would carry it in.
      if (holdsAny(r.node, refused)) {
        run = null;
        continue;
      }
      // Consecutive new siblings go in one edit: a suggestion builds against
      // the parent as it is, so separate ones would all anchor the same way.
      if (run && run.nodes.at(-1)!.attrs.id === r.place.prevId) run.nodes.push(r.node);
      else {
        run = { nodes: [r.node], place: r.place };
        edits.push(insertRunEdit(at, run));
      }
      continue;
    }
    const changed = contentVersion(r.node) !== contentVersion(b.node);
    const moved = movedOnBranch.has(id);
    if (changed || moved) edits.push(updateEdit({ ...at, blockId: id }, b.node, r.node, r.place, base, changed, moved));
  }
  for (const id of base.order) {
    const b = base.index.get(id)!;
    if (branch.index.has(id)) continue;
    if (b.place.parentId !== null && !branch.index.has(b.place.parentId)) continue;
    edits.push(removeEdit({ ...at, blockId: id }, b.node));
  }
  return edits;
}

function holdsAny(node: PmNode, ids: Map<string, PlannedEdit>): boolean {
  let found = ids.has(node.attrs.id as string);
  node.descendants((child) => {
    if (child.type.name === 'blockContainer' && ids.has(child.attrs.id as string)) found = true;
    return !found;
  });
  return found;
}

function bothChanged(target: Target, why: string): Refusal {
  return {
    code: 'target_changed',
    message: `Block ${target.blockId} ${why} in the parent since the branch was made; the branch's version is a conflict to decide.`,
    fix: 'Decide the conflict: accept the branch\'s version or reject it.',
    details: { blockId: target.blockId },
  };
}

function updateEdit(
  target: Target,
  baseNode: PmNode,
  branchNode: PmNode,
  place: BlockPlace,
  base: Tree,
  changed: boolean,
  moved: boolean,
): PlannedEdit {
  const id = target.blockId;
  return {
    target,
    inverse: false,
    build: (tr, at, ctx) => {
      if (!at) {
        if (!ctx.suggesting) return bothChanged(target, 'was removed');
        return insertAt(tr, branchNode, place);
      }
      const content = changed && contentVersion(branchNode) !== contentVersion(at.node);
      const parentChanged = contentVersion(at.node) !== contentVersion(baseNode);
      const parentMoved = moved && movedBlocks(base, tree(tr.doc)).has(id);
      if (!ctx.suggesting && ((content && parentChanged) || (moved && parentMoved))) {
        return bothChanged(target, content && parentChanged ? 'was edited' : 'was moved');
      }
      if (content) tr.replaceWith(at.pos + 1, at.pos + 1 + at.node.firstChild!.nodeSize, branchNode.firstChild!);
      if (moved) {
        const now = findBlock(tr.doc, id)!;
        const removed = removeBlock(tr, now);
        if (removed) return removed;
        ctx.moved(id);
        return insertAt(tr, now.node, place);
      }
    },
  };
}

function insertRunEdit(at: Target, run: { nodes: PmNode[]; place: BlockPlace }): PlannedEdit {
  return {
    target: { ...at, blockId: run.nodes[0]!.attrs.id as string },
    inverse: false,
    build: (tr) => {
      // Already there (proposed and accepted before): nothing to add.
      if (findBlock(tr.doc, run.nodes[0]!.attrs.id as string)) return;
      let place = run.place;
      for (const node of run.nodes) {
        const refused = insertAt(tr, node, place);
        if (refused) return refused;
        place = { parentId: place.parentId, prevId: node.attrs.id as string, nextId: null };
      }
    },
  };
}

function removeEdit(target: Target, baseNode: PmNode): PlannedEdit {
  return {
    target,
    inverse: false,
    build: (tr, at, ctx) => {
      if (!at) return;
      if (!ctx.suggesting && blockVersion(at.node) !== blockVersion(baseNode)) return bothChanged(target, 'was edited');
      return removeBlock(tr, at);
    },
  };
}

/** An embed edited on the branch: its blocks can't be addressed by a
 *  suggestion yet, so the change is refused rather than dropped. */
function embedEdit(target: Target): PlannedEdit {
  return {
    target,
    inverse: false,
    build: () => ({
      code: 'target_missing',
      message: `Embed ${target.embedId} of block ${target.blockId} was edited on the branch; embeds can't be proposed yet.`,
      fix: 'Make the same edit to the embed on the parent.',
      details: { blockId: target.blockId, embedId: target.embedId },
    }),
  };
}

/** A tab made on the branch: tabs aren't blocks, so it can't be suggested. */
function newTabEdit(tabId: string): PlannedEdit {
  return {
    target: { tabId, blockId: '' },
    inverse: false,
    build: () => ({
      code: 'target_missing',
      message: `Tab ${tabId} was added on the branch; tabs can't be proposed.`,
      fix: 'Add the tab to the parent and copy its content by hand.',
      details: { tabId },
    }),
  };
}
