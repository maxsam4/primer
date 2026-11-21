import { RECORD_COLLECTION_RE, type PagePolicy, type RecordsSnapshot } from '@polygonlabs/primer-api-types';

// A page reads records only if it opts in, in its <head>:
//   <meta name="primer-records" content="read">
// The opt-in is read from the stored page itself whenever the page is served
// or described (versionContent.ts), so the CSP a page runs under and the host's
// decision to bind records to it always come from the same bytes.
const META_RE = /<meta\b[^>]*>/gi;

/** The page's <head> as markup that counts: comments and script/style bodies, which can hold meta-looking text, are cut out. */
function headOf(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  return (end === -1 ? html : html.slice(0, end)).replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
}

export function readsRecords(html: string): boolean {
  const head = headOf(html);
  for (const tag of head.match(META_RE) ?? []) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (name?.toLowerCase() === 'primer-records' && content?.toLowerCase() === 'read') return true;
  }
  return false;
}

export function pagePolicyOf(html: string): PagePolicy {
  return readsRecords(html) ? 'records' : 'standard';
}

/** The element a checkpoint's page reads its frozen records from (v1.js). */
export const FROZEN_RECORDS_ID = 'primer-records-frozen';

/**
 * The collections a page declares it reads, in its <head>:
 *   <meta name="primer-records-collections" content="votes tallies">
 * Only these go out over an external share (`frozenForShare`). Names that
 * aren't valid collection names are ignored.
 */
export function declaredCollections(html: string): string[] {
  const head = headOf(html);
  const out = new Set<string>();
  for (const tag of head.match(META_RE) ?? []) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (name?.toLowerCase() !== 'primer-records-collections') continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    for (const c of (content?.[1] ?? content?.[2] ?? content?.[3] ?? '').split(/\s+/)) if (RECORD_COLLECTION_RE.test(c)) out.add(c);
  }
  return [...out];
}

/**
 * What an external recipient's copy of a page's frozen records holds: only
 * the collections the page declares it reads (never Primer's own `primer.*`
 * ones, whose record ids are people's ids), and of each record only its id
 * and data. No identities (who wrote it), versions, times or change ids
 * leave Primer, and personal records are never frozen at all.
 */
export function frozenForShare(snapshot: RecordsSnapshot, html: string): FrozenRecords {
  const collections: FrozenRecords['collections'] = {};
  for (const name of declaredCollections(html)) {
    // Primer's own collections (votes: record id = the voter) never go out.
    if (name.startsWith('primer.')) continue;
    if (Object.hasOwn(snapshot.collections, name)) collections[name] = snapshot.collections[name]!.map((r) => ({ recordId: r.recordId, data: r.data }));
  }
  return { collections };
}

/** Frozen records as a page reads them: a whole snapshot (checkpoint views,
 *  for people who can read the live records anyway) or a share's copy. */
export type FrozenRecords = { collections: Record<string, { recordId: string; data: Record<string, unknown> }[]> } | RecordsSnapshot;

/**
 * A checkpoint's page served with its frozen records (`records.json`), for a
 * page that opted in to records: shares and checkpoint views answer the page's
 * record reads from these, in the page (companion v1.js), never from live
 * records, and refuse writes. Only shared records are ever frozen; an external
 * share gets `frozenForShare`'s narrowed copy. The JSON sits in an inert
 * `application/json` script at the top of <head>, with `<` escaped so no text
 * in it can close the element.
 */
export function withFrozenRecords(html: string, frozen: FrozenRecords | null): string {
  if (frozen === null || !readsRecords(html)) return html;
  const json = JSON.stringify(frozen).replace(/</g, '\\u003c');
  const tag = `<script type="application/json" id="${FROZEN_RECORDS_ID}">${json}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html;
}
