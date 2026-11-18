import { useState } from 'react';
import type { CommentDTO, ThreadDTO } from '@polygonlabs/primer-api-types';
import {
  useReply,
  useResolveThread,
  useReopenThread,
  useEditComment,
  useDeleteComment,
  useRestoreComment,
} from '../queries/mutations.ts';
import { MentionTextarea } from './MentionTextarea.tsx';
import { renderMentions } from './renderMentions.tsx';
import { useMentionableUsers } from '../queries/users.ts';
import { commentRowModels } from '../lib/commentRows.ts';
import { useBottomSheet } from './BottomSheet.tsx';
import { describeApiError } from '../lib/apiError.ts';
import { useReportDraft } from '../lib/drafts.ts';

interface Props {
  versionId: string;
  thread: ThreadDTO;
  drifted: boolean;
  currentUserId: string;
  onHighlight: (anchorId: string) => void;
  /** True when this thread owns the sticky focus (its anchor is highlighted
   *  in the iframe). Affects card styling only — focus changes are pushed
   *  to the companion via the parent's onHighlight. */
  isFocused?: boolean;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

function anchorPreview(t: ThreadDTO): string {
  if (t.anchor.type === 'text-range') {
    const text = t.anchor.selectorText;
    return `"${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`;
  }
  // element-path: prefer the captured innerText; fall back to the CSS path
  // for legacy rows that pre-date innerText capture.
  const inner = t.anchor.innerText;
  if (inner && inner.length > 0) {
    return `"${inner.slice(0, 60)}${inner.length > 60 ? '…' : ''}"`;
  }
  return t.anchor.path;
}

// Inline icons (Lucide-style outline marks). Stroke uses currentColor.
function PencilIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
function TrashIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
function ReplyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}
function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function ReopenIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  );
}

const iconButtonBase =
  'inline-flex h-5 w-5 items-center justify-center rounded text-neutral-400 dark:text-neutral-500 disabled:opacity-40';

const iconButtonClass =
  `${iconButtonBase} hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-700 dark:hover:text-neutral-300`;

/** Destructive sibling of iconButtonClass: set apart from the edit pencil by
 *  `ml-2` and reddened on hover, so it no longer reads as the same control. */
const dangerIconButtonClass =
  `${iconButtonBase} ml-2 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400`;

const footerButtonClass =
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50';

/**
 * Placeholder left in place of a deleted comment.
 *
 * Deletions used to be filtered out of the sidebar entirely, so a comment
 * could vanish without a trace and the document owner would never know
 * feedback had been left. The row stays, and its author gets an Undo for as
 * long as the server will honour one.
 */
function DeletedCommentRow({
  comment,
  isReply,
  canUndo,
  versionId,
}: {
  comment: CommentDTO;
  isReply: boolean;
  canUndo: boolean;
  versionId: string;
}) {
  const restore = useRestoreComment(versionId, comment.id);

  return (
    <div className={isReply ? 'mt-1.5 ml-3 border-t border-dashed border-neutral-200 dark:border-neutral-800 pt-1.5' : ''}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-500">
        <span className="truncate font-semibold text-neutral-500 dark:text-neutral-500">
          {comment.authorDisplayName}
        </span>
        <span className="shrink-0 whitespace-nowrap">{relativeTime(comment.createdAt)}</span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 leading-snug">
        <span className="italic text-neutral-400 dark:text-neutral-500">Comment deleted</span>
        {canUndo && (
          <button
            type="button"
            onClick={() => restore.mutate()}
            disabled={restore.isPending}
            className="rounded px-1 py-0.5 text-[11px] font-medium text-blue-600 underline decoration-dotted hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
          >
            Undo
          </button>
        )}
        {restore.isError && (
          <span className="text-[11px] text-red-600 dark:text-red-400">Could not restore</span>
        )}
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  isReply,
  isAuthor,
  versionId,
  onStartEditing,
}: {
  comment: CommentDTO;
  isReply: boolean;
  isAuthor: boolean;
  versionId: string;
  /** Fires when this comment enters edit mode — used to focus the parent
   *  thread's anchor in the iframe. */
  onStartEditing?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [editMentions, setEditMentions] = useState<string[]>(comment.mentions);
  const edit = useEditComment(versionId, comment.id);
  const del = useDeleteComment(versionId, comment.id);
  const usersQ = useMentionableUsers();
  const canShowAuthorActions = !editing && !confirmingDelete && isAuthor;
  useReportDraft(editing && draft.trim() !== comment.body.trim());

  function startEditing() {
    setEditing(true);
    onStartEditing?.();
  }

  return (
    <div className={isReply ? 'mt-1.5 ml-3 border-t border-dashed border-neutral-200 dark:border-neutral-800 pt-1.5' : ''}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-500">
        <span className="truncate font-semibold text-neutral-800 dark:text-neutral-200">{comment.authorDisplayName}</span>
        <div className="flex shrink-0 items-center gap-1">
          {canShowAuthorActions && (
            <>
              <button
                type="button"
                onClick={startEditing}
                aria-label="Edit comment"
                className={iconButtonClass}
              >
                <PencilIcon />
              </button>
              {/* Kept clear of the pencil on purpose: these were 4px apart and
                  identically styled, and reviewers reaching for Edit were
                  destroying their own comments instead. */}
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                aria-label="Delete comment"
                className={dangerIconButtonClass}
              >
                <TrashIcon />
              </button>
            </>
          )}
          <span className="whitespace-nowrap">
            {relativeTime(comment.createdAt)}
            {comment.updatedAt && (
              <span className="ml-1 italic text-neutral-400 dark:text-neutral-500">(edited)</span>
            )}
          </span>
        </div>
      </div>
      {confirmingDelete && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 dark:border-red-900 dark:bg-red-950/40">
          <span className="text-[11px] text-red-800 dark:text-red-300">Delete this comment?</span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={del.isPending}
              onClick={() => del.mutate(undefined, { onSuccess: () => setConfirmingDelete(false) })}
              className="rounded bg-red-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>
      )}
      {editing ? (
        <div className="mt-1">
          <MentionTextarea
            value={draft}
            onChange={setDraft}
            onMentionsChange={setEditMentions}
            rows={2}
            autoFocus
            initialSelectedIds={comment.mentions}
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(comment.body);
                setEditMentions(comment.mentions);
              }}
              className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={edit.isPending || draft.trim().length === 0}
              onClick={() => {
                edit.mutate(
                  { body: draft.trim(), mentions: editMentions },
                  { onSuccess: () => setEditing(false) }
                );
              }}
              className="rounded bg-neutral-900 px-2.5 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-0.5 leading-snug text-neutral-900 dark:text-neutral-100">
          {renderMentions(comment.body, comment.mentions, usersQ.data ?? [])}
        </div>
      )}
    </div>
  );
}

