import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { BlockInput } from '@polygonlabs/primer-api-types';
import { serverEditor } from './editor.ts';

/** The input kinds an agent can write a block in. */
export type InputKind = 'markdown' | 'html' | 'json';

// The one Markdown parser (markdown-it), as for imports, with its task lists
// (`- [ ] x` is a check list item, as primer_get_doc writes it). Raw HTML in agent
// Markdown is text; a single HTML element goes in `{ html }`.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false }).use(taskLists, { label: false });

export class InputError extends Error {}

/**
 * Converts one op's block input to blockContainer nodes in Primer's schema:
 * Markdown through markdown-it → HTML → BlockNote's HTML parser (one list
 * item per block; nested items become children), one HTML element the same
 * way, partial JSON through BlockNote's block conversion. Ids in the input are
 * dropped: the server names new blocks. Async, so it runs before the pipeline.
 */
export async function inputToBlocks(input: BlockInput): Promise<{ kind: InputKind; nodes: PmNode[]; props?: string[]; keys?: string[] }> {
  const editor = serverEditor();
  if (typeof input === 'string') {
    // markdown-it keeps the newline after <br>; BlockNote would read it as a space.
    const html = md.render(input).replace(/<br>\n/g, '<br>');
    return { kind: 'markdown', nodes: toNodes(await editor.tryParseHTMLToBlocks(html)) };
  }
  if (input && typeof input === 'object' && 'html' in input && typeof input.html === 'string') {
    return { kind: 'html', nodes: toNodes(await editor.tryParseHTMLToBlocks(input.html)) };
  }
  if (input && typeof input === 'object' && 'json' in input && input.json && typeof input.json === 'object') {
    const json = { ...(input.json as Record<string, unknown>) };
    delete json.id;
    if (typeof json.type !== 'string') throw new InputError('json blocks need a type.');
    let nodes: PmNode[];
    try {
      nodes = toNodes([json]);
    } catch (err) {
      throw new InputError(`BlockNote rejected the block: ${err instanceof Error ? err.message : String(err)}`);
    }
    const props = json.props && typeof json.props === 'object' ? Object.keys(json.props) : [];
    return { kind: 'json', nodes, props, keys: Object.keys(json) };
  }
  throw new InputError('A block is a Markdown string, { html: "<one element>" } or { json: PartialBlock }.');
}

function toNodes(blocks: unknown[]): PmNode[] {
  if (blocks.length === 0) return [];
  const stripped = blocks.map(stripIds);
  const doc = serverEditor()._blocksToProsemirrorNode(stripped as never);
  doc.check();
  const nodes: PmNode[] = [];
  doc.firstChild!.forEach((child) => nodes.push(child));
  return nodes;
}

function stripIds(block: unknown): unknown {
  if (!block || typeof block !== 'object') return block;
  const { id: _id, children, ...rest } = block as Record<string, unknown>;
  return Array.isArray(children) ? { ...rest, children: children.map(stripIds) } : rest;
}
