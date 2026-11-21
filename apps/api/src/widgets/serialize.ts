import { SVG_PRESENTATION_ATTRS, SVG_TAG_ATTRS, SVG_TAGS } from '../upload/sanitize.ts';
import { isWidgetAttributeValue } from '@polygonlabs/primer-api-types';
import type { WidgetError } from './parse.ts';
import { RUN_LIMITS, type WidgetNode } from './run.ts';
import { isColourKeyword } from './validate.ts';

export const SVG_LIMITS = { nodes: RUN_LIMITS.nodes, bytes: 512 * 1024, viewBox: 4096 };

/** The one font widgets draw with, on the server (raster.ts) and in the page. */
export const WIDGET_FONT = 'Roboto';
/** The root's font stack: Roboto (loaded by the server and the page), then
 *  what a renderer without it has. */
const FONT_STACK = `${WIDGET_FONT}, Helvetica, Arial, sans-serif`;

const TAGS = new Set(SVG_TAGS);
const PRESENTATION = new Set(SVG_PRESENTATION_ATTRS.filter((a) => a !== 'font-family'));
const PROVENANCE = ['data-text-id', 'data-anchor', 'data-row', 'data-col'];
const GLOBAL_ATTRS = new Set([...PRESENTATION, ...PROVENANCE, 'id']);
const COLOUR_ATTRS = new Set(['fill', 'stroke', 'stop-color']);
/** JSX spells SVG's hyphenated attributes in camelCase (strokeWidth). */
const CAMEL = new Map(
  [...SVG_PRESENTATION_ATTRS, 'stop-color', 'stop-opacity'].map((name) => [name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), name]),
);
/** React-only props: dropped without a warning. */
const IGNORED = new Set(['key', 'children', 'xmlns']);

export type SerializeContext = {
  /** Every concrete colour the theme's tokens resolve to. */
  colours: Set<string>;
  /** Row id → row. */
  rows: Map<string, Record<string, unknown>>;
  /** The literal text ids in the source. */
  textIds: Set<string>;
  /** Prefixes every `id` and `#ref`, so two widgets on a page never collide. */
  idPrefix: string;
};

export type SerializedSvg = {
  svg: string;
  /** Each label's words, by text id. */
  labels: Record<string, string>;
  /** Tags and attributes the allowlist dropped. */
  warnings: string[];
};

/**
 * The runtime check every render passes, whatever the source looked like:
 * the tree must be one `<svg>` with a bounded viewBox; tags and attributes
 * outside the allowlist are dropped (scripts, event handlers, external
 * references); `style`, `<foreignObject>`, literal colours, unknown or
 * repeated text ids, unknown rows and anything past the bounds refuse the
 * whole render.
 */
