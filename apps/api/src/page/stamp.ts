// Page text stamping (M6.1).
//
// An HTML page's editable text lives in elements whose children are only text
// and <br>. At publish each such element gets a stable `data-pid`, inserted
// into the ORIGINAL upload (not the sanitized output) so the rest of the page
// stays byte for byte. Each pid's text is later edited in its own Y fragment
// and spliced back at the element's source span (splice.ts).
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { matchPids } from './match.ts';
import { spliceSpans } from './splice.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

export type PidInfo = {
  pid: string;
  tag: string;
  /** Tag names with their index among same-tag siblings, from <body>: `div[2]/p[0]`. */
  path: string;
  /** The element's content in the source: `[startTag.endOffset, endTag.startOffset]`. */
  span: [number, number];
  /** The text people edit: see `pageText`. */
  text: string;
};

/** A candidate before it has a pid. `keptPid` is a valid existing `data-pid`. */
export type PageElement = Omit<PidInfo, 'pid'> & { keptPid?: string };

/** Elements whose content is never page text. */
const SKIP = new Set(['script', 'style', 'template', 'textarea', 'title', 'head', 'noscript', 'iframe', 'object']);
/** `<primer-table>`, `<primer-code>`, …: block state edited as embeds, never as page text. */
export const isEmbedTag = (tag: string) => tag.startsWith('primer-');
const VALID_PID = /^[A-Za-z0-9_-]{1,64}$/;

/** Deepest element nesting a page may have; past it the page is refused (the walks recurse). */
export const MAX_NESTING = 512;

export class PageTooDeep extends Error {
  constructor() {
    super(`The page nests elements more than ${MAX_NESTING} levels deep.`);
  }
}

/**
 * The one text form for page text, used for seeding fragments, splicing,
 * three-way comparison and the bridge's script-drawn check: `<br>` is `\n`;
 * outside <pre>, every other run of ASCII whitespace is one space and the ends
 * are trimmed (so source indentation never reads as an edit); inside <pre> the
 * text is kept as is.
 */
