import { useEffect, useMemo, useState } from 'react';
import type { AnchorData, ThreadDTO } from '@polygonlabs/primer-api-types';
import { useThreadsQuery } from '../queries/threads.ts';
import { ThreadCard } from './ThreadCard.tsx';
import { NewThreadComposer } from './NewThreadComposer.tsx';
import { hasAnyComments, hasLiveComments } from '../lib/liveComments.ts';
import { describeApiError, isNonLatestVersionError } from '../lib/apiError.ts';

interface PendingAnchor {
  anchor: AnchorData;
  /** How the composer was opened: 'selection' must not steal focus from the
   *  iframe's text selection; 'pick' is an explicit ask, so it may focus. */
  origin: 'selection' | 'pick';
}

interface Props {
  versionId: string;
  currentUserId: string;
  pending: PendingAnchor | null;
  onCancelPending: () => void;
  onSubmitPending: (body: string, mentions: string[]) => Promise<void>;
  onComposerDirtyChange?: (dirty: boolean) => void;
  onHighlight: (anchorId: string) => void;
  /** anchorId → top-of-rect y in iframe viewport (from anchor_positions). */
  positionsByAnchorId?: Map<string, { y: number; drifted: boolean }>;
  collapsed?: boolean;
  onCollapsedChange?: (next: boolean) => void;
  /** Sticky-focus state owned by DocumentPage. */
  focusedThreadId?: string | null;
  /** Mobile-only: when set, render a "+ Add comment" trigger above the
   *  thread list. The handler is expected to enter pick mode AND snap the
   *  sheet to handle so the iframe is fully tappable. */
  onAddCommentClick?: () => void;
  /** True while the parent is in pick mode — used to dim/disable the button. */
  addCommentActive?: boolean;
  /** Called when the composer's post failed because this version is no
   *  longer the latest (409 not_latest_version) and the user asks to switch. */
  onGoToLatest?: () => void;
}

const COLLAPSED_KEY = 'primer.sidebar.collapsed';

