import * as Y from 'yjs';
import type { Target, WidgetLabelOutcome } from '@polygonlabs/primer-api-types';
import type { PlannedEdit } from '../live/pipeline.ts';
import { fragmentFor, MAIN_TAB, tabFragmentName, tabsOf } from '../live/reach.ts';
import { withLiveDocument } from '../live/instance.ts';
import { docText, readPidText, setPidText, writeText } from '../page/text.ts';
import { labelsOf } from './serialize.ts';

/**
 * A label's words live in its fragment `widget/<blockId>/<textId>`, shaped
 * like page text (page/text.ts): one paragraph whose block id is the widget
 * block's, so a label target `{ tabId, blockId, textId }` is read, written,
 * versioned, suggested and commented like a pid. Labels are one line.
 */
export function labelEdit(target: Target & { textId: string }, text: string): PlannedEdit {
  return setPidText(target, text.replace(/\s+/g, ' ').trim());
}

/** A label's current words, or null when the fragment holds none yet. */
export function readLabel(doc: Y.Doc, blockId: string, textId: string): string | null {
  const target: Target = { tabId: MAIN_TAB, blockId, textId };
  return fragmentFor(doc, target).length === 0 ? null : readPidText(doc, target);
}

/** The tab whose fragment holds block `blockId`, or null. */
export function tabOfBlock(doc: Y.Doc, blockId: string): string | null {
  for (const tab of tabsOf(doc)) {
    if (findElement(doc.getXmlFragment(tabFragmentName(tab.id)), (el) => el.nodeName === 'blockContainer' && el.getAttribute('id') === blockId)) {
      return tab.id;
    }
  }
  return null;
}

function findElement(node: Y.XmlFragment | Y.XmlElement, match: (el: Y.XmlElement) => boolean): Y.XmlElement | null {
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (match(child)) return child;
    const found = findElement(child, match);
    if (found) return found;
  }
  return null;
}

/**
 * Three-way carry of label words over a republish, per text id the new
 * publish draws: `base` = the previous publish's words, `mine` = the
 * fragment's current words (people's edits), `theirs` = the new publish's.
 * A person's edit is never lost: if the agent changed the same label too, the
 * person's words stay and the agent is told (`kept`).
 */
export function carryLabels(
  base: Record<string, string>,
  mine: Record<string, string | null>,
  theirs: Record<string, string>,
): { texts: Record<string, string>; outcomes: WidgetLabelOutcome[] } {
  const texts: Record<string, string> = {};
  const outcomes: WidgetLabelOutcome[] = [];
  for (const [textId, agentText] of Object.entries(theirs)) {
    const current = mine[textId] ?? null;
    if (current === null || current === agentText || current === base[textId]) {
      texts[textId] = agentText;
    } else if (agentText === base[textId]) {
      texts[textId] = current;
      outcomes.push({ textId, status: 'carried', text: current, agentText });
    } else {
      texts[textId] = current;
      outcomes.push({ textId, status: 'kept', text: current, agentText });
    }
  }
  return { texts, outcomes };
}

/** Each label's current words in `row`'s widget block, by text id (null: none yet). */
export async function fragmentLabels(row: { documentId: string; blockId: string }, textIds: string[]): Promise<Record<string, string | null>> {
  if (textIds.length === 0) return {};
  return withLiveDocument(row.documentId, (doc) =>
    Object.fromEntries(textIds.map((textId) => [textId, readLabel(doc, row.blockId, textId)])),
  );
}

/** Each label's words once `theirs` (a new render's labels) is published over `row`'s publish. */
export async function carryFor(row: { documentId: string; blockId: string; publishedSvgLight: string | null }, theirs: Record<string, string>) {
  const base = row.publishedSvgLight ? labelsOf(row.publishedSvgLight) : {};
  return carryLabels(base, await fragmentLabels(row, Object.keys(theirs)), theirs);
}

/**
 * A label's new words, carried against the words the fragment holds when the
 * write is applied (inside the pipeline's turn), so a person's edit made
 * while the publish was in flight is carried, never overwritten.
 */
export function carryEdit(target: Target & { textId: string }, base: string | undefined, agentText: string): PlannedEdit {
  return {
    target,
    inverse: false,
    build: (tr) => {
      let started = false;
      tr.doc.descendants((node) => {
        if (node.type.name === 'blockContainer' && node.attrs.id === target.blockId) started = true;
        return !started;
      });
      const mine = started ? docText(tr.doc) : null;
      const base1: Record<string, string> = base === undefined ? {} : { x: base };
      const { texts } = carryLabels(base1, { x: mine }, { x: agentText });
      writeText(tr, target.blockId, texts.x!.replace(/\s+/g, ' ').trim());
    },
  };
}
