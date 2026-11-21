import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LibraryDocument, Reconciliation } from '@polygonlabs/primer-api-types';
import { useLibraryQuery } from '../queries/library.ts';
import { useAddVersion } from '../queries/versions.ts';
import { FileDropZone } from './FileDropZone.tsx';
import { t } from '../i18n';

interface Props {
  open: boolean;
  /** If provided, the doc combobox is pre-filled and the user can swap via the change-doc link. */
  preselectedDocId?: string;
  /** Title to show while the library query hasn't (yet) confirmed the preselected doc. */
  preselectedDocTitle?: string;
  onClose: () => void;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return t('addVersionModal.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('addVersionModal.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('addVersionModal.hoursAgo', { count: hr });
  return t('addVersionModal.daysAgo', { count: Math.floor(hr / 24) });
}

export function AddVersionModal({ open, preselectedDocId, preselectedDocTitle, onClose }: Props) {
  const navigate = useNavigate();
  const library = useLibraryQuery();
  const myDocs = (library.data?.documents ?? []).filter((d) => d.ownership === 'mine');

  const [selectedDocId, setSelectedDocId] = useState<string | undefined>(preselectedDocId);
  const [file, setFile] = useState<File | null>(null);
  const [versionNote, setVersionNote] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<Reconciliation | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerSelector = useRef<HTMLElement | null>(null);

  const addVersion = useAddVersion(selectedDocId ?? '');

  // Reset state when the modal opens or the preselected doc changes.
  useEffect(() => {
    if (open) {
      triggerSelector.current = document.activeElement as HTMLElement | null;
      setSelectedDocId(preselectedDocId);
      setFile(null);
      setVersionNote('');
      setQuery('');
      setError(null);
      setSuggested(null);
    } else {
      triggerSelector.current?.focus();
    }
  }, [open, preselectedDocId]);

  // ESC + focus trap (light version).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filteredDocs = useMemo(() => {
    if (!query) return myDocs.slice(0, 8);
    const lower = query.toLowerCase();
    return myDocs.filter((d) => d.title.toLowerCase().includes(lower)).slice(0, 8);
  }, [myDocs, query]);

  const selectedDoc: LibraryDocument | undefined = useMemo(
    () => myDocs.find((d) => d.id === selectedDocId),
    [myDocs, selectedDocId]
  );

  if (!open) return null;

  const openDocument = () => {
    onClose();
    navigate(`/d/${selectedDocId}`);
  };

  const canSubmit = !!selectedDocId && !!file && !addVersion.isPending;

  async function submit() {
    if (!selectedDocId || !file) return;
    setError(null);
    try {
      const trimmed = versionNote.trim();
      const out = await addVersion.mutateAsync({ file, versionNote: trimmed.length === 0 ? null : trimmed });
      // A republish that only suggests (an agent in suggest mode) makes no
      // version: say what it did instead of opening a version that isn't there.
      if (out.versionId === undefined) {
        setSuggested(out.reconciliation);
        return;
      }
      onClose();
      navigate(`/d/${selectedDocId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-version-title"
        className="w-full max-w-[520px] rounded-lg bg-white dark:bg-neutral-900 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-neutral-200 dark:border-neutral-800 px-4 py-3">
          <h2 id="add-version-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t('addVersionModal.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('addVersionModal.close')}
            className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300">{t('addVersionModal.document')}</label>
            {preselectedDocId && selectedDocId === preselectedDocId ? (
              <div className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-3 py-2 text-sm">
                <div className="font-medium text-neutral-800 dark:text-neutral-200">
                  {selectedDoc?.title ?? preselectedDocTitle ?? t('addVersionModal.loading')}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedDocId(undefined)}
                  className="mt-1 text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
                >
                  {t('addVersionModal.changeDocument')}
                </button>
              </div>
            ) : (
              <div>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('addVersionModal.searchPlaceholder')}
                  className="block w-full rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm"
                />
                {filteredDocs.length > 0 && (
                  <ul className="mt-1 max-h-44 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-800">
                    {filteredDocs.map((d) => (
                      <li
                        key={d.id}
                        onClick={() => {
                          setSelectedDocId(d.id);
                          setQuery(d.title);
                        }}
                        className={`cursor-pointer px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 ${
                          d.id === selectedDocId ? 'bg-yellow-50 dark:bg-amber-900/20' : ''
                        }`}
                      >
                        <div className="font-medium text-neutral-800 dark:text-neutral-200">{d.title}</div>
                        <div className="text-xs text-neutral-500">
                          {t('addVersionModal.threadStats', { active: d.activeThreadCount, total: d.threadCount, time: relativeTime(d.lastActivityAt) })}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {selectedDoc && (
              <div className="mt-1 text-xs text-neutral-500">
                {t('addVersionModal.lastUpdated', { time: relativeTime(selectedDoc.lastActivityAt) })}
              </div>
            )}
          </div>

          <FileDropZone file={file} onChange={setFile} />

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300">
              {t('addVersionModal.versionNote')}
            </span>
            <input
              type="text"
              value={versionNote}
              onChange={(e) => setVersionNote(e.target.value)}
              maxLength={500}
              placeholder={t('addVersionModal.versionNotePlaceholder')}
              className="block w-full rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm"
            />
          </label>

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {suggested && (
            <div role="status" data-republish-suggested="" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-medium">{t('addVersionModal.suggestedTitle')}</p>
              <p className="mt-1">
                {t('addVersionModal.suggestedBody', {
                  suggested: suggested.outcomes.filter((o) => o.status === 'suggested').length,
                  conflicts: suggested.outcomes.filter((o) => o.status === 'conflict').length,
                  unchanged: suggested.outcomes.filter((o) => o.status === 'unchanged').length,
                })}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-200 dark:border-neutral-800 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-4 py-1.5 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            {t('addVersionModal.cancel')}
          </button>
          {suggested ? (
            <button
              type="button"
              onClick={openDocument}
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              {t('addVersionModal.openSuggestions')}
            </button>
          ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {addVersion.isPending ? t('addVersionModal.adding') : t('addVersionModal.submit')}
          </button>
          )}
        </div>
      </div>
    </div>
  );
}
