import * as Y from 'yjs';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { comments, docFiles, threads } from '../db/schema.ts';
import type { DocumentFormat } from '@polygonlabs/primer-api-types';
import type { Storage } from '../storage/types.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { readBlocks } from './editor.ts';
import { exportHtml, exportMarkdown, exportText, type ExportDecisions, type FileResolver } from './export.ts';
import { exportDecisions } from './choices.ts';
import { tabsOf } from './reach.ts';
import { currentPageHtml } from '../page/publish.ts';
import { bundleWidgets } from '../widgets/bundle.ts';
import { snapshotRecords } from '../records/snapshot.ts';
import { embedTables } from '../records/table.ts';

/**
 * A checkpoint's render bundle (C11): everything shares, previews, print,
 * exports, compare and restore read, rendered once from one frozen state and
 * never changed. Stored under `bundles/<versionId>/`.
 *
 * - `state.ydoc`: the Y.Doc state the bundle was rendered from;
 * - `export.md` or `export.txt` (the document's own format) and `export.html`
 *   (for a page document, its HTML with people's text spliced in);
 * - `static.html`: the static rendering, served like any version's content;
 * - `threads.json`: the open threads at capture with their quotes and comment
 *   counts, so the checkpoint keeps its discussion context;
 * - `files.json`: the ids of the files the content references.
 *
 * - `widgets/<id>.light.svg`, `.dark.svg` and `.json`: each published widget
 *   as it looked, and what restore republishes it from (widgets/bundle.ts).
 *
 * - `records.json`: the document's shared records at capture
 *   (records/snapshot.ts). Data tables in `static.html` and bound widgets are
 *   drawn from it, and shares and checkpoint views answer a page's record
 *   reads from it: data frozen at publish, never live.
 *
 * A page document's stamped source is stored once with the checkpoint that
 * published it (page/publish.ts `sourceKeyOf`), not copied into each bundle.
 */
export type BundleManifest = { versionId: string; format: string; files: string[] };

/** The open threads of a document as a checkpoint keeps them. */
export type BundleThread = {
  threadId: string;
  quote: string;
  commentCount: number;
  createdAt: string;
};

export function bundleKeyOf(versionId: string): string {
  return `bundles/${versionId}/`;
}

/** The export file a document format keeps in its bundle. */
export function exportFileOf(format: string): 'export.md' | 'export.txt' | 'export.html' {
  return format === 'text' ? 'export.txt' : format === 'html' ? 'export.html' : 'export.md';
}

/**
 * The static rendering of a document state, served like any version's
 * content. A page document (`page`: its HTML now, from `currentPageHtml`) is
 * its own page, served as uploaded pages are; anything else is BlockNote's
 * rendering, themed by Primer.
 */
export async function renderStatic(
  doc: Y.Doc,
  title: string,
  decisions: ExportDecisions = new Map(),
  page: string | null = null,
  /** Puts each widget's SVG and each data table's rows in place of their blocks
   *  (widgets/bundle.ts `bundleWidgets`, records/table.ts `embedTables`). */
  embedWidgets: (html: string) => string = (html) => html,
  files?: FileResolver,
): Promise<{ html: string; served: string }> {
  const html = page ?? embedWidgets(await exportHtml(doc, title, decisions, files));
  const served = transformHtml(html, { themeManaged: page === null });
  if (!served.ok) throw new Error(`static rendering failed: ${served.message}`);
  return { html, served: served.html };
}

const PRINT_CSS =
  '@page{margin:16mm}html,body{background:#fff!important;color:#000!important}a{color:inherit}' +
  'h1,h2,h3,h4{break-after:avoid}img,table,pre,blockquote{break-inside:avoid}';

// Runs in the sandboxed frame (the only place a served page can open the print
// dialog): once loaded, and again whenever the host asks.
const PRINT_JS =
  "(function(){var go=function(){setTimeout(function(){window.print()},150)};" +
  "if(document.readyState==='complete')go();else addEventListener('load',go);" +
  "addEventListener('message',function(e){if(e.source===parent&&e.data==='primer:print')window.print()})})();";

/** A static rendering made printable: light colours, page margins, and a script that opens the print dialog. */
export function printable(staticHtml: string): string {
  const head = staticHtml.lastIndexOf('</head>');
  const body = staticHtml.lastIndexOf('</body>');
  if (head < 0 || body < 0) throw new Error('static rendering has no head or body');
  return (
    staticHtml.slice(0, head) + `<style>${PRINT_CSS}</style>` + staticHtml.slice(head, body) + `<script>${PRINT_JS}</script>` + staticHtml.slice(body)
  );
}

