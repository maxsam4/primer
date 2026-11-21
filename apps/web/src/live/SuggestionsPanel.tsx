import { useCallback, useEffect, useState } from 'react';
import diff from 'fast-diff';
import type { Reconciliation, SuggestedEditDTO, SuggestionDTO, SuggestionsResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { useThreadEvents } from './threadEvents.ts';
import { t, type MessageKey } from '../i18n/index.ts';

const SUGGESTION_EVENTS: ReadonlySet<string> = new Set(['suggestion.created', 'suggestion.decided']);

/**
 * Open suggestions on a live document as diff cards, one per suggestion,
 * decided per change. Owners and editors accept or reject; accepting replays
 * the proposal through the server's pipeline, which refuses it while a block
 * it targets has changed since.
 */
export function SuggestionsPanel(props: {
  documentId: string;
  tabId: string;
  canDecide: boolean;
  onCount?: (n: number) => void;
  onShow?: (blockId: string) => void;
}) {
  const { documentId, tabId, onCount } = props;
  const [suggestions, setSuggestions] = useState<SuggestionDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Change sets count every open suggestion of the document: a bulk decision acts on all of them, not this tab's.
  const [sets, setSets] = useState<Map<string, number>>(new Map());

  const refresh = useCallback(async () => {
    const res = await api(`/api/documents/${encodeURIComponent(documentId)}/suggestions`).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json()) as SuggestionsResponse;
    const open = body.suggestions.filter((s) => s.status === 'open' && s.edits.some((e) => e.target.tabId === tabId));
    setSuggestions(open);
    const counts = new Map<string, number>();
    for (const s of body.suggestions) if (s.status === 'open' && s.changeSetId && !s.conflict) counts.set(s.changeSetId, (counts.get(s.changeSetId) ?? 0) + 1);
    setSets(counts);
    onCount?.(open.length);
  }, [documentId, tabId, onCount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useThreadEvents(documentId, () => void refresh(), SUGGESTION_EVENTS);

  const decide = async (id: string, decision: 'accept' | 'reject') => {
    setError(null);
    const res = await api(`/api/suggestions/${encodeURIComponent(id)}/${decision}`, { method: 'POST' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { refusal?: { message: string; fix: string } } | null;
      setError(body?.refusal ? `${body.refusal.message} ${body.refusal.fix}` : t(decision === 'accept' ? 'suggestions.acceptFailed' : 'suggestions.rejectFailed', { status: res.status }));
    }
    await refresh();
  };

  // A change set (e.g. a proposed branch) is decided at once; its
  // conflicts one by one.
  const decideSet = async (id: string, decision: 'accept' | 'reject') => {
    setError(null);
    const res = await api(`/api/change-sets/${encodeURIComponent(id)}/${decision}`, { method: 'POST' });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { refusal?: { message: string; fix: string } } | null;
      setError(body?.refusal ? `${body.refusal.message} ${body.refusal.fix}` : t(decision === 'accept' ? 'suggestions.acceptFailed' : 'suggestions.rejectFailed', { status: res.status }));
    } else if (decision === 'accept') {
      // A 200 can still leave suggestions open (a block changed since): say which.
      const left = ((await res.json().catch(() => null)) as Reconciliation | null)?.outcomes.filter((o) => o.status !== 'applied' && o.status !== 'unchanged') ?? [];
      if (left.length > 0) setError(t('suggestions.leftOpen', { count: left.length, reason: left[0]!.refusal ? `${left[0]!.refusal.message} ${left[0]!.refusal.fix}` : '' }));
    }
    await refresh();
  };

  if (suggestions.length === 0 && sets.size === 0) return <p className="p-2 text-xs text-neutral-500">{t('suggestions.none')}</p>;
  return (
    <div className="flex flex-col gap-2" data-suggestions-panel>
      {error && <p className="rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {props.canDecide &&
        [...sets].filter(([, n]) => n > 1).map(([id, n]) => (
          <div key={id} className="flex items-center justify-between gap-2 rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-800" data-change-set={id}>
            <span>{t('suggestions.changeSet', { count: n })}</span>
            <span className="flex shrink-0 gap-2 whitespace-nowrap">
              <button type="button" onClick={() => void decideSet(id, 'reject')} className="h-6 rounded border border-neutral-300 px-2 dark:border-neutral-700">
                {t('suggestions.rejectAll')}
              </button>
              <button type="button" onClick={() => void decideSet(id, 'accept')} className="h-6 rounded bg-emerald-600 px-2 text-white hover:bg-emerald-700">
                {t('suggestions.acceptAll')}
              </button>
            </span>
          </div>
        ))}
      {suggestions.map((s) => (
        <article
          key={s.id}
          className={`rounded border p-2 text-xs ${s.conflict ? 'border-amber-400 dark:border-amber-600' : 'border-neutral-200 dark:border-neutral-700'}`}
          data-suggestion-id={s.id}
          data-conflict={s.conflict || undefined}
        >
          <header className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium">{s.authorDisplayName}</span>
            {s.conflict && <span className="rounded bg-amber-100 px-1.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('suggestions.conflict')}</span>}
            {s.stale && <span className="text-amber-600">{t('suggestions.changedSince')}</span>}
          </header>
          {s.edits.map((edit, i) =>
            s.conflict ? <BothVersions key={i} edit={edit} /> : <EditDiff key={i} edit={edit} onShow={props.onShow} />,
          )}
          {props.canDecide && (
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => void decide(s.id, 'reject')} className="h-6 rounded border border-neutral-300 px-2 dark:border-neutral-700">
                {t('suggestions.reject')}
              </button>
              <button type="button" onClick={() => void decide(s.id, 'accept')} className="h-6 rounded bg-emerald-600 px-2 text-white hover:bg-emerald-700">
                {t('suggestions.accept')}
              </button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

const KIND_LABEL: Record<SuggestedEditDTO['kind'], MessageKey> = {
  replace: 'suggestions.kindReplace',
  insert: 'suggestions.kindInsert',
  delete: 'suggestions.kindDelete',
  move: 'suggestions.kindMove',
};

/** A conflict: the block as it is now and as proposed, side by side. */
function BothVersions({ edit }: { edit: SuggestedEditDTO }) {
  return (
    <div className="mt-1 grid grid-cols-2 gap-2">
      <div>
        <p className="text-neutral-500">{t('suggestions.versionNow')}</p>
        <p className="mt-0.5 whitespace-pre-wrap break-words" data-version="current">{edit.current?.markdown ?? ''}</p>
      </div>
      <div>
        <p className="text-neutral-500">{t('suggestions.versionProposed')}</p>
        <p className="mt-0.5 whitespace-pre-wrap break-words" data-version="proposed">{edit.kind === 'delete' ? '' : (edit.proposed?.markdown ?? '')}</p>
      </div>
    </div>
  );
}

/** One block's change: the current text against the proposed text. */
function EditDiff({ edit, onShow }: { edit: SuggestedEditDTO; onShow?: (blockId: string) => void }) {
  const before = edit.current?.markdown ?? '';
  const after = edit.kind === 'delete' ? '' : edit.kind === 'move' ? before : (edit.proposed?.markdown ?? '');
  return (
    <div className="mt-1">
      <button type="button" className="text-neutral-500 hover:underline" onClick={() => onShow?.(edit.target.blockId)}>
        {t(KIND_LABEL[edit.kind])}
      </button>
      <p className="mt-0.5 whitespace-pre-wrap break-words" data-diff>
        {diff(before, after).map(([op, text], i) =>
          op === diff.EQUAL ? (
            <span key={i}>{text}</span>
          ) : op === diff.INSERT ? (
            <ins key={i} style={{ background: 'rgb(16 185 129 / 0.25)', textDecoration: 'none' }}>
              {text}
            </ins>
          ) : (
            <del key={i} style={{ background: 'rgb(239 68 68 / 0.2)' }}>
              {text}
            </del>
          ),
        )}
      </p>
    </div>
  );
}
