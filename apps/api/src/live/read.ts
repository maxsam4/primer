import * as Y from 'yjs';
import type { Node as PmNode } from '@tiptap/pm/model';
import { sql } from 'drizzle-orm';
import type { LiveBlockDTO, LiveDocDTO, LivePageDTO, LiveReadFormat, Refusal, Target, ViewerContext } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { readableLiveDoc } from '../lib/liveThreads.ts';
import { blockVersion, findBlock } from './blocks.ts';
import { DECISION_PROPS } from './export.ts';
import { serverEditor, type PrimerBlock } from './editor.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { fragmentDoc } from './marks.ts';
import type { AppliedBlock } from './pipeline.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { BLOCK_ELEMENTS, persistedUpTo } from './persist.ts';
import { MAIN_TAB, fragmentFor, pageBlocks, tabFragmentName, tabsOf, blockOfFragment } from './reach.ts';
import { fenceUntrusted } from '../lib/untrusted.ts';
import { loadStamped } from '../page/publish.ts';
import { readPidText } from '../page/text.ts';
import type { Storage } from '../storage/types.ts';

export type LiveReadOptions = {
  format: LiveReadFormat;
  /** Blocks from `from` to `to` (inclusive) in reading order. */
  range?: { from: Target; to: Target };
  /** Only blocks changed after this docVersion, plus `deletedIds`. */
  since?: number;
  tabId?: string;
  /** Fills `viewer` from the run's request (what the asker was looking at). */
  viewer?: ViewerContext;
  /** Where page sources are stored; with it, page blocks are listed in `pages`. */
  storage?: Storage;
};

export type LiveReadResult = { ok: true; value: LiveDocDTO } | { ok: false; status: 400 | 404; refusal: Refusal };

/**
 * A live document read for agents: one tab's blocks, each with its real id,
 * its `version` (the precondition for edits) and its place in the tree. Reads
 * the in-memory Y.Doc the hub and the pipeline share; `docVersion` is the
 * stored version of exactly the content returned.
 */
export async function getLiveDoc(documentId: string, actor: AuthUser, opts: LiveReadOptions): Promise<LiveReadResult> {
  const doc = await readableLiveDoc(documentId, actor);
  if (!doc) {
    return {
      ok: false,
      status: 404,
      refusal: { code: 'not_found', message: 'Live document not found.', fix: 'Check the id; list documents with primer_list_documents.' },
    };
  }
  const tabId = opts.tabId ?? MAIN_TAB;

  const snapshot = await withDoc(documentId, (ydoc) => {
    if (!tabsOf(ydoc).some((t) => t.id === tabId)) return null;
    const pmDoc = fragmentDoc(ydoc.getXmlFragment(tabFragmentName(tabId)));
    // Only a `since` read needs the ids present in every tab.
    const present = new Set<string>();
    if (opts.since !== undefined) {
      for (const tab of tabsOf(ydoc)) {
        for (const id of blockIds(fragmentDoc(ydoc.getXmlFragment(tabFragmentName(tab.id))))) present.add(id);
      }
    }
    // Taken in the same tick as the content, so it names exactly this state.
    const stored = persistedUpTo(ydoc);
    return { pmDoc, present, roots: new Set(ydoc.share.keys()), stored };
  });
  if (!snapshot) {
    return {
      ok: false,
      status: 404,
      refusal: { code: 'not_found', message: `Tab ${tabId} not found.`, fix: 'Read the main tab (tabId "main") to list tabs.' },
    };
  }
  const docVersion = await snapshot.stored;

  let flat = flatten(snapshot.pmDoc, tabId);
  if (opts.range) {
    const from = flat.findIndex((b) => b.block.id === opts.range!.from.blockId);
    const to = flat.findIndex((b) => b.block.id === opts.range!.to.blockId);
    if (from < 0 || to < 0 || to < from) {
      return {
        ok: false,
        status: 400,
        refusal: {
          code: 'bad_request',
          message: 'The range does not name two blocks of this tab in reading order.',
          fix: 'Read the whole tab and pass block ids from it as range.from and range.to.',
        },
      };
    }
    flat = flat.slice(from, to + 1);
  }

  let deletedIds: string[] | undefined;
  let touched: Set<string> | undefined;
  if (opts.since !== undefined) {
    touched = await touchedSince(documentId, opts.since, docVersion);
    const changed = touched;
    flat = flat.filter((b) => changed.has(b.block.id));
    deletedIds = [...changed].filter((id) => !snapshot.present.has(id) && !snapshot.roots.has(id));
  }

  const blocks: LiveBlockDTO[] = [];
  for (const entry of flat) blocks.push(await toDTO(entry, opts.format));
  const value: LiveDocDTO = { documentId, docVersion, at: 'live', format: opts.format, tabId, blocks };
  if (opts.storage && !opts.range) {
    // A `since` read carries the pages whose text or embeds changed.
    const pages = await readPages(opts.storage, documentId, tabId, touched);
    if (pages.length > 0) value.pages = pages;
  }
  if (deletedIds) value.deletedIds = deletedIds;
  if (opts.viewer) value.viewer = opts.viewer;
  return { ok: true, value };
}

type FlatBlock = { block: PrimerBlock; version: string; depth: number; parentId: string | null; tabId: string };

