import { createContext, useContext, type ComponentType } from 'react';
import { BLOCK_TEXT_EN, type BlockText } from './text.ts';

/** One choice's votes, as this viewer sees them. */
export type ChoiceTally = {
  /** Votes per option id (only options that are still in the block). */
  counts: Record<string, number>;
  /** The option this viewer voted for, or null. */
  mine: string | null;
  /** The recorded decision (from the API, never the document), or null. */
  decision: {
    optionId: string;
    /** The option's label as it read when decided. */
    label: string;
    /** The question or the option's label changed after the pick. */
    changedSinceDecided: boolean;
    rationale: string;
    evidence: Evidence[];
    openQuestions: string[];
    decidedByName: string;
  } | null;
};

export type PickInput = {
  optionId: string;
  rationale: string;
  evidence: Evidence[];
  openQuestions: string[];
};

export type Evidence = { label: string; url?: string; docId?: string };

/** Someone a task can be assigned to: a person or an agent. */
export type Assignee = { id: string; name: string; kind: 'person' | 'agent' };

/**
 * What an embed block shows, as the server resolved it for this viewer. A link
 * card is text and one inlined image: the browser never fetches the linked
 * page. `none` is an embed this viewer can't read or that holds nothing.
 */
export type EmbedState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'link'; url: string; title: string; description: string; siteName: string; image: string | null }
  | { status: 'document'; documentId: string; title: string; excerpt: string };

/**
 * What Primer's blocks need from the app around them: votes and picks go
 * through the API (never the document), and assignees are looked up there.
 * The web editor provides it; without it (the server editor, static
 * renders) the blocks render read-only.
 */
export type PrimerBlockServices = {
  /** A person with edit rights may pick; agents and readers never can. */
  canPick: boolean;
  /** Whether this viewer may vote (people with write access). */
  canVote: boolean;
  /** null until the first read arrives. */
  useTally(choiceId: string): ChoiceTally | null;
  vote(choiceId: string, optionId: string): Promise<void>;
  pick(choiceId: string, input: PickInput): Promise<void>;
  assignees: Assignee[];
  /** The embed block's content for this viewer (`url` / `documentId` are the block's props). */
  useEmbed(blockId: string, url: string, documentId: string): EmbedState;
  /** The blocks' strings in the viewer's locale. */
  text: BlockText;
  /** Renders a page block's frame and overlay (the web editor). */
  PageView?: ComponentType<{ blockId: string; title: string; sourceKey: string }>;
  /** Renders a widget block's SVG, label editing and comments (the web editor). */
  WidgetView?: ComponentType<{ blockId: string; props: { widgetId: string; hash: string; textIds: string } }>;
  /** Renders a data-table block's rows, cell editing and row comments (the web editor). */
  DataTableView?: ComponentType<{
    blockId: string;
    props: { collection: string; columns: string; scope: 'shared' | 'personal' };
    /** Sets the block's props (the collection, the columns). */
    update: (props: Partial<{ collection: string; columns: string }>) => void;
  }>;
};

export const PrimerBlocksContext = createContext<PrimerBlockServices | null>(null);

export function usePrimerBlockServices(): PrimerBlockServices | null {
  return useContext(PrimerBlocksContext);
}

/** The blocks' strings: the editor's locale, English in exports. */
export function useBlockText(): BlockText {
  return useContext(PrimerBlocksContext)?.text ?? BLOCK_TEXT_EN;
}

/** A JSON array prop, read defensively: the document is client-writable. */
export function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Evidence entries from a choice's `evidence` prop; links only when http(s). */
export function parseEvidence(raw: unknown): Evidence[] {
  const out: Evidence[] = [];
  for (const item of parseJsonArray(raw).slice(0, 50)) {
    if (typeof item !== 'object' || item === null) continue;
    const { label, url, docId } = item as Record<string, unknown>;
    if (typeof label !== 'string') continue;
    const entry: Evidence = { label: label.slice(0, 500) };
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) entry.url = url.slice(0, 2000);
    if (typeof docId === 'string' && /^[0-9a-f-]{36}$/i.test(docId)) entry.docId = docId;
    out.push(entry);
  }
  return out;
}

/** Open questions from a choice's `openQuestions` prop. */
export function parseOpenQuestions(raw: unknown): string[] {
  return parseJsonArray(raw)
    .filter((q): q is string => typeof q === 'string')
    .slice(0, 50)
    .map((q) => q.slice(0, 1000));
}