export function serializeSvg(tree: WidgetNode, ctx: SerializeContext): SerializedSvg | { errors: WidgetError[] } {
  const errors: string[] = [];
  const warnings = new Set<string>();
  const labels: Record<string, string> = {};
  let nodes = 0;

  if (typeof tree !== 'object' || tree === null || Array.isArray(tree) || tree.t !== 'svg' || !isNode(tree)) {
    return fail(['render() must return one <svg> element.']);
  }
  const viewBox = String(tree.p.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n)) || viewBox[2]! <= 0 || viewBox[3]! <= 0) {
    return fail(['The <svg> needs a viewBox="0 0 <width> <height>".']);
  }
  if (viewBox[2]! > SVG_LIMITS.viewBox || viewBox[3]! > SVG_LIMITS.viewBox) {
    return fail([`The viewBox is at most ${SVG_LIMITS.viewBox}×${SVG_LIMITS.viewBox}.`]);
  }

  const prefixRefs = (value: string) =>
    value.replace(/url\(#([A-Za-z0-9_-]+)\)/g, (_, id: string) => `url(#${ctx.idPrefix}${id})`);

  function element(node: { t: string; p: Record<string, unknown>; c: WidgetNode[] }, root: boolean): string {
    if (++nodes > SVG_LIMITS.nodes) throw new Bounds();
    if (!isNode(node)) {
      errors.push('A rendered node is malformed: every element needs a tag, an object of props and an array of children.');
      return '';
    }
    const tag = node.t;
    if (tag === 'foreignObject' || tag === 'style') {
      errors.push(`<${tag}> is not an element widgets may render.`);
      return '';
    }
    if (!TAGS.has(tag)) {
      warnings.add(`dropped <${tag}>`);
      return '';
    }
    const allowed = SVG_TAG_ATTRS[tag] ?? [];
    let attrs = root ? ` xmlns="http://www.w3.org/2000/svg" font-family="${FONT_STACK}"` : '';
    for (const [rawName, rawValue] of Object.entries(node.p ?? {})) {
      if (IGNORED.has(rawName) || rawValue === null || rawValue === undefined || rawValue === false) continue;
      const name = CAMEL.get(rawName) ?? rawName;
      if (name === 'style') {
        errors.push(`<${tag}> has a style attribute: use presentation attributes.`);
        continue;
      }
      if (root && (name === 'width' || name === 'height')) continue; // a widget fills its column
      if (!GLOBAL_ATTRS.has(name) && !allowed.includes(name)) {
        warnings.add(`dropped ${name} on <${tag}>`);
        continue;
      }
      if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && rawValue !== true) {
        errors.push(`${name} on <${tag}> is not a string or a number.`);
        continue;
      }
      if (typeof rawValue === 'number' && !Number.isFinite(rawValue)) {
        errors.push(`${name} on <${tag}> is ${rawValue}.`);
        continue;
      }
      let value = rawValue === true ? '' : String(rawValue);
      if (!isWidgetAttributeValue(name, value)) {
        errors.push(`${name} on <${tag}> has "${value}", which ${name} doesn't allow (references only as url(#id), no CSS functions or escapes).`);
        continue;
      }
      if (COLOUR_ATTRS.has(name) && !isColourKeyword(value) && !ctx.colours.has(value)) {
        errors.push(`${name}="${value}" on <${tag}> is not a theme token: use tokens.*.`);
        continue;
      }
      if (name === 'href') {
        if (!/^#[A-Za-z0-9_-]+$/.test(value)) {
          warnings.add(`dropped an external href on <${tag}>`);
          continue;
        }
        value = `#${ctx.idPrefix}${value.slice(1)}`;
      } else if (name === 'id') {
        value = `${ctx.idPrefix}${value}`;
      } else {
        value = prefixRefs(value);
      }
      attrs += ` ${name}="${escapeAttr(value)}"`;
    }
    checkProvenance(node, tag);
    const children = node.c.map((child) => (typeof child === 'string' ? text(child) : element(child, false))).join('');
    return `<${tag}${attrs}>${children}</${tag}>`;
  }

  function text(value: string): string {
    if (++nodes > SVG_LIMITS.nodes) throw new Bounds();
    return escapeText(value);
  }

  function checkProvenance(node: { t: string; p: Record<string, unknown>; c: WidgetNode[] }, tag: string): void {
    const textId = node.p['data-text-id'];
    if (textId !== undefined) {
      const id = String(textId);
      if (!ctx.textIds.has(id)) errors.push(`data-text-id="${id}" is not a literal id in the source.`);
      else if (id in labels) errors.push(`data-text-id="${id}" is drawn more than once.`);
      else if (node.c.some((c) => typeof c !== 'string')) errors.push(`<${tag} data-text-id="${id}"> must hold only its words.`);
      else labels[id] = node.c.join('');
    }
    const row = node.p['data-row'];
    const col = node.p['data-col'];
    if (row !== undefined) {
      const record = ctx.rows.get(String(row));
      if (!record) errors.push(`data-row="${String(row)}" names no row.`);
      else if (col !== undefined && !Object.hasOwn(record, String(col))) {
        errors.push(`data-col="${String(col)}" is not a column of row "${String(row)}".`);
      }
    } else if (col !== undefined) {
      errors.push(`data-col="${String(col)}" needs a data-row beside it.`);
    }
  }

  let svg: string;
  try {
    svg = element(tree, true);
  } catch (e) {
    if (e instanceof Bounds) return fail([`The drawing has more than ${SVG_LIMITS.nodes} nodes.`]);
    throw e;
  }
  if (errors.length > 0) return fail([...new Set(errors)]);
  if (Buffer.byteLength(svg) > SVG_LIMITS.bytes) return fail([`The SVG is larger than ${SVG_LIMITS.bytes / 1024} KB.`]);
  return { svg, labels, warnings: [...warnings] };
}

class Bounds extends Error {}

function fail(messages: string[]): { errors: WidgetError[] } {
  return {
    errors: messages.map((message) => ({
      line: 0,
      message,
      fix: 'The rendered output broke a widget rule; fix the module so its output follows it.',
    })),
  };
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * A serialized widget SVG with people's label edits: each labelled element
 * holds only its words (serializeSvg enforces it), so a label is a text swap.
 */
export function withLabels(svg: string, labels: Record<string, string>): string {
  return svg.replace(
    /(<(\w+)[^>]*\sdata-text-id="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g,
    (whole, open: string, _tag: string, id: string, _text: string, close: string) =>
      Object.hasOwn(labels, id) ? `${open}${escapeText(labels[id]!)}${close}` : whole,
  );
}

/** Each label's words in a serialized widget SVG, by text id. */
export function labelsOf(svg: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const m of svg.matchAll(/<(\w+)[^>]*\sdata-text-id="([^"]+)"[^>]*>([^<]*)<\/\1>/g)) {
    labels[m[2]!] = m[3]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return labels;
}

/** An element node as the runtime builds it: a tag, an object of props, an array of children. */
function isNode(node: unknown): node is { t: string; p: Record<string, unknown>; c: WidgetNode[] } {
  const n = node as { t?: unknown; p?: unknown; c?: unknown } | null;
  return typeof n === 'object' && n !== null && typeof n.t === 'string' && typeof n.p === 'object' && n.p !== null && !Array.isArray(n.p) && Array.isArray(n.c);
}
