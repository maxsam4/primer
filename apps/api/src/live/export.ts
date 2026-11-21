import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as Y from 'yjs';
import { citationLabel, embedDocumentId, embedUrl, optionLabel, type CitationProps } from '@primer/blocks';
import { readBlocks, serverEditor, type PrimerBlock } from './editor.ts';
import { MAIN_TAB, tabFragmentName, tabsOf, type Tab } from './reach.ts';
import { sourcePreview } from './import.ts';
import { blockIndex } from './blocks.ts';
import { groupVersion, pmDocOf, trustedMeta, trustedSources } from './sources.ts';

/**
 * The document as Markdown (M2b.2): untouched groups are their source lines,
 * byte for byte; only changed or new blocks are serialised. An untouched
 * document exports exactly the uploaded file. Tabs after `main` follow in
 * order, each under a `# <title>` heading.
 */
/** `decisions`: the server's recorded decisions (none shown without them). */
export async function exportMarkdown(doc: Y.Doc, documentId: string, decisions: ExportDecisions = new Map()): Promise<string> {
  // Every tab is planned before the first await, so a concurrent edit to the
  // live document can't change what the later tabs or the titles see.
  const list = tabsOf(doc);
  const planned = list.map((tab) => planTab(doc, documentId, tab.id));
  const tabs: string[] = [];
  for (const parts of planned) {
    tabs.push(
      assemble(parts, await Promise.all(parts.map((p) => (p.kind === 'run' ? markdownOf(withDecisions(p.run, decisions)) : null)))),
    );
  }
  return joinTabs(list, tabs, (title) => `# ${title}`, true);
}

/** The document as plain text, by the same rule; tabs follow under their title. */
export function exportText(doc: Y.Doc, documentId: string, decisions: ExportDecisions = new Map()): string {
  const list = tabsOf(doc);
  const tabs = list.map((tab) => {
    const parts = planTab(doc, documentId, tab.id);
    return assemble(parts, parts.map((p) => (p.kind === 'run' ? withDecisions(p.run, decisions).map((b) => plainText(b)).join('\n\n') : null)));
  });
  return joinTabs(list, tabs, (title) => title);
}

/** Main's text, then each later tab under its heading, a blank line between. */
function joinTabs(tabs: Tab[], texts: string[], heading: (title: string) => string, markdown = false): string {
  let out = texts[0] ?? '';
  tabs.slice(1).forEach((tab, k) => {
    // A tab that ends inside a code fence must not swallow the next heading.
    if (markdown) out = closeOpenFence(out);
    if (out.length > 0) out = out.replace(/\n*$/, '\n\n');
    const body = markdown ? closeOpenFence(texts[k + 1]!).replace(/\n+$/, '') : texts[k + 1]!.replace(/\n+$/, '');
    out += heading(oneLine(tab.title) || 'Untitled') + '\n' + (body ? `\n${body}\n` : '');
  });
  return out;
}

/** `text` with its last fenced code block closed, when it was left open. */
function closeOpenFence(text: string): string {
  let open: { char: string; length: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const fence = m[1]!;
    if (!open) open = { char: fence[0]!, length: fence.length };
    else if (fence[0] === open.char && fence.length >= open.length && m[2]!.trim() === '') open = null;
  }
  return open ? text.replace(/\n*$/, '\n') + open.char.repeat(open.length) + '\n' : text;
}