/** The tab's blocks depth-first, children after their parent. */
function flatten(pmDoc: PmNode, tabId: string): FlatBlock[] {
  const versions = new Map<string, string>();
  pmDoc.descendants((node) => {
    if (BLOCK_ELEMENTS.has(node.type.name)) versions.set(node.attrs.id as string, blockVersion(node));
    return true;
  });
  const out: FlatBlock[] = [];
  const walk = (blocks: PrimerBlock[], depth: number, parentId: string | null) => {
    for (const block of blocks) {
      out.push({ block, version: versions.get(block.id) ?? '', depth, parentId, tabId });
      walk(block.children as PrimerBlock[], depth + 1, block.id);
    }
  };
  walk(pmDoc.childCount === 0 ? [] : serverEditor()._prosemirrorJSONToBlocks(pmDoc.toJSON()), 0, null);
  return out;
}

/** A choice's decision slots are the server's to fill (the document's own are
 *  editor-writable, so a forged decision must not read as a real one). */
function withoutDecision(block: PrimerBlock): PrimerBlock {
  if (block.type !== 'choice') return block;
  const props: Record<string, unknown> = { ...block.props };
  for (const key of DECISION_PROPS) props[key] = '';
  return { ...block, props } as PrimerBlock;
}

async function toDTO(entry: FlatBlock, format: LiveReadFormat): Promise<LiveBlockDTO> {
  const block = withoutDecision(entry.block);
  const own = { ...block, children: [] } as PrimerBlock;
  const dto: LiveBlockDTO = {
    target: { tabId: entry.tabId, blockId: block.id },
    type: block.type,
    version: entry.version,
    depth: entry.depth,
    parentId: entry.parentId,
  };
  const editor = serverEditor();
  if (format === 'markdown') dto.markdown = (await editor.blocksToMarkdownLossy([own] as never)).trimEnd();
  else if (format === 'html') dto.html = await editor.blocksToHTMLLossy([own] as never);
  else dto.json = { id: block.id, type: block.type, props: block.props, content: block.content } as Record<string, unknown>;
  return dto;
}

function blockIds(pmDoc: PmNode): string[] {
  const ids: string[] = [];
  pmDoc.descendants((node) => {
    if (BLOCK_ELEMENTS.has(node.type.name)) ids.push(node.attrs.id as string);
    return true;
  });
  return ids;
}

/** Block ids (and auxiliary root names) the updates after `since` touched. */
async function touchedSince(documentId: string, since: number, upTo: number): Promise<Set<string>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT unnest(touched) AS id FROM doc_updates WHERE document_id = ${documentId} AND id > ${since} AND id <= ${upTo}
  `)) as unknown as { id: string }[];
  const touched = new Set(rows.map((r) => r.id));
  // Text edited in a page (or an embed, a widget label) changes its block.
  for (const id of [...touched]) {
    const block = blockOfFragment(id);
    if (block) touched.add(block);
  }
  return touched;
}

async function withDoc<T>(documentId: string, fn: (doc: Y.Doc) => T): Promise<T> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), SYSTEM_ORIGIN);
  try {
    return fn(connection.document!);
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}

/** A block an edit just stored, as the Markdown read returns it (its
 *  children included). */
export async function appliedBlockDTO(applied: AppliedBlock, tabId: string): Promise<LiveBlockDTO> {
  const schema = serverEditor().editor.pmSchema;
  const doc = schema.topNodeType.create(null, schema.nodes.blockGroup!.create(null, applied.node));
  const [block] = serverEditor()._prosemirrorJSONToBlocks(doc.toJSON());
  return {
    target: { tabId, blockId: applied.node.attrs.id as string },
    type: block!.type,
    version: blockVersion(applied.node),
    markdown: (await serverEditor().blocksToMarkdownLossy([block!] as never)).trimEnd(),
    depth: applied.depth,
    parentId: applied.parentId,
  };
}

/** Pages and pids an agent read lists at most. */
const MAX_PAGES = 20;
const MAX_PIDS = 5000;

/** The tab's page blocks for an agent: the stamped source, and each pid's
 *  current text (fenced: people write it) with its version. Page refs come
 *  from the editor-writable document, so a page whose source can't be read
 *  is listed as unavailable and never fails the read. */
async function readPages(storage: Storage, documentId: string, tabId: string, only?: Set<string>): Promise<LivePageDTO[]> {
  const refs = await withDoc(documentId, (ydoc) =>
    pageBlocks(ydoc)
      .filter((p) => p.tabId === tabId && (!only || only.has(p.blockId)))
      .slice(0, MAX_PAGES)
      .map((p) => ({
        ref: p,
        texts: p.pids.slice(0, MAX_PIDS).map((pid) => {
          const target: Target = { tabId, blockId: p.blockId, pid };
          const at = findBlock(fragmentDoc(fragmentFor(ydoc, target)), p.blockId);
          return { target, text: fenceUntrusted(readPidText(ydoc, target), 'pagetext'), version: at ? blockVersion(at.node) : '' };
        }),
      })),
  );
  const sources = new Map<string, Promise<string | null>>();
  const out: LivePageDTO[] = [];
  for (const { ref, texts } of refs) {
    if (!sources.has(ref.sourceKey)) sources.set(ref.sourceKey, loadStamped(storage, documentId, ref));
    const source = await sources.get(ref.sourceKey)!;
    const target = { tabId, blockId: ref.blockId };
    out.push(source === null ? { target, source: null, texts: [] } : { target, source, texts });
  }
  return out;
}