export function pageText(parts: (string | '\n')[], pre: boolean): string {
  if (pre) return parts.join('');
  return parts
    .map((p) => (p === '\n' ? '\n' : p.replace(/[ \t\n\r\f]+/g, ' ')))
    .join('')
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

/** Every text candidate of a page, in document order, with its existing pid attribute. */
function scan(html: string): { elements: (PageElement & { el: Element })[]; strays: Element[] } {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const elements: (PageElement & { el: Element })[] = [];
  const strays: Element[] = [];

  const visit = (el: Element, path: string, pre: boolean, depth: number): void => {
    if (depth > MAX_NESTING) throw new PageTooDeep();
    const tag = el.tagName;
    if (SKIP.has(tag) || isEmbedTag(tag)) {
      // Never page text: a pid here would make the bridge write into it.
      if (el.attrs.some((a) => a.name === 'data-pid')) strays.push(el);
      return;
    }
    const inPre = pre || tag === 'pre';
    const parts = textParts(el);
    const loc = el.sourceCodeLocation;
    if (parts && loc?.startTag && loc.endTag) {
      const text = pageText(parts, inPre);
      if (text.trim().length > 0) {
        const existing = el.attrs.find((a) => a.name === 'data-pid')?.value;
        elements.push({
          el,
          tag,
          path,
          span: [loc.startTag.endOffset, loc.endTag.startOffset],
          text,
          ...(existing !== undefined && VALID_PID.test(existing) ? { keptPid: existing } : {}),
        });
        return;
      }
    }
    if (el.attrs.some((a) => a.name === 'data-pid')) strays.push(el);
    const counts = new Map<string, number>();
    for (const child of el.childNodes) {
      if (!('tagName' in child)) continue;
      const n = counts.get(child.tagName) ?? 0;
      counts.set(child.tagName, n + 1);
      visit(child, `${path ? `${path}/` : ''}${child.tagName}[${n}]`, inPre, depth + 1);
    }
  };

  const htmlEl = doc.childNodes.find((n): n is Element => 'tagName' in n && n.tagName === 'html');
  const body = htmlEl?.childNodes.find((n): n is Element => 'tagName' in n && n.tagName === 'body');
  if (body) {
    if (body.attrs.some((a) => a.name === 'data-pid')) strays.push(body);
    const counts = new Map<string, number>();
    for (const child of body.childNodes) {
      if (!('tagName' in child)) continue;
      const n = counts.get(child.tagName) ?? 0;
      counts.set(child.tagName, n + 1);
      visit(child, `${child.tagName}[${n}]`, false, 1);
    }
  }
  return { elements, strays };
}

/** The element's children as text and `\n` (for <br>), or null when it holds anything else. */
function textParts(el: Element): (string | '\n')[] | null {
  if (el.childNodes.length === 0) return null;
  const parts: (string | '\n')[] = [];
  for (const child of el.childNodes as Node[]) {
    if (child.nodeName === '#text') parts.push((child as TextNode).value);
    else if ('tagName' in child && child.tagName === 'br' && child.childNodes.length === 0) parts.push('\n');
    else return null;
  }
  return parts;
}

/** The pids of an already stamped page. */
export function readPids(stamped: string): PidInfo[] {
  return scan(stamped)
    .elements.filter((e) => e.keptPid !== undefined)
    .map(({ keptPid, tag, path, span, text }) => ({ pid: keptPid!, tag, path, span, text }));
}

/**
 * Stamps every text element of `original` with a `data-pid`. A valid, unique
 * existing `data-pid` is kept; otherwise the element takes the pid of the
 * element it matches in `previous` (the last publish), or a fresh `p<n>`.
 * Inserting ` data-pid="…"` into start tags is the only change, except that a
 * duplicate or invalid `data-pid` is rewritten in place and one on an element
 * that is not page text is removed (the bridge writes text into every element
 * carrying a pid, so a stray one would wipe its children).
 *
 * `taken` are further pids whose fragments still exist in the document (from
 * earlier publishes): a fresh pid never reuses one.
 *
 * `uncertain` lists the pids whose match to `previous` was ambiguous: people's
 * text on them is never carried silently (carry.ts).
 */
export function stampPage(
  original: string,
  previous: PidInfo[] = [],
  taken: string[] = [],
): { stamped: string; pids: PidInfo[]; uncertain: string[] } {
  const { elements, strays } = scan(original);

  const seen = new Set<string>();
  for (const e of elements) {
    if (e.keptPid === undefined) continue;
    if (seen.has(e.keptPid)) delete e.keptPid;
    else seen.add(e.keptPid);
  }
  const matches = matchPids(previous, elements, undefined, taken);

  // Edits as [offset, deleteLength, insert], applied in one pass.
  const edits: [number, number, string][] = [];
  elements.forEach((e, i) => {
    const pid = matches[i].pid;
    const loc = e.el.sourceCodeLocation!;
    const attr = loc.attrs?.['data-pid'];
    if (attr) {
      if (e.keptPid === pid) return;
      edits.push([attr.startOffset, attr.endOffset - attr.startOffset, `data-pid="${pid}"`]);
    } else {
      // Before the tag's final `>`; a stray `/` before it is ignored by HTML parsers.
      edits.push([loc.startTag!.endOffset - 1, 0, ` data-pid="${pid}"`]);
    }
  });
  for (const el of strays) {
    const attr = el.sourceCodeLocation?.attrs?.['data-pid'];
    if (!attr) continue;
    // Remove the attribute and the whitespace before it.
    let start = attr.startOffset;
    while (start > 0 && /\s/.test(original[start - 1])) start--;
    edits.push([start, attr.endOffset - start, '']);
  }
  const stamped = spliceSpans(
    original,
    edits.map(([at, len, html]) => ({ span: [at, at + len] as [number, number], html })),
  );

  const pids = readPids(stamped);
  const uncertain = elements.flatMap((_, i) => (matches[i].uncertain ? [matches[i].pid] : []));
  return { stamped, pids, uncertain };
}
