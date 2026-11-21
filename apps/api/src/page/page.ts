// A page block's live state (M6.2, M6.7): seeding its fragments at publish and
// rendering its current HTML on demand (export, checkpoint, agent reads).
//
// The stamped source is the page's base. Each pid's text lives in
// `page/<blockId>/<pid>` and each embed's blocks in `embed/<blockId>/<embedId>`.
// Rendering splices the pids whose text changed and the embeds whose blocks
// changed into the stamped source; everything else keeps its bytes.
import type * as Y from 'yjs';
import { Node as PmNode } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import type { PartialBlock } from '@blocknote/core';
import type { Target } from '@polygonlabs/primer-api-types';
import { blockVersion } from '../live/blocks.ts';
import { serverEditor } from '../live/editor.ts';
import type { PlannedEdit } from '../live/pipeline.ts';
import { fragmentFor } from '../live/reach.ts';
import { embedBlocks, embedSource, readEmbeds, type Embed } from './embeds.ts';
import { escapeText, spliceSpans } from './splice.ts';
import { readPids, type PidInfo } from './stamp.ts';
import { readPidText, setPidText } from './text.ts';

export function embedTarget(tabId: string, blockId: string, embedId: string): Target {
  return { tabId, blockId, embedId };
}

/** An embed's starting blocks, with ids derived from the embed id so the same
 *  source always gives the same blocks (and the same version). */
async function seedBlocks(embed: Embed): Promise<PartialBlock[]> {
  return (await embedBlocks(embed)).map((b, i) => ({ ...b, id: `${embed.embedId}-${i}` }) as PartialBlock);
}

/**
 * Edits that seed every fragment of a newly published page: each pid with its
 * stamped text, each embed with its source's blocks. `pids` limits the pid
 * edits (a republish carries pids itself). Embeds are seeded from the new
 * source, except (with `previous`, the last published source) those whose
 * source did not change: people's edits to them stay.
 */
export async function seedPage(opts: {
  tabId: string;
  blockId: string;
  stamped: string;
  pids?: PidInfo[];
  previous?: string;
}): Promise<PlannedEdit[]> {
  const pids = opts.pids ?? readPids(opts.stamped);
  const read = readEmbeds(opts.stamped);
  const earlier = opts.previous === undefined ? null : readEmbeds(opts.previous);
  const before = new Map((earlier && 'embeds' in earlier ? earlier.embeds : []).map((e) => [e.embedId, e]));
  const embeds = ('embeds' in read ? read.embeds : []).filter((e) => {
    const old = before.get(e.embedId);
    return !(old && old.kind === e.kind && old.html === e.html && old.lang === e.lang);
  });
  const edits: PlannedEdit[] = pids.map((p) => setPidText({ tabId: opts.tabId, blockId: opts.blockId, pid: p.pid }, p.text));
  for (const embed of embeds) {
    const node = serverEditor()._blocksToProsemirrorNode((await seedBlocks(embed)) as never);
    edits.push({
      target: embedTarget(opts.tabId, opts.blockId, embed.embedId),
      inverse: false,
      build: (tr) => {
        if (blockVersion(tr.doc) === blockVersion(node)) return;
        tr.replaceWith(0, tr.doc.content.size, node.content);
      },
    });
  }
  return edits;
}

/** The page's current HTML: the stamped source with people's text and edited embeds spliced in. */
export async function renderPage(doc: Y.Doc, opts: { tabId: string; blockId: string; stamped: string }): Promise<string> {
  const schema = serverEditor().editor.pmSchema;
  const replacements: { span: [number, number]; html: string }[] = [];

  for (const p of readPids(opts.stamped)) {
    const target: Target = { tabId: opts.tabId, blockId: opts.blockId, pid: p.pid };
    if (fragmentFor(doc, target).length === 0) continue;
    const text = readPidText(doc, target);
    if (text !== p.text) replacements.push({ span: p.span, html: escapeText(text) });
  }

  const read = readEmbeds(opts.stamped);
  for (const embed of 'embeds' in read ? read.embeds : []) {
    const fragment = fragmentFor(doc, embedTarget(opts.tabId, opts.blockId, embed.embedId));
    if (fragment.length === 0) continue;
    const current = PmNode.fromJSON(schema, yXmlFragmentToProsemirrorJSON(fragment));
    const seeded = serverEditor()._blocksToProsemirrorNode((await seedBlocks(embed)) as never);
    if (blockVersion(current) === blockVersion(seeded)) continue;
    const blocks = serverEditor()._prosemirrorJSONToBlocks(current.toJSON());
    replacements.push({ span: embed.span, html: await embedSource(embed.kind, blocks) });
  }

  return spliceSpans(opts.stamped, replacements);
}
