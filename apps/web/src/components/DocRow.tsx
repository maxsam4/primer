import { t } from '../i18n/index.ts';
import { Link } from 'react-router-dom';
import type { LibraryDocument, FolderDTO } from '@polygonlabs/primer-api-types';
import { PrivateLockIcon } from './PrivateLockIcon.tsx';
import { DocKebabMenu } from './DocKebabMenu.tsx';
import { DocFolderChip } from './DocFolderChip.tsx';
import { UseTemplateButton } from './UseTemplateButton.tsx';
import { useMe } from '../queries/me.ts';
import { relativeTime } from '../lib/relativeTime.ts';

export interface DocRowProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
  selectedFolderId: string | null;
}

export function DocRow({ doc, folders, selectedFolderId }: DocRowProps) {
  // `mine` includes what the caller's agents uploaded; those keep their byline.
  const { data: me } = useMe();
  const subtitle =
    doc.ownership === 'mine' && doc.uploaderId === me?.id
      ? doc.description ?? ''
      : doc.description
        ? t('docRow.byAuthorWithDescription', { name: doc.uploaderDisplayName, description: doc.description })
        : t('docRow.byAuthor', { name: doc.uploaderDisplayName });

  const assignedFolder =
    doc.folderId !== null && doc.folderId !== selectedFolderId
      ? folders.find((f) => f.id === doc.folderId)
      : undefined;

  return (
    <div className="group flex items-center justify-between border-b border-neutral-100 px-1 py-2.5 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800">
      <Link to={`/d/${doc.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100 min-w-0">
            {doc.visibility === 'private' && (
              <PrivateLockIcon className="h-3.5 w-3.5 shrink-0 text-purple-600 dark:text-purple-400" />
            )}
            <span className="truncate">{doc.title}</span>
          </span>
          <span className="text-xs text-neutral-500 truncate">
            {subtitle || <em className="text-neutral-400 dark:text-neutral-500">{t('docRow.noDescription')}</em>}
          </span>
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-3">
        <UseTemplateButton doc={doc} />
        <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs text-neutral-600 dark:text-neutral-400">
          {doc.threadCount === 0
            ? t('docRow.noThreadsYet')
            : t('docRow.activeThreads', { active: doc.activeThreadCount, total: doc.threadCount })}
        </span>
        <span className="hidden sm:inline w-20 text-right text-xs text-neutral-500">
          {relativeTime(doc.lastActivityAt)}
        </span>
        {assignedFolder ? (
          <DocFolderChip doc={doc} folderName={assignedFolder.name} folders={folders} />
        ) : (
          <DocKebabMenu doc={doc} folders={folders} />
        )}
      </div>
    </div>
  );
}
