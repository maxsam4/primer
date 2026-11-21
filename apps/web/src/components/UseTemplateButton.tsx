import { useNavigate } from 'react-router-dom';
import type { LibraryDocument } from '@polygonlabs/primer-api-types';
import { useState } from 'react';
import { t } from '../i18n/index.ts';
import { useCopyDocument } from '../queries/documents.ts';

/** "Use template": a new document of the viewer's, forked from a template. */
export function UseTemplateButton({ doc }: { doc: LibraryDocument }) {
  const navigate = useNavigate();
  const copy = useCopyDocument();
  const [failed, setFailed] = useState(false);
  if (!doc.isTemplate) return null;
  return (
    <>
      <button
        type="button"
        disabled={copy.isPending}
        onClick={(e) => {
          e.preventDefault();
          setFailed(false);
          copy.mutate({ docId: doc.id, kind: 'fork' }, { onSuccess: (id) => navigate(`/d/${id}`), onError: () => setFailed(true) });
        }}
        className="h-6 shrink-0 rounded border border-neutral-300 px-2 text-xs text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {t('library.useTemplate')}
      </button>
      {failed && (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {t('headerActions.copyDocumentFailed')}
        </span>
      )}
    </>
  );
}
