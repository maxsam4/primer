import { useEffect, useState } from 'react';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/ariakit';
import { primerSchema } from '@primer/blocks';
import type { LiveDocDTO, LiveOp, Reconciliation } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { editorDictionary, t } from '../i18n/index.ts';

/** A block as BlockNote's `editor.document` lists it. */
export type DraftBlock = { id: string; type: string; props?: unknown; content?: unknown; children?: DraftBlock[] };

type Flat = { block: DraftBlock; parentId: string | null; key: string };

function flatten(blocks: DraftBlock[], parentId: string | null = null, out: Flat[] = []): Flat[] {
  for (const block of blocks) {
    out.push({ block, parentId, key: JSON.stringify([block.type, block.props, block.content]) });
    flatten(block.children ?? [], block.id, out);
  }
  return out;
}

/** A new block as partial-block JSON, without ids (the server makes them). */
function fresh(block: DraftBlock): Record<string, unknown> {
  return { type: block.type, props: block.props, content: block.content, children: (block.children ?? []).map(fresh) };
}

/**
 * The ops that turn `base` (the tab when suggesting began) into `draft`:
 * a changed block is an update, a removed one a delete, and new blocks are
 * added after the block before them. `versions` are the blocks' versions at
 * the start, so a block someone changed since is a conflict to decide.
 */
export function draftOps(base: DraftBlock[], draft: DraftBlock[], versions: Map<string, string>, tabId: string): LiveOp[] {
  const before = new Map(flatten(base).map((f) => [f.block.id, f]));
  const after = flatten(draft);
  const kept = new Set(after.map((f) => f.block.id));
  const ops: LiveOp[] = [];
  const adds = new Map<string, Extract<LiveOp, { op: 'add' }>>();
  let previous: string | null = null;
  for (const f of after) {
    const old = before.get(f.block.id);
    const version = versions.get(f.block.id);
    if (old) {
      if (old.key !== f.key && version) {
        const { type, props, content } = f.block;
        ops.push({ op: 'update', target: { tabId, blockId: f.block.id }, block: { json: { type, props, content } as Record<string, unknown> }, expectVersion: version });
      }
      previous = f.block.id;
      continue;
    }
    // A new block's children go with it.
    if (f.parentId !== null && !before.has(f.parentId)) continue;
    const anchor = previous ?? base[0]?.id;
    if (!anchor) continue;
    const key = previous ? `after:${anchor}` : `before:${anchor}`;
    let add = adds.get(key);
    if (!add) {
      add = { op: 'add', at: { tabId, blockId: anchor }, position: previous ? 'after' : 'before', blocks: [] };
      adds.set(key, add);
      ops.push(add);
    }
    add.blocks.push({ json: fresh(f.block) });
  }
  for (const [id, f] of before) {
    const version = versions.get(id);
    if (kept.has(id) || !version || (f.parentId !== null && !kept.has(f.parentId))) continue;
    ops.push({ op: 'delete', target: { tabId, blockId: id }, expectVersion: version });
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