export async function renderBundle(
  storage: Storage,
  opts: { versionId: string; documentId: string; title: string; state: Uint8Array; format: DocumentFormat },
): Promise<{ bundleKey: string; staticKey: string; staticBytes: number; staticHtml: string }> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, opts.state);
  try {
    // The document row is the authority: the Y.Doc's meta is writable by every editor.
    const { format } = opts;
    const decisions = await exportDecisions(opts.documentId);
    const page = format === 'html' ? await currentPageHtml(storage, opts.documentId, doc) : null;
    if (format === 'html' && page === null) throw new Error('page document has no readable page');
    const records = await snapshotRecords(opts.documentId);
    const widgets = await bundleWidgets(doc, opts.documentId, records);
    const tables = embedTables(doc, records);
    const { html, served } = await renderStatic(doc, opts.title, decisions, page, (h) => tables(widgets.embed(h)), storedFiles(storage, opts.documentId));
    const exported =
      format === 'html'
        ? html
        : format === 'text'
          ? exportText(doc, opts.documentId, decisions)
          : await exportMarkdown(doc, opts.documentId, decisions);
    const files: Record<string, string | Uint8Array> = {
      'state.ydoc': opts.state,
      [exportFileOf(format)]: exported,
      'export.html': html,
      'static.html': served,
      'threads.json': JSON.stringify(await openThreads(opts.documentId)),
      'files.json': JSON.stringify(await referencedFiles(doc, opts.documentId)),
      'records.json': JSON.stringify(records),
      ...widgets.files,
    };
    const manifest: BundleManifest = { versionId: opts.versionId, format, files: Object.keys(files) };
    files['manifest.json'] = JSON.stringify(manifest);

    const key = bundleKeyOf(opts.versionId);
    const encoder = new TextEncoder();
    let staticBytes = 0;
    try {
      for (const [name, content] of Object.entries(files)) {
        const bytes = typeof content === 'string' ? encoder.encode(content) : content;
        if (name === 'static.html') staticBytes = bytes.byteLength;
        await storage.put(key + name, bytes);
      }
    } catch (err) {
      // Don't leave the files that did land behind.
      await deleteBundle(storage, key);
      throw err;
    }
    return { bundleKey: key, staticKey: `${key}static.html`, staticBytes, staticHtml: served };
  } finally {
    doc.destroy();
  }
}

export async function readBundleFile(storage: Storage, bundleKey: string, name: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(await storage.get(bundleKey + name)).arrayBuffer());
}

/** The bundle's frozen Y.Doc. */
export async function loadBundleDoc(storage: Storage, bundleKey: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await readBundleFile(storage, bundleKey, 'state.ydoc'));
  return doc;
}

/** Every storage key a bundle can hold (missing ones are skipped on delete). */
export function bundleFileKeys(bundleKey: string): string[] {
  const names = ['manifest.json', 'state.ydoc', 'export.md', 'export.txt', 'export.html', 'static.html', 'threads.json', 'files.json', 'records.json'];
  return names.map((name) => bundleKey + name);
}

/** Every storage key of a bundle: the files its manifest lists (widgets
 *  included) and the fixed names, for a bundle whose manifest never landed. */
export async function bundleStorageKeys(storage: Storage, bundleKey: string): Promise<string[]> {
  const listed = await readBundleFile(storage, bundleKey, 'manifest.json')
    .then((bytes) => (JSON.parse(new TextDecoder().decode(bytes)) as BundleManifest).files)
    .catch(() => [] as string[]);
  const safe = listed.filter((name) => /^[A-Za-z0-9_./-]+$/.test(name) && !name.split('/').includes('..'));
  return [...new Set([...bundleFileKeys(bundleKey), ...safe.map((name) => bundleKey + name)])];
}

/** Deletes what `renderBundle` stored (a checkpoint that failed to commit). */
export async function deleteBundle(storage: Storage, bundleKey: string): Promise<void> {
  for (const key of await bundleStorageKeys(storage, bundleKey)) await storage.delete(key).catch(() => undefined);
}

async function openThreads(documentId: string): Promise<BundleThread[]> {
  const rows = await db
    .select({
      threadId: threads.id,
      anchor: threads.anchor,
      createdAt: threads.createdAt,
      commentCount: sql<number>`count(${comments.id}) filter (where ${comments.deletedAt} is null)::int`,
    })
    .from(threads)
    .leftJoin(comments, eq(comments.threadId, threads.id))
    .where(and(eq(threads.documentId, documentId), isNull(threads.resolvedAt)))
    .groupBy(threads.id)
    .orderBy(threads.createdAt);
  return rows.map((r) => ({
    threadId: r.threadId,
    quote: quoteOf(r.anchor),
    commentCount: r.commentCount,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** The text a thread is about. */
export function quoteOf(anchor: { type: string; selectorText?: string; innerText?: string }): string {
  return anchor.type === 'text-range' ? (anchor.selectorText ?? '') : (anchor.innerText ?? '');
}

/** The document's own stored files, for rendering them into a page. */
export function storedFiles(storage: Storage, documentId: string): FileResolver {
  return async (id) => {
    const [file] = await db
      .select({ storageKey: docFiles.storageKey, contentType: docFiles.contentType })
      .from(docFiles)
      .where(and(eq(docFiles.documentId, documentId), eq(docFiles.id, id)));
    if (!file) return null;
    return { contentType: file.contentType, bytes: new Uint8Array(await new Response(await storage.get(file.storageKey)).arrayBuffer()) };
  };
}

const BLOB = /primer-blob:\/\/([0-9a-f-]{36})/g;

/**
 * Ids of this document's files (`primer-blob://<id>`) referenced in its tabs.
 * Block props are editor-writable, so an id that belongs to another document
 * is left out.
 */
export async function referencedFiles(doc: Y.Doc, documentId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const tab of tabsOf(doc)) {
    for (const match of JSON.stringify(readBlocks(doc, tab.id)).matchAll(BLOB)) ids.add(match[1]!);
  }
  if (ids.size === 0) return [];
  const own = await db
    .select({ id: docFiles.id })
    .from(docFiles)
    .where(and(eq(docFiles.documentId, documentId), inArray(docFiles.id, [...ids])));
  return own.map((f) => f.id);
}
