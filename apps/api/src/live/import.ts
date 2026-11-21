import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import sanitizeHtml from 'sanitize-html';
import type Token from 'markdown-it/lib/token.mjs';
import { getDocument } from '@blocknote/server-util/dom';
import { codeBlockOptions } from '@blocknote/code-block';
import { Transform } from '@tiptap/pm/transform';
import type { Node as PmNode } from '@tiptap/pm/model';
import { updateYFragment } from 'y-prosemirror';
import type { DocumentFormat } from '@polygonlabs/primer-api-types';
import { markdownTokenizer as md, splitFrontMatter } from '../upload/markdown.ts';
import { sanitizeUploadedHtml } from '../upload/sanitize.ts';
import { serverEditor } from './editor.ts';
import { MAIN_TAB, tabFragmentName } from './reach.ts';
import { blockIndex } from './blocks.ts';
import { groupVersion, pmDocOf, writeSources, type SourceEntry } from './sources.ts';

export type { SourceEntry } from './sources.ts';

/** A block as imported: BlockNote block JSON with ids at every level. */
export type ImportedBlock = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children: ImportedBlock[];
};

export type ImportResult = {
  blocks: ImportedBlock[];
  /** Keyed by each group's first block id. `version` is filled by
   *  `buildLiveDoc`, from the stored blocks. */
  sources: Map<string, SourceEntry>;
  /** Raw front matter, fences included ('' when there is none). */
  frontMatter: string;
  /** Blank lines between the front matter and the first group. */
  lead: string;
  /** Parsed front matter. */
  metadata: Record<string, unknown>;
};

type Group = { start: number; end: number; tokens: Token[] | null };

/**
 * Markdown to BlockNote blocks, keeping every byte (M2b.1). Each top-level
 * group of the file (by markdown-it's line map) becomes the richest stock
 * blocks BlockNote parses from its HTML. A group BlockNote can't represent
 * (raw HTML, footnotes, lines no token covers such as reference definitions,
 * or a group whose text, links, images or checkboxes don't survive the
 * conversion) becomes one `source` block holding the slice verbatim, with a
 * sanitized preview. Every group remembers its exact source lines, so export
 * can re-emit what nobody changed.
 */
export async function importMarkdown(source: string): Promise<ImportResult> {
  const { frontMatter, data, body } = splitFrontMatter(source);
  const lines = lineStarts(body);
  const env: { references?: Record<string, unknown> } = {};
  const tokens = md.parse(body, env);
  const groups = partition(body, lines, topLevelGroups(tokens));

  const blocks: ImportedBlock[] = [];
  const sources = new Map<string, SourceEntry>();
  const lead = text(body, lines, 0, groups[0]?.start ?? lines.length);

  for (const [i, group] of groups.entries()) {
    const slice = text(body, lines, group.start, group.end);
    const gap = text(body, lines, group.end, groups[i + 1]?.start ?? lines.length);
    const refs = usedLabels(slice, env.references ?? {});
    const defines = definedLabels(slice);
    let converted: ImportedBlock[] | null = null;
    if (group.tokens && !hasRawSyntax(group.tokens, slice)) {
      const html = md.renderer.render(group.tokens, md.options, env);
      const callout = await alertCallout(slice, env);
      converted = callout ? [callout] : await toBlocks(html);
    }
    const groupBlocks = converted ?? [sourceBlock(slice, env)];
    blocks.push(...groupBlocks);
    sources.set(groupBlocks[0]!.id, { slice, gap, groupIds: groupBlocks.map((b) => b.id), version: '', refs, defines });
  }

  assertCovers(source, frontMatter + lead + [...sources.values()].map((s) => s.slice + s.gap).join(''));
  return { blocks, sources, frontMatter, lead, metadata: data };
}

/**
 * Plain text to paragraphs: each run of non-blank lines is one paragraph,
 * its line breaks kept as hard breaks; the blank lines after it are its gap.
 */
