// HTML publishes as live page documents (M6.2, M6.5): the upload is stamped,
// its stamped source stored once, and the document holds one `page` block
// whose text and embeds live in sub-fragments. A republish carries people's
// text over three ways and stores the new stamped source.
import * as Y from 'yjs';
import { sql } from 'drizzle-orm';
import { Transform } from '@tiptap/pm/transform';
import { updateYFragment } from 'y-prosemirror';
import { v7 as uuidv7 } from 'uuid';
import type { Reconciliation, Refusal } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { effectiveAgentMode } from '../lib/permissions.ts';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';
import { findBlock } from '../live/blocks.ts';
import { serverEditor } from '../live/editor.ts';
import { liveDocName, liveInstance } from '../live/instance.ts';
import { SYSTEM_ORIGIN, originFor } from '../live/origin.ts';
import { applyPlan, type PlannedEdit } from '../live/pipeline.ts';
import { MAIN_TAB, fragmentFor, pageBlocks, tabFragmentName, type PageRef } from '../live/reach.ts';
import { pmDocOf, writeSources } from '../live/sources.ts';
import type { Storage } from '../storage/types.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { planCarry, type CarryDecision } from './carry.ts';
import { readEmbeds, type Embed } from './embeds.ts';
import { renderPage, seedPage } from './page.ts';
import { MAX_NESTING, PageTooDeep, readPids, stampPage, type PidInfo } from './stamp.ts';
import { setPidText } from './text.ts';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The storage key of the stamped source published with checkpoint
 *  `versionId`: inside the document's own prefix, and found again from the
 *  version row when the document is purged. */
export function sourceKeyOf(documentId: string, versionId: string): string {
  return `pages/${documentId}/${versionId}.html`;
}

/** Whether `key` names a stamped source of this document. Page block props
 *  are editor-writable, so every read checks this first. */
export function isOwnSourceKey(documentId: string, key: string): boolean {
  return new RegExp(`^pages/${documentId}/${UUID}\\.html$`).test(key) && new RegExp(`^${UUID}$`).test(documentId);
}

/**
 * The stamped source of a page block, or null when its key isn't this
 * document's or can't be read. Page block props are editor-writable, so a
 * bad key is an editor's doing and must never fail a whole read.
 */
export async function loadStamped(storage: Storage, documentId: string, page: PageRef): Promise<string | null> {
  if (!isOwnSourceKey(documentId, page.sourceKey)) return null;
  try {
    return await new Response(await storage.get(page.sourceKey)).text();
  } catch (err) {
    logger.warn({ documentId, blockId: page.blockId, err }, 'page: stamped source unreadable');
    return null;
  }
}

/** The page block of a page document (its first). */
export function mainPage(doc: Y.Doc): PageRef | null {
  return pageBlocks(doc)[0] ?? null;
}

export type PreparedPage = { stamped: string; pids: PidInfo[]; uncertain: string[]; embeds: Embed[] };

/** Stamps an upload, refusing a page whose `<primer-*>` blocks lack literal ids or that doesn't sanitize. */
export function preparePage(original: string, previous: PidInfo[] = [], taken: string[] = []): PreparedPage | { refusal: Refusal } {
  try {
    const read = readEmbeds(original);
    if ('refusal' in read) return read;
    const { stamped, pids, uncertain } = stampPage(original, previous, taken);
    const served = transformHtml(stamped);
    if (!served.ok) return { refusal: { code: 'bad_request', message: served.message, fix: 'Fix the content and publish again.', details: { error: 'parse_failed' } } };
    return { stamped, pids, uncertain, embeds: read.embeds };
  } catch (err) {
    if (err instanceof PageTooDeep || err instanceof RangeError) {
      return { refusal: { code: 'bad_request', message: `The page nests elements more than ${MAX_NESTING} levels deep.`, fix: 'Flatten the page and publish again.', details: { error: 'parse_failed' } } };
    }
    throw err;
  }
}

const pageProps = (sourceKey: string, title: string, page: PreparedPage) => ({
  sourceKey,
  title,
  pids: page.pids.map((p) => p.pid).join(' '),
  embeds: page.embeds.map((e) => e.embedId).join(' '),
});

/**
 * A new page document's Y.Doc, built detached (it becomes the document's
 * first update): one page block in the main tab, each pid's fragment seeded
 * with its text and each embed's with its blocks.
 */
