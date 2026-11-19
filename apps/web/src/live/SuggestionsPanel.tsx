import { useCallback, useEffect, useState } from 'react';
import diff from 'fast-diff';
import type { SuggestedEditDTO, SuggestionDTO, SuggestionsResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { useThreadEvents } from './threadEvents.ts';

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

  const refresh = useCallback(async () => {
    const res = await api(`/api/documents/${encodeURIComponent(documentId)}/suggestions`).catch(() => null);
    if (!res?.ok) return;
    const body = (await res.json()) as SuggestionsResponse;
    const open = body.suggestions.filter((s) => s.status === 'open' && s.edits.some((e) => e.target.tabId === tabId));
    setSuggestions(open);
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
      setError(body?.refusal ? `${body.refusal.message} ${body.refusal.fix}` : `Could not ${decision} (${res.status}).`);
    }
    await refresh();
  };

  if (suggestions.length === 0) return <p className="p-2 text-xs text-neutral-500">No open suggestions.</p>;
  return (
    <div className="flex flex-col gap-2" data-suggestions-panel>
      {error && <p className="rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {suggestions.map((s) => (
        <article key={s.id} className="rounded border border-neutral-200 p-2 text-xs dark:border-neutral-700" data-suggestion-id={s.id}>
          <header className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium">{s.authorDisplayName}</span>
            {s.stale && <span className="text-amber-600">Changed since</span>}
          </header>
          {s.edits.map((edit, i) => (
            <EditDiff key={i} edit={edit} onShow={props.onShow} />
          ))}
          {props.canDecide && (
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => void decide(s.id, 'reject')} className="h-6 rounded border border-neutral-300 px-2 dark:border-neutral-700">
                Reject
              </button>
              <button type="button" onClick={() => void decide(s.id, 'accept')} className="h-6 rounded bg-emerald-600 px-2 text-white hover:bg-emerald-700">
                Accept
              </button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

const KIND_LABEL: Record<SuggestedEditDTO['kind'], string> = {
  replace: 'Change',
  insert: 'Add',
  delete: 'Delete',
  move: 'Move',
};

/** One block's change: the current text against the proposed text. */
function EditDiff({ edit, onShow }: { edit: SuggestedEditDTO; onShow?: (blockId: string) => void }) {
  const before = edit.current?.markdown ?? '';
  const after = edit.kind === 'delete' ? '' : edit.kind === 'move' ? before : (edit.proposed?.markdown ?? '');
  return (
    <div className="mt-1">
      <button type="button" className="text-neutral-500 hover:underline" onClick={() => onShow?.(edit.target.blockId)}>
        {KIND_LABEL[edit.kind]}
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