export function importText(source: string): ImportResult {
  const lines = lineStarts(source);
  const groups = partition(source, lines, []).map((g) => ({ ...g }));
  const blocks: ImportedBlock[] = [];
  const sources = new Map<string, SourceEntry>();
  const lead = text(source, lines, 0, groups[0]?.start ?? lines.length);
  for (const [i, group] of groups.entries()) {
    const slice = text(source, lines, group.start, group.end);
    const gap = text(source, lines, group.end, groups[i + 1]?.start ?? lines.length);
    const block: ImportedBlock = {
      id: randomUUID(),
      type: 'paragraph',
      content: slice.replace(/\r?\n$|\r$/, '').replace(/\r\n?/g, '\n'),
      children: [],
    };
    blocks.push(block);
    sources.set(block.id, { slice, gap, groupIds: [block.id], version: '', refs: [], defines: [] });
  }
  assertCovers(source, lead + [...sources.values()].map((s) => s.slice + s.gap).join(''));
  return { blocks, sources, frontMatter: '', lead, metadata: {} };
}

/**
 * A new Y.Doc holding an import: the blocks in the main tab, the `sources`
 * entries with the version of the blocks as stored, and `meta`. Built
 * detached; the caller stores its whole state as the document's first update.
 */
export function buildLiveDoc(imported: ImportResult, format: DocumentFormat, documentId: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(tabFragmentName(MAIN_TAB));
  serverEditor().blocksToYXmlFragment(imported.blocks as never, fragment);
  const stored = blockIndex(pmDocOf(fragment));
  const entries = new Map<string, SourceEntry>();
  for (const [key, entry] of imported.sources) {
    const version = groupVersion(stored, entry.groupIds);
    if (version === null) throw new Error(`imported block ${key} is missing from the stored document`);
    entries.set(key, { ...entry, version });
  }
  writeSources(doc, documentId, entries, { format, frontMatter: imported.frontMatter, lead: imported.lead });
  return doc;
}

/**
 * Re-anchors threads by quote on a freshly built document (a legacy document
 * becoming live): each quote found exactly once, within one text block, gets
 * BlockNote's `comment` mark for its thread, the live anchor of record. The
 * rest are orphaned: they keep their quote and get no mark. Returns the ids
 * of the threads that were anchored.
 */
export function anchorThreads(doc: Y.Doc, quotes: { threadId: string; quote: string }[]): Set<string> {
  const fragment = doc.getXmlFragment(tabFragmentName(MAIN_TAB));
  const tr = new Transform(pmDocOf(fragment));
  const comment = tr.doc.type.schema.marks.comment!;
  const anchored = new Set<string>();
  for (const { threadId, quote } of quotes) {
    const at = findQuote(tr.doc, quote.trim());
    if (!at) continue;
    tr.addMark(at.from, at.to, comment.create({ threadId, orphan: false }));
    anchored.add(threadId);
  }
  if (tr.docChanged) updateYFragment(doc, fragment, tr.doc, { mapping: new Map(), isOMark: new Map() });
  return anchored;
}

/** The one place `quote` occurs inside a single text block, or null when it
 *  occurs nowhere or more than once. */
function findQuote(pm: PmNode, quote: string): { from: number; to: number } | null {
  if (quote.length === 0) return null;
  const found: { from: number; to: number }[] = [];
  pm.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let chars = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      const text = child.isText ? child.text! : '\n';
      for (let i = 0; i < text.length; i++) {
        chars += text[i];
        at.push(pos + 1 + offset + (child.isText ? i : 0));
      }
    });
    for (let i = chars.indexOf(quote); i !== -1; i = chars.indexOf(quote, i + 1)) {
      found.push({ from: at[i]!, to: at[i + quote.length - 1]! + 1 });
    }
    return false;
  });
  return found.length === 1 ? found[0]! : null;
}

// ───────────────────────── groups ─────────────────────────

/** Offsets where each line starts. A final newline starts one more (empty)
 *  line, so every byte belongs to exactly one line. */
function lineStarts(s: string): number[] {
  const starts = [0];
  // A bare CR is a line break to markdown-it too; CRLF is one break.
  for (let i = 0; i < s.length; i++) if (s[i] === '\n' || (s[i] === '\r' && s[i + 1] !== '\n')) starts.push(i + 1);
  return starts;
}

function text(s: string, starts: number[], from: number, to: number): string {
  if (from >= to) return '';
  return s.slice(starts[from], to < starts.length ? starts[to] : s.length);
}

function isBlank(s: string, starts: number[], line: number): boolean {
  return text(s, starts, line, line + 1).trim().length === 0;
}

/** Top-level token groups: each level-0 opener with everything up to its
 *  closer, or a level-0 leaf (fence, hr, html_block). */
