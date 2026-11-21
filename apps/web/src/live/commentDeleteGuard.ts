import { Plugin, type Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from 'y-prosemirror';

/** Set on a transaction the person confirmed: it may delete commented text. */
export const ALLOW_COMMENTED_DELETE = 'primer:allowCommentedDelete';

export type HeldDelete = {
  /** Quotes of the open threads whose text the change removes. */
  quotes: string[];
  /** Applies the held change when the document hasn't moved on; false when it
   *  has, and nothing was applied. */
  confirm: () => boolean;
};

/**
 * Holds a local change that removes text carrying an open thread's comment
 * mark (deleting, typing over a selection, paste-replace, removing a block)
 * and hands it to `onHold`, which asks the person; "Delete anyway" applies it
 * with ALLOW_COMMENTED_DELETE. Changes arriving from other people (sync) are
 * never held.
 */
export function commentDeleteGuard(opts: {
  openThreadIds: () => Set<string>;
  quoteOf: (threadId: string) => string;
  onHold: (held: HeldDelete) => void;
  dispatch: (tr: Transaction) => void;
  currentDoc: () => import('@tiptap/pm/model').Node;
}): Plugin {
  return new Plugin({
    filterTransaction(tr) {
      if (!tr.docChanged || tr.getMeta(ALLOW_COMMENTED_DELETE) || tr.getMeta(ySyncPluginKey)) return true;
      const removed = removedThreadIds(tr, opts.openThreadIds());
      if (removed.size === 0) return true;
      opts.onHold({
        quotes: [...removed].map(opts.quoteOf),
        confirm: () => {
          // Only the change that was held, against the document it was made on.
          if (!opts.currentDoc().eq(tr.before)) return false;
          opts.dispatch(tr.setMeta(ALLOW_COMMENTED_DELETE, true));
          return true;
        },
      });
      return false;
    },
  });
}

/** Open thread ids whose marked text some step of `tr` removes. */
export function removedThreadIds(tr: Transaction, open: Set<string>): Set<string> {
  const ids = new Set<string>();
  if (open.size === 0) return ids;
  tr.steps.forEach((step, i) => {
    const before = tr.docs[i]!;
    step.getMap().forEach((oldStart, oldEnd) => {
      if (oldEnd <= oldStart) return;
      before.nodesBetween(oldStart, oldEnd, (node) => {
        for (const mark of node.marks) {
          const id = mark.attrs.threadId as string | undefined;
          if (mark.type.name === 'comment' && id && open.has(id)) ids.add(id);
        }
        return true;
      });
    });
  });
  return ids;
}