export function CommentSidebar({
  versionId,
  currentUserId,
  pending,
  onCancelPending,
  onSubmitPending,
  onComposerDirtyChange,
  onHighlight,
  positionsByAnchorId,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  focusedThreadId = null,
  onAddCommentClick,
  addCommentActive = false,
  onGoToLatest,
}: Props) {
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  const isControlled = controlledCollapsed !== undefined;
  const collapsed = isControlled ? controlledCollapsed! : uncontrolledCollapsed;
  const setCollapsed = (next: boolean) => {
    if (isControlled) {
      onCollapsedChange?.(next);
    } else {
      setUncontrolledCollapsed(next);
    }
  };

  const [hideResolved, setHideResolved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<unknown>(null);

  // A new pending anchor (fresh selection/pick) starts with a clean composer
  // — don't carry a stale error from a previous, unrelated attempt.
  useEffect(() => {
    setComposerError(null);
  }, [pending]);

  // localStorage write only fires in uncontrolled mode; controlled callers
  // are responsible for their own persistence.
  useEffect(() => {
    if (!isControlled && typeof window !== 'undefined') {
      window.localStorage.setItem(COLLAPSED_KEY, uncontrolledCollapsed ? '1' : '0');
    }
  }, [isControlled, uncontrolledCollapsed]);

  const query = useThreadsQuery(versionId);
  const threads = query.data?.data.threads ?? [];

  const sortedThreads = useMemo<ThreadDTO[]>(() => {
    if (!positionsByAnchorId || positionsByAnchorId.size === 0) {
      return [...threads].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    }
    return [...threads].sort((a, b) => {
      const pa = positionsByAnchorId.get(a.id);
      const pb = positionsByAnchorId.get(b.id);
      const da = a.contextChanged || (pa?.drifted ?? false);
      const db = b.contextChanged || (pb?.drifted ?? false);
      if (da && !db) return 1;
      if (!da && db) return -1;
      const ya = pa?.y ?? Number.POSITIVE_INFINITY;
      const yb = pb?.y ?? Number.POSITIVE_INFINITY;
      if (ya !== yb) return ya - yb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [threads, positionsByAnchorId]);

  // Threads whose comments were all deleted still render (as tombstones), so
  // a deletion is visible rather than silently erasing the thread. Counts,
  // though, only ever reflect live feedback.
  const visibleThreads = sortedThreads.filter(hasAnyComments);

  const visible = hideResolved
    ? visibleThreads.filter((t) => t.resolvedAt === null)
    : visibleThreads;
  const activeCount = visibleThreads.filter(
    (t) => t.resolvedAt === null && hasLiveComments(t)
  ).length;

  if (collapsed) {
    return (
      <div className="flex h-full w-9 flex-col items-center gap-2 border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 py-2">
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={() => setCollapsed(false)}
          className="flex h-6 w-6 items-center justify-center rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          ›
        </button>
        <span className="rounded-full border border-amber-300 dark:border-amber-700 bg-amber-100 dark:bg-amber-900/30 px-2 text-[9px] font-semibold text-neutral-700 dark:text-neutral-300">
          {activeCount}
        </span>
        <div className="flex w-full flex-1 flex-col items-center gap-1 pt-2">
          {visibleThreads.map((t) => (
            <button
              key={t.id}
              type="button"
              title={
                t.anchor.type === 'text-range'
                  ? t.anchor.selectorText
                  : (t.anchor.innerText && t.anchor.innerText.length > 0
                      ? t.anchor.innerText
                      : t.anchor.path)
              }
              onClick={() => {
                setCollapsed(false);
                onHighlight(t.id);
              }}
              className={`h-1.5 w-[18px] rounded-sm ${
                t.resolvedAt !== null ? 'bg-neutral-300' : 'bg-yellow-300'
              }`}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[300px] flex-col border-l border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
        <span className="font-semibold text-neutral-900 dark:text-neutral-100">
          {visibleThreads.length} thread{visibleThreads.length === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer select-none items-center gap-1">
            <input
              type="checkbox"
              checked={hideResolved}
              onChange={(e) => setHideResolved(e.target.checked)}
              className="h-3 w-3"
            />
            Hide resolved
          </label>
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={() => setCollapsed(true)}
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ›
          </button>
        </div>
      </header>

      {onAddCommentClick && !pending && (
        <div className="border-b border-neutral-200 dark:border-neutral-800 px-3 py-2">
          <button
            type="button"
            onClick={onAddCommentClick}
            className={`w-full rounded px-3 py-2 text-sm ${
              addCommentActive
                ? 'bg-red-600 text-white'
                : 'border border-neutral-300 bg-white text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300'
            }`}
          >
            {addCommentActive ? 'Cancel' : '+ Add comment'}
          </button>
        </div>
      )}

      {pending && (
        <NewThreadComposer
          anchor={pending.anchor}
          autoFocus={pending.origin === 'pick'}
          submitting={submitting}
          onCancel={onCancelPending}
          onDirtyChange={onComposerDirtyChange}
          error={composerError === null ? null : describeApiError(composerError)}
          errorIsNonLatestVersion={isNonLatestVersionError(composerError)}
          onGoToLatest={onGoToLatest}
          onSubmit={async (body, mentions) => {
            setSubmitting(true);
            setComposerError(null);
            try {
              await onSubmitPending(body, mentions);
            } catch (err) {
              setComposerError(err);
            } finally {
              setSubmitting(false);
            }
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {visible.map((t) => {
          const pos = positionsByAnchorId?.get(t.id);
          return (
            <ThreadCard
              key={t.id}
              versionId={versionId}
              thread={t}
              drifted={t.contextChanged || (pos?.drifted ?? false)}
              currentUserId={currentUserId}
              onHighlight={onHighlight}
              isFocused={focusedThreadId === t.id}
            />
          );
        })}
        {visible.length === 0 && (
          <div className="px-3 py-4 text-xs text-neutral-500">
            {visibleThreads.length === 0 ? 'No comments yet.' : 'No active threads (all resolved).'}
          </div>
        )}
      </div>
    </aside>
  );
}