export async function buildPageDoc(documentId: string, title: string, page: PreparedPage, sourceKey: string): Promise<{ doc: Y.Doc; blockId: string }> {
  const doc = new Y.Doc();
  const blockId = uuidv7();
  const main = doc.getXmlFragment(tabFragmentName(MAIN_TAB));
  serverEditor().blocksToYXmlFragment([{ id: blockId, type: 'page', props: pageProps(sourceKey, title, page) }] as never, main);
  for (const edit of await seedPage({ tabId: MAIN_TAB, blockId, stamped: page.stamped, pids: page.pids })) {
    const fragment = fragmentFor(doc, edit.target);
    const tr = new Transform(pmDocOf(fragment));
    edit.build(tr, findBlock(tr.doc, edit.target.blockId), { moved: () => undefined, suggesting: false });
    if (tr.docChanged) updateYFragment(doc, fragment, tr.doc, { mapping: new Map(), isOMark: new Map() });
  }
  writeSources(doc, documentId, new Map(), { format: 'html', frontMatter: '', lead: '' });
  return { doc, blockId };
}

/**
 * Re-anchors threads by quote on a freshly built page (a legacy document
 * becoming a page): a quote found exactly once in the page's text gets the
 * thread's comment mark there. Returns the ids of the threads anchored; the
 * rest are orphaned and keep their quote.
 */
export function anchorPageThreads(doc: Y.Doc, blockId: string, page: PreparedPage, quotes: { threadId: string; quote: string }[]): Set<string> {
  const anchored = new Set<string>();
  const comment = serverEditor().editor.pmSchema.marks.comment!;
  for (const { threadId, quote } of quotes) {
    const q = quote.trim();
    if (!q) continue;
    const hits = page.pids.flatMap((p) => {
      const first = p.text.indexOf(q);
      if (first < 0) return [];
      return p.text.indexOf(q, first + 1) >= 0 ? [null, null] : [{ pid: p.pid, at: first }];
    });
    if (hits.length !== 1 || !hits[0]) continue;
    const target = { tabId: MAIN_TAB, blockId, pid: hits[0].pid };
    const fragment = fragmentFor(doc, target);
    const tr = new Transform(pmDocOf(fragment));
    const at = findBlock(tr.doc, blockId);
    if (!at) continue;
    // The paragraph's content starts 2 past its blockContainer.
    const from = at.pos + 2 + hits[0].at;
    tr.addMark(from, from + q.length, comment.create({ threadId, orphan: false }));
    updateYFragment(doc, fragment, tr.doc, { mapping: new Map(), isOMark: new Map() });
    anchored.add(threadId);
  }
  return anchored;
}

/** The page document's HTML now: its stamped source with people's text spliced in. */
export async function currentPageHtml(storage: Storage, documentId: string, doc: Y.Doc): Promise<string | null> {
  // The first page block whose source loads: an editor's bogus block can't
  // take the page's place.
  for (const page of pageBlocks(doc)) {
    const stamped = await loadStamped(storage, documentId, page);
    if (stamped !== null) return renderPage(doc, { tabId: page.tabId, blockId: page.blockId, stamped });
  }
  return null;
}

/**
 * An agent's (or person's) new HTML version of a page document. Each pid is
 * carried three ways (page/carry.ts) in one plan by the publisher, which
 * also switches the block to the new source and reseeds the embeds; the
 * pipeline decides edit or suggest from the publisher. Where people's text
 * lost to the agent's, the person who last wrote it gets it back as an
 * ordinary suggestion.
 */
