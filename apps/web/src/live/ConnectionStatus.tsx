import { t } from '../i18n/index.ts';
import { useEffect, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { CLOSE_FORBIDDEN, CLOSE_SAVE_FAILED } from './provider.ts';
import { connectionView, OFFLINE_AFTER_MS, UNSAVED_AFTER_MS } from './connectionState.ts';

type Status = 'connecting' | 'connected' | 'disconnected';

/**
 * Whether edits reach the server, always shown in the editor header: "Live",
 * "Reconnecting…" while the socket is down, "Offline" once it has been down
 * for ten seconds, "Unsaved changes" when the server hasn't acknowledged
 * changes for more than five seconds, and "Changes not saved" with Retry
 * when the server closed the connection because it couldn't store an update.
 */
export function ConnectionStatus({ provider }: { provider: HocuspocusProvider }) {
  // The socket may already be up when this mounts: start from where it is.
  const [status, setStatus] = useState<Status>(
    () => (provider.configuration?.websocketProvider?.status as Status | undefined) ?? 'connecting',
  );
  const [downSince, setDownSince] = useState<number | null>(null);
  const [lastCloseCode, setLastCloseCode] = useState<number | null>(null);
  const [unsyncedSince, setUnsyncedSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onStatus = ({ status: next }: { status: Status }) => {
      setStatus(next);
      setDownSince((since) => (next === 'connected' ? null : (since ?? Date.now())));
    };
    const onClose = ({ event }: { event: { code: number } }) => {
      if (event.code === CLOSE_SAVE_FAILED || event.code === CLOSE_FORBIDDEN) setLastCloseCode(event.code);
    };
    const onUnsynced = ({ number }: { number: number }) =>
      setUnsyncedSince((since) => (number > 0 ? (since ?? Date.now()) : null));
    provider.on('status', onStatus);
    provider.on('close', onClose);
    provider.on('unsyncedChanges', onUnsynced);
    return () => {
      provider.off('status', onStatus);
      provider.off('close', onClose);
      provider.off('unsyncedChanges', onUnsynced);
    };
  }, [provider]);

  // Re-evaluate once a threshold passes.
  useEffect(() => {
    if (unsyncedSince === null) return;
    const timer = setTimeout(() => setNow(Date.now()), UNSAVED_AFTER_MS + 50);
    return () => clearTimeout(timer);
  }, [unsyncedSince]);
  useEffect(() => {
    if (downSince === null) return;
    const timer = setTimeout(() => setNow(Date.now()), OFFLINE_AFTER_MS + 50);
    return () => clearTimeout(timer);
  }, [downSince]);

  const view = connectionView({ status, lastCloseCode, unsyncedSince, downSince, now: Math.max(now, Date.now()) });
  const tone =
    view.kind === 'ok'
      ? 'text-neutral-500 dark:text-neutral-400'
      : view.kind === 'reconnecting' || view.kind === 'unsaved'
        ? 'text-amber-700 dark:text-amber-300'
        : 'text-red-700 dark:text-red-400';
  const dot =
    view.kind === 'ok' ? 'bg-emerald-500' : view.kind === 'reconnecting' || view.kind === 'unsaved' ? 'animate-pulse bg-amber-500' : 'bg-red-500';
  return (
    <div role="status" data-connection={view.kind} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium ${tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {view.kind === 'ok' && <span>{t('connectionStatus.live')}</span>}
      {view.kind === 'reconnecting' && <span>{t('connectionStatus.reconnecting')}</span>}
      {view.kind === 'offline' && <span>{t('connectionStatus.offline')}</span>}
      {view.kind === 'unsaved' && <span>{t('connectionStatus.unsaved')}</span>}
      {view.kind === 'forbidden' && <span className="whitespace-normal">{t('connectionStatus.forbidden')}</span>}
      {view.kind === 'save-failed' && (
        <>
          <span>{t('connectionStatus.notSaved')}</span>
          <button
            type="button"
            className="rounded border border-current px-1.5 py-0.5"
            onClick={() => {
              setLastCloseCode(null);
              setDownSince(Date.now());
              void provider.connect();
            }}
          >
            {t('connectionStatus.retry')}
          </button>
        </>
      )}
    </div>
  );
}
