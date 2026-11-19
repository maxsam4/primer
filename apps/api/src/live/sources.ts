import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { Node as PmNode } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import type { DocumentFormat } from '@polygonlabs/primer-api-types';
import { blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';
import { sign, verify } from './signing.ts';

/**
 * Where an imported group of blocks came from, so export can re-emit it
 * verbatim while it is untouched. One entry per top-level group of the source
 * file (a paragraph, a whole list, a table, a raw HTML chunk…), keyed in the
 * Y.Doc's `sources` map by the group's first block id.
 *
 * - `slice`: the group's exact source lines; `gap`: the blank lines after it.
 * - `groupIds`: the top-level blocks the group became, in order.
 * - `version`: `groupVersion` of those blocks right after import.
 * - `refs`: reference-definition labels the group uses; `defines`: the labels
 *   it defines. A group is verbatim only while every group defining one of its
 *   labels is verbatim too.
 *
 * Entries and `meta` are signed by the server at import (`mac`, over the
 * document id and every field): the Y.Doc is writable by every editor, and
 * export trusts only what verifies.
 */
export type SourceEntry = {
  slice: string;
  gap: string;
  groupIds: string[];
  version: string;
  refs: string[];
  defines: string[];
};

/** The Y.Doc's `meta` map: how the document was imported. `frontMatter` is
 *  the raw front matter and `lead` the blank lines before the first group. */
export type LiveMeta = { format: DocumentFormat; frontMatter: string; lead: string };

const SOURCES = 'sources';
const META = 'meta';

const entryFields = (key: string, e: SourceEntry) => [key, e.slice, e.gap, e.groupIds, e.version, e.refs, e.defines];
const metaFields = (m: LiveMeta) => [META, m.format, m.frontMatter, m.lead];

/** Writes signed `sources` entries and `meta` (import, republish). */
export function writeSources(doc: Y.Doc, documentId: string, entries: Map<string, SourceEntry>, meta: LiveMeta): void {
  doc.transact(() => {
    const sources = doc.getMap<unknown>(SOURCES);
    for (const [key, entry] of entries) sources.set(key, { ...entry, mac: sign(documentId, entryFields(key, entry)) });
    const map = doc.getMap<unknown>(META);
    map.set('format', meta.format);
    map.set('frontMatter', meta.frontMatter);
    map.set('lead', meta.lead);
    map.set('mac', sign(documentId, metaFields(meta)));
  });
}

/** Replaces every `sources` entry and `meta` (a republish merge), signed. */
export function rewriteSources(doc: Y.Doc, documentId: string, entries: Map<string, SourceEntry>, meta: LiveMeta): void {
  doc.transact(() => {
    const sources = doc.getMap<unknown>(SOURCES);
    for (const key of [...sources.keys()]) if (!entries.has(key)) sources.delete(key);
    writeSources(doc, documentId, entries, meta);
  });
}

/** The `sources` entries the server signed for this document, well typed;
 *  anything else is ignored (its blocks are serialised). */
export function trustedSources(doc: Y.Doc, documentId: string): Map<string, SourceEntry> {
  const out = new Map<string, SourceEntry>();
  for (const [key, raw] of doc.getMap<unknown>(SOURCES).entries()) {
    const entry = asEntry(raw);
    if (entry && verify(documentId, entryFields(key, entry), (raw as { mac?: unknown }).mac)) out.set(key, entry);
  }
  return out;
}

/** The signed `meta`; without a valid signature there is no front matter or
 *  lead to re-emit. */
export function trustedMeta(doc: Y.Doc, documentId: string): LiveMeta {
  const map = doc.getMap<unknown>(META);
  const meta = { format: map.get('format'), frontMatter: map.get('frontMatter'), lead: map.get('lead') };
  const typed =
    (meta.format === 'markdown' || meta.format === 'text' || meta.format === 'html') &&
    typeof meta.frontMatter === 'string' &&
    typeof meta.lead === 'string';
  if (typed && verify(documentId, metaFields(meta as LiveMeta), map.get('mac'))) return meta as LiveMeta;
  return { format: 'markdown', frontMatter: '', lead: '' };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function asEntry(raw: unknown): SourceEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.slice !== 'string' || typeof e.gap !== 'string' || typeof e.version !== 'string') return null;
  if (!isStrings(e.groupIds) || e.groupIds.length === 0 || !isStrings(e.refs) || !isStrings(e.defines)) return null;
  return { slice: e.slice, gap: e.gap, groupIds: e.groupIds, version: e.version, refs: e.refs, defines: e.defines };
}

/** A fragment as a ProseMirror doc in Primer's schema. Reads only. */
export function pmDocOf(fragment: Y.XmlFragment): PmNode {
  const schema = serverEditor().editor.pmSchema;
  if (fragment.length === 0) return schema.topNodeType.createAndFill()!;
  return PmNode.fromJSON(schema, yXmlFragmentToProsemirrorJSON(fragment));
}

/** The recursive version of a group of blocks (C2's block version over each),
 *  or null when one of them is gone. Comment and suggestion marks don't count. */
export function groupVersion(pmDoc: PmNode, ids: string[]): string | null {
  const hash = createHash('sha256');
  for (const id of ids) {
    const found = findBlock(pmDoc, id);
    if (!found) return null;
    hash.update(blockVersion(found.node)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
