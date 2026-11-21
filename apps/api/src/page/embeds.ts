// Primer blocks inside pages (M6.7): `<primer-table>`, `<primer-code>`,
// `<primer-mermaid>` and `<primer-math>`. Each is a block whose state lives in
// the fragment `embed/<blockId>/<embedId>`; the page shows it read-only and
// people edit it in the host overlay. An untouched embed exports as its
// original source; a changed one is serialised from its blocks.
import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import type { PartialBlock } from '@blocknote/core';
import type { Refusal } from '@polygonlabs/primer-api-types';
import { serverEditor, type PrimerBlock } from '../live/editor.ts';
import { escapeText } from './splice.ts';
import { MAX_NESTING, PageTooDeep } from './stamp.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export const EMBED_KINDS = ['table', 'code', 'mermaid', 'math'] as const;
export type EmbedKind = (typeof EMBED_KINDS)[number];

export type Embed = {
  embedId: string;
  kind: EmbedKind;
  /** The embed's content in the source: `[startTag.endOffset, endTag.startOffset]`. */
  span: [number, number];
  /** The source between the tags. */
  html: string;
  /** `lang` for code. */
  lang?: string;
};

const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The embeds of a page, or a refusal naming the first element whose id is missing, invalid or repeated. */
export function readEmbeds(original: string): { embeds: Embed[] } | { refusal: Refusal } {
  const doc = parse(original, { sourceCodeLocationInfo: true });
  const embeds: Embed[] = [];
  const seen = new Set<string>();
  let refusal: Refusal | null = null;

  const visit = (node: Node, path: string, depth = 0): void => {
    if (refusal || !('tagName' in node)) return;
    if (depth > MAX_NESTING) throw new PageTooDeep();
    const el = node as Element;
    const kind = el.tagName.startsWith('primer-') ? (el.tagName.slice(7) as EmbedKind) : null;
    if (kind && (EMBED_KINDS as readonly string[]).includes(kind)) {
      const id = el.attrs.find((a) => a.name === 'data-embed-id')?.value;
      const loc = el.sourceCodeLocation;
      if (id === undefined || !VALID_ID.test(id) || seen.has(id) || !loc?.startTag || !loc.endTag) {
        refusal = invalidEmbed(path, id);
        return;
      }
      seen.add(id);
      const span: [number, number] = [loc.startTag.endOffset, loc.endTag.startOffset];
      const lang = el.attrs.find((a) => a.name === 'lang')?.value;
      embeds.push({ embedId: id, kind, span, html: original.slice(...span), ...(lang ? { lang } : {}) });
      return;
    }
    const counts = new Map<string, number>();
    const children = el.tagName === 'template' ? [] : el.childNodes;
    for (const child of children) {
      if (!('tagName' in child)) continue;
      const n = counts.get(child.tagName) ?? 0;
      counts.set(child.tagName, n + 1);
      visit(child, `${path ? `${path}/` : ''}${child.tagName}[${n}]`, depth + 1);
    }
  };
  for (const child of doc.childNodes) visit(child, '');
  return refusal ? { refusal } : { embeds };
}

function invalidEmbed(path: string, id: string | undefined): Refusal {
  return {
    code: 'invalid_op',
    message:
      id === undefined
        ? `The Primer block at ${path} has no data-embed-id.`
        : `The Primer block at ${path} has an invalid or repeated data-embed-id "${id}".`,
    fix: 'Give every <primer-*> element a unique literal data-embed-id (letters, digits, - and _), written in the HTML, not set by a script.',
    details: { path },
  };
}

/** The decoded text of an embed's source (code, Mermaid, TeX). */
function sourceText(html: string): string {
  let text = '';
  const walk = (node: Node): void => {
    if (node.nodeName === '#text') text += (node as DefaultTreeAdapterMap['textNode']).value;
    for (const child of (node as Element).childNodes ?? []) walk(child);
  };
  walk(parseFragment(html));
  return text.replace(/^\n/, '').replace(/\n\s*$/, '');
}

/** The blocks an embed starts as. */
export async function embedBlocks(embed: Embed): Promise<PartialBlock[]> {
  switch (embed.kind) {
    case 'table':
      return (await serverEditor().tryParseHTMLToBlocks(embed.html)) as PartialBlock[];
    case 'code':
      return [{ type: 'codeBlock', props: { language: embed.lang ?? 'text' }, content: sourceText(embed.html) } as unknown as PartialBlock];
    case 'mermaid':
      return [{ type: 'diagram', content: sourceText(embed.html) } as unknown as PartialBlock];
    case 'math':
      return [{ type: 'mathBlock', content: sourceText(embed.html) } as unknown as PartialBlock];
  }
}

/** The source to write between an edited embed's tags. */
export async function embedSource(kind: EmbedKind, blocks: PrimerBlock[]): Promise<string> {
  if (kind === 'table') return serverEditor().blocksToHTMLLossy(blocks as never);
  const text = blocks
    .map((b) => (Array.isArray(b.content) ? b.content.map((c) => ('text' in c ? c.text : '')).join('') : ''))
    .join('\n');
  return escapeText(text).replace(/<br>/g, '\n');
}