export function ThreadCard({ versionId, thread, drifted, currentUserId, onHighlight, isFocused = false }: Props) {
  const [replying, setReplying] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const [replyMentions, setReplyMentions] = useState<string[]>([]);
  useReportDraft(replying && replyDraft.trim().length > 0);
  const reply = useReply(versionId, thread.id);
  const resolve = useResolveThread(versionId, thread.id);
  const reopen = useReopenThread(versionId, thread.id);
  const isResolved = thread.resolvedAt !== null;
  const [first, ...replies] = commentRowModels(thread, currentUserId, Date.now());
  const bottomSheet = useBottomSheet();

  // Mounting a reply composer implicitly focuses this thread, so the user
  // sees the highlight in the iframe while they're typing.
  function startReplying() {
    bottomSheet?.snapTo('expanded');
    setReplying(true);
    onHighlight(thread.id);
  }

  const focusedClass = isFocused
    ? 'bg-amber-100 dark:bg-amber-900/40 ring-2 ring-inset ring-amber-400 dark:ring-amber-600 shadow-sm'
    : '';

  return (
    <article
      id={`thread-${thread.id}`}
      className={`border-b border-neutral-100 dark:border-neutral-800 px-3 py-2.5 text-xs ${focusedClass} ${
        isResolved ? 'opacity-55' : ''
      } ${drifted ? 'opacity-60' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, textarea, input, a')) return;
        onHighlight(thread.id);
      }}
    >
      <div className="mb-1.5 flex items-start gap-1 border-l-2 border-yellow-300 dark:border-amber-700 pl-2 italic leading-snug text-neutral-600 dark:text-neutral-400">
        {thread.contextChanged ? (
          <span
            title="The quoted text is not in this version"
            className="not-italic shrink-0 rounded bg-neutral-100 dark:bg-neutral-800 px-1 text-[10px] text-neutral-500 dark:text-neutral-400"
          >
            Context changed
          </span>
        ) : (
          drifted && <span title="Could not place anchor" className="not-italic">📍?</span>
        )}
        <span className="truncate">{anchorPreview(thread)}</span>
      </div>
      {first &&
        (first.mode === 'deleted' ? (
          <DeletedCommentRow
            comment={first.comment}
            isReply={false}
            canUndo={first.canUndo}
            versionId={versionId}
          />
        ) : (
          <CommentRow
            comment={first.comment}
            isReply={false}
            isAuthor={first.comment.authorId === currentUserId}
            versionId={versionId}
            onStartEditing={() => onHighlight(thread.id)}
          />
        ))}
      {replies.map((r) =>
        r.mode === 'deleted' ? (
          <DeletedCommentRow
            key={r.comment.id}
            comment={r.comment}
            isReply
            canUndo={r.canUndo}
            versionId={versionId}
          />
        ) : (
          <CommentRow
            key={r.comment.id}
            comment={r.comment}
            isReply
            isAuthor={r.comment.authorId === currentUserId}
            versionId={versionId}
            onStartEditing={() => onHighlight(thread.id)}
          />
        ),
      )}
      {replying && (
        <div className="mt-2">
          <MentionTextarea
            value={replyDraft}
            onChange={setReplyDraft}
            onMentionsChange={setReplyMentions}
            placeholder="Write a reply…"
            rows={2}
            autoFocus
          />
          {reply.isError && (
            <p role="alert" className="mt-1 text-red-600 dark:text-red-400">
              {describeApiError(reply.error)}
            </p>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReplying(false);
                setReplyDraft('');
                setReplyMentions([]);
                reply.reset();
              }}
              className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={reply.isPending || replyDraft.trim().length === 0}
              onClick={() =>
                reply.mutate(
                  { body: replyDraft.trim(), mentions: replyMentions },
                  {
                    onSuccess: () => {
                      setReplyDraft('');
                      setReplyMentions([]);
                      setReplying(false);
                    },
                  }
                )
              }
              className="rounded bg-neutral-900 px-2.5 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              Reply
            </button>
          </div>
        </div>
      )}
      {!replying && (
        <div className="mt-1.5 flex items-center gap-1 border-t border-neutral-100 dark:border-neutral-800 pt-1.5">
          <button type="button" onClick={startReplying} className={footerButtonClass}>
            <ReplyIcon />
            Reply
          </button>
          {isResolved ? (
            <button type="button" onClick={() => reopen.mutate()} className={footerButtonClass}>
              <ReopenIcon />
              Reopen
            </button>
          ) : (
            <button type="button" onClick={() => resolve.mutate()} className={footerButtonClass}>
              <CheckIcon />
              Resolve
            </button>
          )}
        </div>
      )}
    </article>
  );
}
