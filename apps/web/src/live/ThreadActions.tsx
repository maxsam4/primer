import { useEffect, useState } from 'react';
import type { ThreadData } from '@blocknote/core/comments';
import { api } from '../lib/fetch.ts';
import { t } from '../i18n/index.ts';
import type { PrimerThreadStore } from './PrimerThreadStore.ts';

type Meta = { orphaned?: boolean; quote?: string };

/**
 * Below BlockNote's thread list: what Primer adds to threads. An orphaned
 * thread ("Text removed") can be re-anchored, which matches its quote
 * exactly or reworded on the server (never automatically); any thread can be
 * promoted into a new document, one quote block per comment.
 */
export function ThreadActions({ store, canPromote, canReanchor }: { store: PrimerThreadStore; canPromote: boolean; canReanchor: boolean }) {
  const [threads, setThreads] = useState<ThreadData[]>(() => [...store.getThreads().values()]);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => store.subscribe((all) => setThreads([...all.values()])), [store]);

  const open = threads.filter((th) => !th.resolved);
  const orphaned = canReanchor ? open.filter((th) => (th.metadata as Meta).orphaned) : [];
  if (open.length === 0) return null;

  const reanchor = async (id: string) => {
    setMessage(null);
    const res = await api(`/api/threads/${encodeURIComponent(id)}/reanchor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { refusal?: { message: string } } | null;
      setMessage(body?.refusal?.message ?? t('request.failed', { status: res.status }));
    }
    await store.refresh();
  };

  const promote = async (id: string) => {
    setMessage(null);
    const res = await api(`/api/threads/${encodeURIComponent(id)}/promote`, { method: 'POST' });
    if (!res.ok) {
      setMessage(t('request.failed', { status: res.status }));
      return;
    }
    const body = (await res.json()) as { documentId: string };
    window.location.assign(`/d/${encodeURIComponent(body.documentId)}`);
  };

  return (
    <div className="mt-3 border-t border-neutral-200 pt-2 text-xs dark:border-neutral-800" data-thread-actions>
      {message && <p className="mb-2 rounded bg-amber-50 p-2 text-amber-800 dark:bg-amber-950 dark:text-amber-200">{message}</p>}
      {orphaned.length > 0 && (
        <section className="mb-2">
          <h3 className="mb-1 font-medium">{t('threadActions.orphaned')}</h3>
          {orphaned.map((th) => (
            <div key={th.id} className="mb-1 flex items-center justify-between gap-2" data-orphaned-thread={th.id}>
              <span className="truncate text-neutral-500">“{(th.metadata as Meta).quote}”</span>
              <button type="button" onClick={() => void reanchor(th.id)} className="h-6 shrink-0 rounded border border-neutral-300 px-2 dark:border-neutral-700">
                {t('threadActions.reanchor')}
              </button>
            </div>
          ))}
        </section>
      )}
      {canPromote && (
        <section>
          <h3 className="mb-1 font-medium">{t('threadActions.promoteHeading')}</h3>
          {open.map((th) => (
            <div key={th.id} className="mb-1 flex items-center justify-between gap-2">
              <span className="truncate text-neutral-500">“{(th.metadata as Meta).quote}”</span>
              <button type="button" onClick={() => void promote(th.id)} className="h-6 shrink-0 rounded border border-neutral-300 px-2 dark:border-neutral-700">
                {t('threadActions.promote')}
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
