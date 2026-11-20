import { useEffect, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/ariakit';
import { primerSchema } from '@primer/blocks';
import type { LiveDocDTO, LiveOp, Reconciliation } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { editorDictionary, t } from '../i18n/index.ts';

/** A block as BlockNote's `editor.document` lists it. */
export type DraftBlock = { id: string; type: string; props?: unknown; content?: unknown; children?: DraftBlock[] };

type Flat = { block: DraftBlock; parentId: string | null; index: number; key: string };

const keyOf = (block: DraftBlock) => JSON.stringify([block.type, block.props, block.content]);

function flatten(blocks: DraftBlock[], parentId: string | null = null, out: Flat[] = []): Flat[] {
  blocks.forEach((block, index) => {
    out.push({ block, parentId, index, key: keyOf(block) });
    flatten(block.children ?? [], block.id, out);
  });
  return out;
}

/** A new block as partial-block JSON, without ids (the server makes them). */
function fresh(block: DraftBlock): Record<string, unknown> {
  return { type: block.type, props: block.props, content: block.content, children: (block.children ?? []).map(fresh) };
}

/** The siblings that were siblings already and keep their order (the longest
 *  such run); every other existing sibling moved here. */
function staying(siblings: DraftBlock[], parentId: string | null, before: Map<string, Flat>): Set<string> {
  const items = siblings.flatMap((s) => {
    const old = before.get(s.id);
    return old && old.parentId === parentId ? [{ id: s.id, index: old.index }] : [];
  });
  const length = items.map(() => 1);
  const from = items.map(() => -1);
  items.forEach((item, i) => {
    for (let j = 0; j < i; j++) {
      if (items[j]!.index < item.index && length[j]! + 1 > length[i]!) {
        length[i] = length[j]! + 1;
        from[i] = j;
      }
    }
  });
  const out = new Set<string>();
  for (let i = length.indexOf(Math.max(...length)); i >= 0; i = from[i]!) out.add(items[i]!.id);
  return out;
}

/**
 * The ops that turn `base` (the tab when suggesting began) into `draft`. Each
 * op is suggested against `base` on its own, so every op is placed relative to
 * blocks that exist there: a changed block is an update, a block under a new
 * parent or out of order among its siblings a move, a removed one a delete,
 * and new blocks (with their children) are added after their previous sibling,
 * else as their parent's first child, else before the next sibling that stays.
 * `versions` are the blocks' versions at the start, so a block someone changed
 * since is a conflict to decide.
 */
export function draftOps(base: DraftBlock[], draft: DraftBlock[], versions: Map<string, string>, tabId: string): LiveOp[] {
  const before = new Map(flatten(base).map((f) => [f.block.id, f]));
  const kept = new Set<string>();
  const ops: LiveOp[] = [];
  const adds = new Map<string, Extract<LiveOp, { op: 'add' }>>();
  const at = (blockId: string) => ({ tabId, blockId });

  const walk = (siblings: DraftBlock[], parentId: string | null) => {
    const stays = staying(siblings, parentId, before);
    let previous: string | null = null;
    siblings.forEach((block, i) => {
      const later = siblings.slice(i + 1);
      const next = (later.find((s) => stays.has(s.id)) ?? later.find((s) => before.has(s.id)))?.id;
      const place = (): [string, 'after' | 'firstChild' | 'before'] | null =>
        previous ? [previous, 'after'] : parentId ? [parentId, 'firstChild'] : next ? [next, 'before'] : null;
      const old = before.get(block.id);
      if (!old) {
        const [anchor, position] = place() ?? [base[0]?.id, 'before' as const];
        if (!anchor) return;
        let add = adds.get(`${position}:${anchor}`);
        if (!add) {
          add = { op: 'add', at: at(anchor), position, blocks: [] };
          adds.set(`${position}:${anchor}`, add);
          ops.push(add);
        }
        add.blocks.push({ json: fresh(block) });
        return;
      }
      kept.add(block.id);
      const version = versions.get(block.id);
      const to = stays.has(block.id) ? null : place();
      if (to && version) ops.push({ op: 'move', target: at(block.id), at: at(to[0]), position: to[1], expectVersion: version });
      if (old.key !== keyOf(block) && version) {
        const { type, props, content } = block;
        ops.push({ op: 'update', target: at(block.id), block: { json: { type, props, content } as Record<string, unknown> }, expectVersion: version });
      }
      previous = block.id;
      walk(block.children ?? [], block.id);
    });
  };
  walk(draft, null);

  for (const [id, f] of before) {
    const version = versions.get(id);
    if (kept.has(id) || !version || (f.parentId !== null && !kept.has(f.parentId))) continue;
    ops.push({ op: 'delete', target: at(id), expectVersion: version });
  }
  return ops;
}

/**
 * Suggesting: the tab as it was, in a draft editor of its own. Nothing
 * reaches the document until Send, which stores each change as a suggestion
 * (apply ops with `mode: 'suggest'`) for the owner or an editor to decide.
 */
export function SuggestDraft(props: {
  documentId: string;
  tabId: string;
  base: DraftBlock[];
  theme: 'light' | 'dark';
  onDiscard: () => void;
  onSent: (count: number) => void;
}) {
  const { documentId, tabId, base } = props;
  const [versions, setVersions] = useState<Map<string, string> | null>(null);
  const [count, setCount] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = useCreateBlockNote(
    { schema: primerSchema, initialContent: base.length > 0 ? (base as never) : undefined, dictionary: editorDictionary() },
    [],
  );

  useEffect(() => {
    let live = true;
    void api(`/api/documents/${encodeURIComponent(documentId)}/live?format=json&tabId=${encodeURIComponent(tabId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as LiveDocDTO;
        if (live) setVersions(new Map(body.blocks.map((b) => [b.target.blockId, b.version])));
      })
      .catch((err: unknown) => live && setError(t('suggestDraft.failed', { status: String((err as Error).message) })));
    return () => {
      live = false;
    };
  }, [documentId, tabId]);

  const ops = () => (versions ? draftOps(base, draft.document as DraftBlock[], versions, tabId) : []);
  useEffect(() => {
    setCount(ops().length);
    return draft.onChange(() => setCount(ops().length));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, versions]);

  const send = async () => {
    const list = ops();
    if (list.length === 0) return;
    setSending(true);
    setError(null);
    const res = await api(`/api/documents/${encodeURIComponent(documentId)}/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseVersion: 0, mode: 'suggest', onConflict: 'suggest', ops: list }),
    }).catch(() => null);
    setSending(false);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { refusal?: { message: string } } | null;
      setError(body?.refusal?.message ?? t('suggestDraft.failed', { status: String(res?.status ?? 0) }));
      return;
    }
    const out = (await res.json()) as Reconciliation;
    props.onSent(out.outcomes.filter((o) => o.status === 'suggested').length);
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-suggest-draft>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
          {t('liveEditor.modeSuggesting')}
        </span>
        <span className="hidden min-w-0 flex-1 text-emerald-800/90 sm:block dark:text-emerald-200/80">{t('suggestDraft.banner')}</span>
        <span className="ml-auto tabular-nums text-emerald-800 sm:ml-0 dark:text-emerald-300">
          {count === 0 ? t('suggestDraft.none') : t('suggestDraft.count', { count })}
        </span>
        <button
          type="button"
          onClick={props.onDiscard}
          className="h-7 rounded-md border border-emerald-300 bg-white px-2.5 font-medium text-emerald-900 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-transparent dark:text-emerald-200 dark:hover:bg-emerald-900/40"
        >
          {t('suggestDraft.discard')}
        </button>
        <button
          type="button"
          onClick={() => void send()}
          disabled={count === 0 || sending}
          className="h-7 rounded-md bg-emerald-600 px-3 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
        >
          {sending ? t('suggestDraft.sending') : t('suggestDraft.send')}
        </button>
        {error && (
          <p role="alert" className="w-full text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-l-2 border-emerald-500 py-4">
        <BlockNoteView editor={draft} theme={props.theme} />
      </div>
    </div>
  );
}