export async function republishPage(
  storage: Storage,
  documentId: string,
  actor: AuthUser,
  original: string,
  versionId: string,
): Promise<{ reconciliation: Reconciliation; sourceKey: string } | { refusal: Refusal }> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), SYSTEM_ORIGIN);
  let page: PageRef | null;
  let taken: string[] = [];
  try {
    page = mainPage(connection.document!);
    // Pids that still hold a fragment (from any earlier publish) are not reused.
    const prefix = page ? `page/${page.blockId}/` : '';
    if (page) taken = [...connection.document!.share.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
  const previousStamped = page ? await loadStamped(storage, documentId, page) : null;
  if (!page || previousStamped === null) {
    return { refusal: { code: 'not_found', message: 'This document has no page to republish.', fix: 'Create a new document for this page.' } };
  }
  const previous = readPids(previousStamped);
  const prepared = preparePage(original, previous, taken);
  if ('refusal' in prepared) return prepared;
  const sourceKey = sourceKeyOf(documentId, versionId);
  await storage.put(sourceKey, new TextEncoder().encode(prepared.stamped));

  // An agent that may only suggest here proposes new text for the page's
  // existing elements; the page itself (its source, elements and embeds)
  // changes only by someone who may edit.
  const suggesting = actor.kind === 'agent' && (await effectiveAgentMode(documentId, actor.id)) === 'suggest';
  const known = new Set(previous.map((p) => p.pid));
  const next = suggesting ? prepared.pids.filter((p) => known.has(p.pid)) : prepared.pids;

  const decisions: CarryDecision[] = [];
  const props = pageProps(sourceKey, page.title, prepared);
  let edits: PlannedEdit[];
  let reconciliation: Reconciliation;
  // Updates up to here are from before this republish (who wrote the text it replaces).
  const before = await latestUpdate(documentId);
  try {
    const carried = planCarry({ tabId: page.tabId, blockId: page.blockId, previous, next, uncertain: prepared.uncertain, decisions });
    edits = suggesting ? carried : [
      ...carried,
      ...(await seedPage({ tabId: page.tabId, blockId: page.blockId, stamped: prepared.stamped, pids: [], previous: previousStamped })),
      {
        target: { tabId: page.tabId, blockId: page.blockId },
        inverse: true,
        build: (tr, at) => {
          if (!at) return { code: 'target_changed', message: 'The page block is gone.', fix: 'Create a new document for this page.' };
          const content = at.node.firstChild!;
          tr.setNodeMarkup(at.pos + 1, undefined, { ...content.attrs, ...props });
        },
      },
    ];
    reconciliation = await applyPlan(documentId, originFor(actor), { edits, onConflict: 'refuse' });
  } catch (err) {
    // The block never pointed at the new source: don't leave it behind.
    await storage.delete(sourceKey).catch(() => undefined);
    throw err;
  }
  // The block points at the new source only once its switch applied.
  const switched = !suggesting && reconciliation.outcomes[edits.length - 1]?.status === 'applied';
  if (!switched) await storage.delete(sourceKey).catch(() => undefined);
  if (!suggesting && !switched) {
    return {
      refusal: {
        code: 'target_changed',
        message: 'The page block changed while publishing, so the new page source was not set (text edits that applied stay).',
        fix: 'Read the document and publish again.',
      },
    };
  }

  // People's text the agent's replaced comes back as their suggestion.
  const lost = decisions.filter((d, i) => d.suggest !== null && reconciliation.outcomes[i]?.status === 'applied');
  for (const d of lost) {
    const authorId = await lastWriter(documentId, page.blockId, d.pid, before);
    if (!authorId) continue;
    const result = await applyPlan(
      documentId,
      { kind: 'person', actorId: authorId, runId: null },
      { edits: [setPidText(d.target, d.suggest!)], onConflict: 'refuse', mode: 'suggest' },
    );
    const outcome = result.outcomes[0];
    if (outcome?.status === 'suggested') {
      const i = decisions.indexOf(d);
      reconciliation.outcomes[i] = { ...reconciliation.outcomes[i]!, status: 'suggested', suggestionId: outcome.suggestionId, note: 'The agent changed this text too; the earlier text was kept as a suggestion.' };
    }
  }
  return { reconciliation, sourceKey };
}

async function latestUpdate(documentId: string): Promise<number> {
  const [row] = (await db.execute(sql`SELECT COALESCE(MAX(id), 0)::int AS v FROM doc_updates WHERE document_id = ${documentId}`)) as unknown as { v: number }[];
  return row?.v ?? 0;
}

/** The person who last wrote a pid's text (the newest update up to `before` that touched its fragment). */
async function lastWriter(documentId: string, blockId: string, pid: string, before: number): Promise<string | null> {
  const fragment = `page/${blockId}/${pid}`;
  const [row] = (await db.execute(sql`
    SELECT u.actor_id FROM doc_updates u JOIN users p ON p.id = u.actor_id
    WHERE u.document_id = ${documentId} AND u.id <= ${before} AND ${fragment} = ANY(u.touched) AND p.kind = 'person'
    ORDER BY u.id DESC LIMIT 1
  `)) as unknown as { actor_id: string }[];
  return row?.actor_id ?? null;
}