function topLevelGroups(tokens: Token[]): Group[] {
  const groups: Group[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i]!;
    if (open.level !== 0 || open.nesting === -1 || !open.map) continue;
    let j = i;
    if (open.nesting === 1) while (j < tokens.length && !(tokens[j]!.level === 0 && tokens[j]!.nesting === -1)) j++;
    groups.push({ start: open.map[0], end: open.map[1], tokens: tokens.slice(i, j + 1) });
    i = j;
  }
  return groups;
}

/** Every line in exactly one group or gap: token groups as mapped, plus a
 *  raw group (no tokens) for each run of non-blank lines no token covers.
 *  Blank lines between groups are the preceding group's gap. */
function partition(s: string, starts: number[], tokenGroups: Group[]): Group[] {
  const out: Group[] = [];
  const raw = (from: number, to: number) => {
    let line = from;
    while (line < to) {
      if (isBlank(s, starts, line)) { line++; continue; }
      const start = line;
      while (line < to && !isBlank(s, starts, line)) line++;
      out.push({ start, end: line, tokens: null });
    }
  };
  let cursor = 0;
  for (const group of tokenGroups) {
    raw(cursor, group.start);
    const start = Math.max(group.start, cursor);
    // A group's map can end on trailing blank lines; they belong to its gap.
    let end = Math.max(group.end, start + 1);
    while (end > start + 1 && isBlank(s, starts, end - 1)) end--;
    out.push({ start, end, tokens: group.tokens });
    cursor = Math.max(cursor, group.end);
  }
  raw(cursor, starts.length);
  return out;
}

function hasRawSyntax(tokens: Token[], slice: string): boolean {
  if (slice.includes('[^')) return true;
  // Raw HTML is in the source as written; the task-list plugin's checkbox
  // tokens are generated, so they don't count.
  const raw = (t: Token) => (t.type === 'html_block' || t.type === 'html_inline') && slice.includes(t.content.trim());
  return tokens.some((t) => raw(t) || (t.children ?? []).some(raw));
}

/** Reference labels a slice looks up while it is parsed. */
function usedLabels(slice: string, references: Record<string, unknown>): string[] {
  const used = new Set<string>();
  const watched = new Proxy(references, {
    get(target, key) {
      if (typeof key === 'string' && key in target) used.add(key);
      return target[key as string];
    },
    set() {
      return true; // definitions are read from the whole file, never re-written
    },
  });
  md.parse(slice, { references: watched });
  return [...used];
}

/** Reference labels a slice defines. */
function definedLabels(slice: string): string[] {
  const env: { references?: Record<string, unknown> } = {};
  md.parse(slice, env);
  return Object.keys(env.references ?? {});
}

// ───────────────────────── conversion ─────────────────────────

/** The group's blocks, or null when BlockNote can't hold its content. */
async function toBlocks(html: string): Promise<ImportedBlock[] | null> {
  const parsed = (await serverEditor().tryParseHTMLToBlocks(html)) as unknown as ImportedBlock[];
  if (parsed.length === 0) return null;
  const blocks = parsed.map(withIds);
  if (!blocks.every(withCanonicalLanguage)) return null;
  return signature(htmlSignature(html)) === signature(blocksSignature(blocks)) ? blocks : null;
}

const ALERT_MARKER = /^ {0,3}>[ \t]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n/i;
const ALERT_KINDS: Record<string, string> = { NOTE: 'note', TIP: 'success', IMPORTANT: 'info', WARNING: 'warning', CAUTION: 'warning' };

/**
 * A GitHub alert (`> [!NOTE]` and its body) as a `callout` block, when its body
 * is a single paragraph of inline text a callout can hold; null otherwise.
 * Richer alerts (several paragraphs, lists, code) stay `source` blocks, so no
 * byte is lost either way.
 */
async function alertCallout(slice: string, env: object): Promise<ImportedBlock | null> {
  const marker = ALERT_MARKER.exec(slice);
  if (!marker) return null;
  const body = slice
    .slice(marker[0].length)
    .split('\n')
    .map((line) => line.replace(/^ {0,3}>[ \t]?/, ''))
    .join('\n');
  const parsed = await toBlocks(md.render(body, { ...env }));
  if (!parsed || parsed.length !== 1 || parsed[0]!.type !== 'paragraph' || parsed[0]!.children.length > 0) return null;
  const kind = ALERT_KINDS[marker[1]!.toUpperCase()]!;
  return { id: randomUUID(), type: 'callout', props: { kind }, content: parsed[0]!.content, children: [] };
}

