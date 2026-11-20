import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VersionSummaryDTO } from '@polygonlabs/primer-api-types';
import { VersionSelector } from './VersionSelector.tsx';
import { buildMenuItems, type MenuItemId } from '../lib/documentActionsMenu.ts';
import { t } from '../i18n';
import { useCopyDocument, useDocument, useEditDocument, useProposeBranch } from '../queries/documents.ts';

export interface ActionFeedback {
  kind: 'success' | 'error';
  message: string;
  /** A place to go from the message (e.g. the checkpoint just saved). */
  link?: { label: string; to: string };
}

interface Props {
  /** 'mobile' collapses Share into the ⋯ menu; 'desktop' shows the Share
   * button. The caller gates visibility per breakpoint (md:hidden vs
   * hidden md:flex), so each instance owns its popover state and
   * outside-click handling without cross-instance ref clashes. */
  variant: 'mobile' | 'desktop';
  docId: string;
  versions: VersionSummaryDTO[];
  currentVersionNumber: number;
  isViewingLatest: boolean;
  onAddVersion?: () => void;
  isUploader: boolean;
  onShare: () => void;
  onOpenFullScreen: () => void;
  /** Resolves to feedback to surface next to the menu; null = silent success. */
  onDownloadHtml: () => Promise<ActionFeedback | null>;
  /** Called synchronously inside the menu click: it starts a clipboard
   * write, which browsers only allow during the user's gesture. */
  onSendToNotebookLm: () => void;
  onCopyComments: () => Promise<ActionFeedback>;
  onExportComments: () => void;
  onDelete: () => Promise<void>;
  /** Live documents: saves a checkpoint of the current state. */
  onSaveCheckpoint?: () => Promise<ActionFeedback>;
  /** Live documents: downloads the content in a format. */
  onExport?: (format: 'markdown' | 'html' | 'print') => void;
}

type MenuState = 'closed' | 'menu' | 'confirm';