function oneLine(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * The static rendering (C11 `static.html`): BlockNote's full HTML inside its
 * own container, with its stylesheet inlined. Source blocks show a preview
 * rendered again from their Markdown (the stored preview is editor-writable).
 * Tabs after `main` follow under their titles. Shares, previews, print and
 * email all use this.
 */
export async function exportHtml(doc: Y.Doc, title = '', decisions: ExportDecisions = new Map(), files?: FileResolver): Promise<string> {
  let body = '';
  for (const tab of tabsOf(doc)) {
    if (tab.id !== MAIN_TAB) body += `<h1 class="primer-tab-title">${escapeHtml(oneLine(tab.title) || 'Untitled')}</h1>`;
    body += await htmlOf(withDecisions(readBlocks(doc, tab.id), decisions));
  }
  body = await inlineImages(body, files);
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title><style>${blocknoteCss()}</style><style>${STATIC_CSS}</style></head>` +
    `<body><div class="bn-root bn-container"><div class="bn-default-styles">${body}</div></div></body></html>`
  );
}

/** A choice's recorded decision, as exports show it. */
export type ExportDecision = {
  decisionId: string;
  optionId: string;
  question: string;
  label: string;
  rationale: string;
  decidedByName: string;
};
/** Recorded decisions by choice block id (`exportDecisions` in live/choices.ts). */
export type ExportDecisions = Map<string, ExportDecision>;

/** The choice's render-only decision props (the server fills them here). */
export const DECISION_PROPS = ['decidedOptionId', 'decidedLabel', 'decidedQuestion', 'decisionChanged', 'rationale', 'decidedByName'];

/**
 * Choice blocks with their decision props filled from the server's record
 * and nothing else: whatever the (client-writable) document holds there is
 * dropped, so a forged decision never reaches an export or a static render.
 */
function withDecisions(blocks: PrimerBlock[], decisions: ExportDecisions): PrimerBlock[] {
  return blocks.map((block) => {
    const children = withDecisions(block.children as PrimerBlock[], decisions);
    if (block.type !== 'choice') return children === block.children ? block : ({ ...block, children } as PrimerBlock);
    const props: Record<string, unknown> = { ...block.props };
    for (const key of DECISION_PROPS) props[key] = '';
    // A decision applies only to the block carrying its nonce, with the option still there.
    const d = decisions.get(block.id);
    const option = d && block.props.decisionId === d.decisionId
      ? (block.children as PrimerBlock[]).find((o) => o.id === d.optionId)
      : undefined;
    if (d && option) {
      const changed = d.question !== String(block.props.question ?? '') || d.label !== optionLabel(option as never);
      Object.assign(props, {
        decidedOptionId: d.optionId,
        decidedLabel: d.label,
        decidedQuestion: d.question,
        decisionChanged: changed ? 'true' : '',
        rationale: d.rationale,
        decidedByName: d.decidedByName,
      });
    }
    return { ...block, props, children } as PrimerBlock;
  });
}

/** A stored file's type and bytes by id (its document's files only), or null. */
export type FileResolver = (id: string) => Promise<{ contentType: string; bytes: Uint8Array } | null>;

const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']);
const BLOB_URL = /primer-blob:\/\/([0-9a-f-]{36})/gi;

/**
 * The static page is served to a sandboxed frame whose requests carry no
 * session, so a `primer-blob://` image can't be fetched from the API there.
 * Images become data: URIs (the page's CSP allows them) and the page is
 * self-contained, as a frozen checkpoint should be. Other files keep their
 * opaque reference: the CSP blocks media from the page anyway.
 */
async function inlineImages(html: string, files?: FileResolver): Promise<string> {
  if (!files) return html;
  const resolved = new Map<string, string>();
  for (const id of new Set([...html.matchAll(BLOB_URL)].map((m) => m[1]!.toLowerCase()))) {
    const file = await files(id);
    if (file && INLINE_IMAGES.has(file.contentType)) {
      resolved.set(id, `data:${file.contentType};base64,${Buffer.from(file.bytes).toString('base64')}`);
    }
  }
  return html.replace(BLOB_URL, (whole, id: string) => resolved.get(id.toLowerCase()) ?? whole);
}

type Part =
  | { kind: 'head' | 'group'; text: string }
  | { kind: 'run'; run: PrimerBlock[]; gap: string };

/**
 * Walks a tab's top-level blocks in order. A block that starts a source group
 * whose blocks are all still there, contiguous and unchanged (and whose
 * reference definitions are too) emits the group's slice and gap, provided
 * the server signed the entry at import for this document. Anything
 * else is a run to serialise, up to the next group start, keeping the
 * original gap after it when the run starts a group.
 */
function planTab(doc: Y.Doc, documentId: string, tabId: string): Part[] {
  const blocks = readBlocks(doc, tabId);
  const nodes = blockIndex(pmDocOf(doc.getXmlFragment(tabFragmentName(tabId))));
  const sources = trustedSources(doc, documentId);
  const index = new Map(blocks.map((b, i) => [b.id, i]));

  const intact = (key: string): boolean => {
    const entry = sources.get(key)!;
    const at = index.get(key);
    if (at === undefined) return false;
    if (!entry.groupIds.every((id, k) => blocks[at + k]?.id === id)) return false;
    return groupVersion(nodes, entry.groupIds) === entry.version;
  };
  const intactKeys = new Set([...sources.keys()].filter(intact));
  const definers = new Map<string, string[]>();
  for (const [key, entry] of sources) for (const label of entry.defines) definers.set(label, [...(definers.get(label) ?? []), key]);
  const verbatim = (key: string): boolean =>
    intactKeys.has(key) && sources.get(key)!.refs.every((label) => (definers.get(label) ?? []).every((k) => intactKeys.has(k)));

  const parts: Part[] = [];
  if (tabId === MAIN_TAB) {
    const meta = trustedMeta(doc, documentId);
    parts.push({ kind: 'head', text: meta.frontMatter + meta.lead });
  }
  for (let i = 0; i < blocks.length; ) {
    const key = blocks[i]!.id;
    const entry = sources.get(key);
    if (entry && verbatim(key)) {
      parts.push({ kind: 'group', text: entry.slice + entry.gap });
      i += entry.groupIds.length;
      continue;
    }
    let j = i + 1;
    while (j < blocks.length && !sources.has(blocks[j]!.id)) j++;
    parts.push({ kind: 'run', run: blocks.slice(i, j), gap: entry?.gap ?? (j === blocks.length ? '' : '\n') });
    i = j;
  }
  return parts;
}

/** Joins the parts; `texts[k]` is the serialisation of run `k`. */
function assemble(parts: Part[], texts: (string | null)[]): string {
  let out = '';
  let afterGroup = false;
  parts.forEach((part, k) => {
    if (part.kind !== 'run') {
      // A group moved after one whose source has no final newline starts its own line.
      if (out.length > 0 && !/[\r\n]$/.test(out) && part.text.length > 0) out += '\n';
      out += part.text;
      afterGroup ||= part.kind === 'group';
      return;
    }
    const text = texts[k]!.replace(/\n+$/, '');
    if (text.trim().length === 0) return; // an empty block (an editor's trailing paragraph) adds nothing
    // A changed group starts a paragraph of its own.
    if (afterGroup) out += out.endsWith('\n\n') ? '' : out.endsWith('\n') ? '\n' : '\n\n';
    out += text + '\n' + part.gap;
    afterGroup = true;
  });
  return out;
}

/** Changed blocks as Markdown. Source blocks are their (edited) Markdown. */
async function markdownOf(blocks: PrimerBlock[]): Promise<string> {
  const out: string[] = [];
  for (const segment of segments(flattenColumns(blocks))) {
    out.push(
      isSource(segment[0]!)
        ? segment.map((b) => String((b.props as { markdown: string }).markdown).replace(/\n+$/, '')).join('\n\n')
        : (await serverEditor().blocksToMarkdownLossy(segment as never)).replace(/\n+$/, ''),
    );
  }
  return out.filter((s) => s.length > 0).join('\n\n');
}

async function htmlOf(blocks: PrimerBlock[]): Promise<string> {
  const out: string[] = [];
  for (const segment of segments(blocks)) {
    out.push(
      isSource(segment[0]!)
        ? segment.map((b) => `<div class="primer-source">${sourcePreview(String((b.props as { markdown: string }).markdown))}</div>`).join('')
        : await serverEditor().blocksToFullHTML(segment as never),
    );
  }
  return out.join('');
}

/** Column lists as their columns' blocks in reading order, so source blocks
 *  inside columns are emitted as written and the rest serialised normally. */
function flattenColumns(blocks: PrimerBlock[]): PrimerBlock[] {
  return blocks.flatMap((block) =>
    block.type === 'columnList'
      ? flattenColumns((block.children as PrimerBlock[]).flatMap((column) => column.children as PrimerBlock[]))
      : [block],
  );
}

/** Runs of consecutive blocks that are all `source` blocks or all not. */
function segments(blocks: PrimerBlock[]): PrimerBlock[][] {
  const out: PrimerBlock[][] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (last && isSource(last[0]!) === isSource(block)) last.push(block);
    else out.push([block]);
  }
  return out;
}

function isSource(block: PrimerBlock): boolean {
  return block.type === 'source';
}

/** An embed as text: its validated link (another document as its path). */
function embedText(block: PrimerBlock): string {
  const props = block.props as Record<string, unknown>;
  const documentId = embedDocumentId(props.documentId);
  return documentId ? `/d/${documentId}` : embedUrl(props.url);
}

/** A block's text, hard breaks as newlines, children indented below it. */
export function plainText(block: PrimerBlock): string {
  if (block.type === 'embed') return embedText(block);
  const inline = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) {
      const table = content as { type?: string; rows?: { cells: unknown[] }[] } | undefined;
      if (table?.type === 'tableContent') {
        return (table.rows ?? [])
          .map((row) => row.cells.map((c) => inline(typeof c === 'object' && c && 'content' in c ? (c as { content: unknown }).content : c)).join('\t'))
          .join('\n');
      }
      return '';
    }
    return (content as { type: string; text?: string; content?: unknown; props?: Record<string, string> }[])
      .map((n) => (n.type === 'text' ? (n.text ?? '') : n.type === 'link' ? inline(n.content) : chipText(n)))
      .join('');
  };
  const props = block.props as Record<string, string>;
  const own = isSource(block)
    ? String(props.markdown).replace(/\n+$/, '')
    : block.type === 'choice'
      ? `Choice: ${props.question ?? ''}`
      : inline(block.content);
  const children = (block.children as PrimerBlock[]).map((child) => plainText(child)).filter((t) => t.length > 0);
  // A choice's recorded decision (filled in by `withDecisions`).
  const decision =
    block.type === 'choice' && props.decidedOptionId
      ? `Decision: ${props.decidedLabel}${props.decidedByName ? ` (by ${props.decidedByName})` : ''}${props.rationale ? `: ${props.rationale}` : ''}`
      : '';
  return [own, ...children, decision].filter((t) => t.length > 0).join('\n');
}