const languages = codeBlockOptions.supportedLanguages as Record<string, { aliases?: string[] }>;

/**
 * Code blocks name their language by BlockNote's own id (`typescript`, not
 * `ts`): the editor refuses anything else. A fence in a language it doesn't
 * know is kept verbatim instead (false), so the info string isn't lost.
 */
function withCanonicalLanguage(block: ImportedBlock): boolean {
  if (block.type === 'codeBlock') {
    const props = (block.props ??= {});
    const asked = String(props.language ?? '').toLowerCase();
    const id = asked === '' ? 'text' : Object.keys(languages).find((key) => key === asked || languages[key]!.aliases?.includes(asked));
    if (!id) return false;
    props.language = id;
  }
  return block.children.every(withCanonicalLanguage);
}

function withIds(block: ImportedBlock): ImportedBlock {
  return { ...block, id: block.id || randomUUID(), children: (block.children ?? []).map(withIds) };
}

type Signature = { text: string; links: string[]; images: string[]; checked: boolean[] };

function signature(s: Signature): string {
  return JSON.stringify({ ...s, text: s.text.replace(/\s+/g, '') });
}

/**
 * What a reader sees in the rendered group: its text, link targets, image
 * sources and checkbox states. The conversion must keep all of it.
 */
function htmlSignature(html: string): Signature {
  const el = getDocument().createElement('div');
  el.innerHTML = html;
  return {
    text: el.textContent ?? '',
    links: [...el.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!),
    images: [...el.querySelectorAll('img[src]')].map((img) => img.getAttribute('src')!),
    checked: [...el.querySelectorAll('input[type=checkbox]')].map((i) => i.hasAttribute('checked')),
  };
}

function blocksSignature(blocks: ImportedBlock[]): Signature {
  const sig: Signature = { text: '', links: [], images: [], checked: [] };
  const inline = (content: unknown): void => {
    if (typeof content === 'string') { sig.text += content; return; }
    if (!Array.isArray(content)) return;
    for (const node of content as { type: string; text?: string; href?: string; content?: unknown }[]) {
      if (node.type === 'text') sig.text += node.text ?? '';
      else if (node.type === 'link') { sig.links.push(node.href ?? ''); inline(node.content); }
    }
  };
  const walk = (block: ImportedBlock): void => {
    const props = block.props ?? {};
    if (block.type === 'checkListItem') sig.checked.push(Boolean(props.checked));
    if (block.type === 'image' && typeof props.url === 'string') sig.images.push(props.url);
    const content = block.content as { type?: string; rows?: { cells: unknown[] }[] } | unknown[] | undefined;
    if (content && !Array.isArray(content) && content.type === 'tableContent') {
      for (const row of content.rows ?? []) {
        for (const cell of row.cells) inline(typeof cell === 'object' && cell && 'content' in cell ? (cell as { content: unknown }).content : cell);
      }
    } else inline(content);
    for (const child of block.children) walk(child);
  };
  for (const block of blocks) walk(block);
  return sig;
}

/** A `source` block: the slice verbatim, with a sanitized, script-less
 *  preview (lines that render nothing, like reference definitions, preview as
 *  their text). */
function sourceBlock(slice: string, env: object): ImportedBlock {
  return { id: randomUUID(), type: 'source', props: { markdown: slice, previewHtml: sourcePreview(slice, env) }, children: [] };
}

/** A source slice's preview: rendered, sanitized and without scripts. Export
 *  renders it again from the Markdown rather than trusting the stored prop. */
export function sourcePreview(slice: string, env: object = {}): string {
  const rendered = md.render(slice, { ...env });
  return rendered.trim().length > 0 ? withoutScripts(sanitizeUploadedHtml(rendered)) : `<pre>${md.utils.escapeHtml(slice)}</pre>`;
}

function withoutScripts(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    exclusiveFilter: (frame) => frame.tag === 'script',
    transformTags: {
      '*': (tagName, attribs) => ({
        tagName,
        attribs: Object.fromEntries(Object.entries(attribs).filter(([name]) => !name.toLowerCase().startsWith('on'))),
      }),
    },
  });
}

function assertCovers(source: string, rebuilt: string): void {
  if (rebuilt !== source) throw new Error('import lost bytes of the source; refusing to store a partial document');
}