export function HeaderActions({
  variant,
  docId,
  versions,
  currentVersionNumber,
  isViewingLatest,
  onAddVersion,
  isUploader,
  onShare,
  onOpenFullScreen,
  onDownloadHtml,
  onSendToNotebookLm,
  onCopyComments,
  onExportComments,
  onDelete,
  onSaveCheckpoint,
  onExport,
}: Props) {
  const [menuState, setMenuState] = useState<MenuState>('closed');
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const [savingCheckpoint, setSavingCheckpoint] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const navigate = useNavigate();
  const docQuery = useDocument(docId);
  const detail = docQuery.data?.document;
  const copy = useCopyDocument();
  const propose = useProposeBranch(docId);
  const editDoc = useEditDocument(docId);

  useEffect(() => {
    if (menuState !== 'menu') return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuState('closed');
      }
    }
    window.document.addEventListener('mousedown', onDown);
    return () => window.document.removeEventListener('mousedown', onDown);
  }, [menuState]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function showFeedback(
    fb: ActionFeedback,
    dismissMs: number = fb.link ? 6000 : fb.kind === 'error' ? 5000 : 3000,
  ) {
    if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    setFeedback(fb);
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, dismissMs);
  }

  const onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void> = {
    share: () => {
      setMenuState('closed');
      onShare();
    },
    'open-fullscreen': () => {
      setMenuState('closed');
      onOpenFullScreen();
    },
    'download-html': () => {
      setMenuState('closed');
      void onDownloadHtml()
        .then((fb) => {
          if (fb) showFeedback(fb);
        })
        .catch(() =>
          showFeedback({ kind: 'error', message: t('headerActions.downloadFailed') }),
        );
    },
    notebooklm: () => {
      setMenuState('closed');
      onSendToNotebookLm();
    },
    copy: () => {
      setMenuState('closed');
      void onCopyComments()
        .then((fb) => showFeedback(fb))
        .catch(() =>
          showFeedback({ kind: 'error', message: t('headerActions.copyFailed') }),
        );
    },
    download: () => {
      setMenuState('closed');
      onExportComments();
    },
    'export-markdown': () => {
      setMenuState('closed');
      onExport?.('markdown');
    },
    'export-html': () => {
      setMenuState('closed');
      onExport?.('html');
    },
    'export-print': () => {
      setMenuState('closed');
      onExport?.('print');
    },
    branch: () => copyAs('branch'),
    fork: () => copyAs('fork'),
    propose: () => {
      setMenuState('closed');
      propose.mutate(undefined, {
        onSuccess: (out) => navigate(`/d/${out.documentId}`),
        onError: (err) => showFeedback({ kind: 'error', message: t('headerActions.proposeFailed', { reason: err.message }) }, 5000),
      });
    },
    template: () => {
      setMenuState('closed');
      editDoc.mutate({ isTemplate: !detail?.isTemplate });
    },
    delete: () => setMenuState('confirm'),
  };

  function copyAs(kind: 'branch' | 'fork') {
    setMenuState('closed');
    copy.mutate(
      { docId, kind },
      {
        onSuccess: (id) => navigate(`/d/${id}`),
        onError: () => showFeedback({ kind: 'error', message: t('headerActions.copyDocumentFailed') }),
      },
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {versions.length > 0 && (
        <VersionSelector
          docId={docId}
          versions={versions}
          currentVersionNumber={currentVersionNumber}
          isViewingLatest={isViewingLatest}
          onAddVersion={onAddVersion}
        />
      )}
      {variant === 'desktop' && onSaveCheckpoint && (
        <button
          type="button"
          disabled={savingCheckpoint}
          aria-busy={savingCheckpoint}
          onClick={() => {
            setSavingCheckpoint(true);
            void onSaveCheckpoint()
              .then(showFeedback, () => showFeedback({ kind: 'error', message: t('headerActions.saveCheckpointFailed') }))
              .finally(() => mountedRef.current && setSavingCheckpoint(false));
          }}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-wait disabled:opacity-70 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {savingCheckpoint && (
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
          )}
          {savingCheckpoint ? t('headerActions.savingCheckpoint') : t('headerActions.saveCheckpoint')}
        </button>
      )}
      {variant === 'desktop' && isUploader && (
        <button
          type="button"
          onClick={onShare}
          className="inline-flex h-7 items-center rounded border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('headerActions.share')}
        </button>
      )}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuState((s) => (s === 'closed' ? 'menu' : 'closed'))}
          aria-label={t('headerActions.moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuState === 'menu'}
          className="inline-flex h-7 items-center justify-center rounded border border-neutral-300 bg-white px-2 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        {menuState === 'menu' && (
          <div
            role="menu"
            className="absolute right-0 z-10 mt-1 w-56 overflow-hidden rounded border border-neutral-200 bg-white py-1 shadow-md dark:border-neutral-800 dark:bg-neutral-900"
          >
            {buildMenuItems({
              isUploader,
              includeShare: variant === 'mobile',
              live: onExport !== undefined,
              isBranch: Boolean(detail?.branchOf),
              isTemplate: Boolean(detail?.isTemplate),
              isOwner: docQuery.data?.myRole === 'owner',
            }).map(
              (item, index) => {
                if (item.id === 'separator') {
                  return (
                    <div
                      key={`sep-${index}`}
                      className="my-1 border-t border-neutral-200 dark:border-neutral-800"
                      aria-hidden="true"
                    />
                  );
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    onClick={onClickFor[item.id]}
                    className={`block w-full px-3 py-1.5 text-left text-xs ${
                      item.destructive
                        ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
                        : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              },
            )}
          </div>
        )}
        {menuState === 'confirm' && (
          <div className="absolute right-0 z-10 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 shadow-md dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              {t('headerActions.deleteConfirm')}
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMenuState('closed')}
                className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
              >
                {t('headerActions.cancel')}
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await onDelete();
                    if (mountedRef.current) setMenuState('closed');
                  } catch {
                    if (mountedRef.current) {
                      showFeedback({ kind: 'error', message: t('headerActions.deleteFailed') });
                    }
                  }
                }}
                className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
              >
                {t('headerActions.delete')}
              </button>
            </div>
          </div>
        )}
        {feedback && (
          <div
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            aria-live="polite"
            className={`fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border px-3 py-2 text-sm shadow-lg ${
              feedback.kind === 'success'
                ? 'border-neutral-200 bg-white text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'
                : 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
            }`}
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${feedback.kind === 'success' ? 'bg-emerald-500' : 'bg-red-500'}`}
              aria-hidden="true"
            />
            <span className="min-w-0">{feedback.message}</span>
            {feedback.link && (
              <button
                type="button"
                onClick={() => {
                  setFeedback(null);
                  navigate(feedback.link!.to);
                }}
                className="shrink-0 font-medium text-violet-700 hover:underline dark:text-violet-300"
              >
                {feedback.link.label}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
