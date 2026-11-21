import { t } from '../i18n';
export type MenuItemId =
  | 'share'
  | 'open-fullscreen'
  | 'download-html'
  | 'export-markdown'
  | 'export-html'
  | 'export-print'
  | 'branch'
  | 'fork'
  | 'propose'
  | 'template'
  | 'notebooklm'
  | 'copy'
  | 'download'
  | 'separator'
  | 'delete';

export interface MenuItem {
  id: MenuItemId;
  label?: string;
  destructive?: boolean;
}

export interface MenuInput {
  isUploader: boolean;
  /** Mobile collapses the Share button into the menu. */
  includeShare?: boolean;
  /** Live documents export their content (Markdown or text, and HTML), and
   *  can be branched and forked. */
  live?: boolean;
  /** A branch: it can be proposed back to its parent. */
  isBranch?: boolean;
  /** Listed under Templates: forking it is "New from template". */
  isTemplate?: boolean;
  /** The viewer owns it (marks it as a template). */
  isOwner?: boolean;
  /** A page document exports as HTML only (it has no Markdown). */
  page?: boolean;
}

/** Pure function: given who's viewing, return the ordered menu items. The
 *  caller maps each item to a click handler. */
export function buildMenuItems({
  isUploader,
  includeShare = false,
  live = false,
  isBranch = false,
  isTemplate = false,
  isOwner = false,
  page = false,
}: MenuInput): MenuItem[] {
  const items: MenuItem[] = [];
  if (includeShare && isUploader) {
    items.push({ id: 'share', label: t('libDocumentActionsMenu.share') });
    items.push({ id: 'separator' });
  }
  if (live) {
    items.push(
      ...(page ? [] : [{ id: 'export-markdown' as const, label: t('libDocumentActionsMenu.exportMarkdown') }]),
      { id: 'export-html', label: t('libDocumentActionsMenu.exportHtml') },
      { id: 'export-print', label: t('libDocumentActionsMenu.printPdf') },
      { id: 'separator' },
    );
    if (isBranch) items.push({ id: 'propose', label: t('libDocumentActionsMenu.proposeBranch') });
    items.push(
      { id: 'branch', label: t('libDocumentActionsMenu.branch') },
      { id: 'fork', label: t(isTemplate ? 'libDocumentActionsMenu.newFromTemplate' : 'libDocumentActionsMenu.fork') },
    );
    if (isOwner) {
      items.push({ id: 'template', label: t(isTemplate ? 'libDocumentActionsMenu.unmarkTemplate' : 'libDocumentActionsMenu.markTemplate') });
    }
    items.push({ id: 'separator' });
  }
  items.push(
    { id: 'open-fullscreen', label: t('libDocumentActionsMenu.openFullScreen') },
    { id: 'download-html', label: t('libDocumentActionsMenu.downloadHtml') },
    { id: 'notebooklm', label: t('libDocumentActionsMenu.sendToNotebookLm') },
    { id: 'separator' },
    { id: 'copy', label: t('libDocumentActionsMenu.copyCommentsAsMarkdown') },
    { id: 'download', label: t('libDocumentActionsMenu.downloadCommentsAsMarkdown') },
  );
  if (isUploader) {
    items.push({ id: 'separator' });
    items.push({ id: 'delete', label: t('libDocumentActionsMenu.deleteDocument'), destructive: true });
  }
  return items;
}
