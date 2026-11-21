import { t } from '../i18n/index.ts';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { addTab, deleteTab, MAIN_TAB, readTabs, renameTab, type Tab } from './tabs.ts';

/** The document's tabs, kept current as anyone changes them. */
export function useTabs(doc: Y.Doc): Tab[] {
  const [tabs, setTabs] = useState(() => readTabs(doc));
  useEffect(() => {
    const array = doc.getArray('tabs');
    const update = () => setTabs(readTabs(doc));
    update();
    array.observe(update);
    return () => array.unobserve(update);
  }, [doc]);
  return tabs;
}

/**
 * The tab strip of a live document. Editors add, rename (double-click, or F2 on a focused tab) and
 * delete tabs; the first tab is the document itself and can't be deleted.
 * Shown once there is more than one tab, or to editors who can add one.
 */
export function TabStrip(props: { doc: Y.Doc; tabs: Tab[]; active: string; onSelect: (id: string) => void; readOnly: boolean }) {
  const { doc, tabs, active, onSelect, readOnly } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  if (readOnly && tabs.length < 2) return null;
  const label = (tab: Tab) => tab.title || (tab.id === MAIN_TAB ? t('tabStrip.main') : t('tabStrip.untitled'));

  return (
    <div role="tablist" aria-label={t('tabStrip.documentTabs')} className="flex items-center gap-1 overflow-x-auto border-b border-neutral-200 px-3 dark:border-neutral-800">
      {tabs.map((tab) =>
        renaming === tab.id ? (
          <input
            key={tab.id}
            autoFocus
            aria-label={t('tabStrip.tabTitle')}
            defaultValue={tab.title}
            maxLength={200}
            className="h-7 w-40 rounded border border-neutral-300 px-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            onBlur={(e) => {
              renameTab(doc, tab.id, e.currentTarget.value.trim());
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(null);
            }}
          />
        ) : (
          <div key={tab.id} className="flex items-center">
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active}
              data-tab-id={tab.id}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={() => !readOnly && setRenaming(tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'F2' && !readOnly) {
                  e.preventDefault();
                  setRenaming(tab.id);
                }
              }}
              className={`h-8 border-b-2 px-3 text-xs ${
                tab.id === active
                  ? 'border-neutral-900 font-medium text-neutral-900 dark:border-neutral-100 dark:text-neutral-100'
                  : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200'
              }`}
            >
              {label(tab)}
            </button>
            {!readOnly && tab.id !== MAIN_TAB && tab.id === active && (
              <button
                type="button"
                aria-label={t('tabStrip.deleteTab', { label: label(tab) })}
                className="px-1 text-xs text-neutral-400 hover:text-red-600"
                onClick={() => {
                  if (!window.confirm(t('tabStrip.confirmDelete', { label: label(tab) }))) return;
                  deleteTab(doc, tab.id);
                  onSelect(MAIN_TAB);
                }}
              >
                ×
              </button>
            )}
          </div>
        ),
      )}
      {!readOnly && (
        <button
          type="button"
          aria-label={t('tabStrip.addTab')}
          className="h-8 px-2 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          onClick={() => {
            const tab = addTab(doc, '');
            onSelect(tab.id);
            setRenaming(tab.id);
          }}
        >
          +
        </button>
      )}
    </div>
  );
}