/**
 * What the static rendering needs beyond BlockNote's structural stylesheet,
 * which ships no colours: a readable page, and light or dark to match
 * wherever it is shown. In Primer the companion sets `data-theme` on `<html>`;
 * a share opened on its own follows the viewer's colour scheme.
 */
const STATIC_CSS = `
body{margin:0;padding:24px 16px;background:#fff;color:#171717;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.bn-container{max-width:760px;margin:0 auto}
.primer-tab-title{margin:2.2em 0 .6em}
a{color:#6d28d9}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
table{border-collapse:collapse}td,th{border:1px solid #d4d4d4;padding:4px 8px}
img,video{max-width:100%}
.primer-chip{border-radius:4px;background:#ede9fe;color:#4c1d95;padding:0 4px}
.bn-container{counter-reset:primer-citation}.primer-citation{display:inline-block;line-height:1.2;font-size:.75em;vertical-align:super}.primer-citation::before{counter-increment:primer-citation;content:"[" counter(primer-citation) "] "}
.primer-callout{--callout:#6366f1;display:flex;gap:8px;margin:2px 0;padding:8px 12px;border-left:3px solid var(--callout);border-radius:6px;background:color-mix(in srgb,var(--callout) 12%,transparent)}
.primer-callout[data-primer-callout="warning"]{--callout:#d97706}
.primer-callout[data-primer-callout="success"]{--callout:#16a34a}
.primer-callout[data-primer-callout="note"]{--callout:#71717a}
.primer-callout-label{font-size:12px;font-weight:600;color:var(--callout);white-space:nowrap}
.primer-callout-body{flex:1;min-width:0}
.primer-columns-row{display:flex;gap:16px;align-items:flex-start}
.primer-column{flex:1 1 0;min-width:0}
@media (max-width:640px){.primer-columns-row{flex-direction:column}}
html[data-theme="dark"] body{background:#0a0a0a;color:#e5e5e5}
html[data-theme="dark"] a{color:#c4b5fd}
html[data-theme="dark"] td,html[data-theme="dark"] th{border-color:#404040}
html[data-theme="dark"] .primer-chip{background:#3b2a6b;color:#ddd6fe}
@media (prefers-color-scheme: dark){
html:not([data-theme]) body{background:#0a0a0a;color:#e5e5e5}
html:not([data-theme]) a{color:#c4b5fd}
html:not([data-theme]) td,html:not([data-theme]) th{border-color:#404040}
html:not([data-theme]) .primer-chip{background:#3b2a6b;color:#ddd6fe}
}`;

/** What a chip reads as in text: `@name`, the date, the chosen value. */
function chipText(node: { type: string; props?: Record<string, string> }): string {
  if (node.type === 'mention') return `@${node.props?.name ?? ''}`;
  if (node.type === 'date') return node.props?.date ?? '';
  if (node.type === 'dropdown') return node.props?.value ?? '';
  if (node.type === 'citation') return `[${citationLabel(node.props as unknown as CitationProps)}]`;
  return '';
}

let css: string | null = null;
function blocknoteCss(): string {
  css ??= readFileSync(createRequire(import.meta.url).resolve('@blocknote/core/style.css'), 'utf8');
  return css;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
