import type { CommentDTO, ThreadDTO, ThreadsListResponse } from '@polygonlabs/primer-api-types';
import { isElementPathAnchor, isTextRangeAnchor } from '@polygonlabs/primer-api-types';

/**
 * Renders a `ThreadsListResponse` as a markdown summary suited for an LLM
 * consumer. The output is intentionally compact — the agent reads it back
 * to the user, so each line is one logical fact.
 *
 * Shape:
 *   # Comments [on <title> (v<n>)]
 *   Threads: N (open: O, resolved: R)
 *
 *   > <selectorText OR innerText OR "(no quote)">
 *   [open|resolved]
 *   **<author>** — <body> (<createdAt>)
 *   ...
 *
 * Tombstoned (`deletedAt != null`) comments render as a single `(deleted)`
 * line and never spill their (server-blanked) body.
 *
 * Empty case → `"No comments on this version."` (no header at all — the
 * markdown noise isn't useful when there's nothing to summarize).
 */
export function formatComments(
  threads: ThreadsListResponse,
  docTitle?: string,
  versionNumber?: number,
): string {
  const list = threads.threads;
  if (list.length === 0) return 'No comments on this version.';

  const header =
    docTitle !== undefined && versionNumber !== undefined
      ? `# Comments on ${docTitle} (v${versionNumber})`
      : '# Comments';

  const open = list.filter((t) => t.resolvedAt === null).length;
  const resolved = list.length - open;
  const counts = `Threads: ${list.length} (open: ${open}, resolved: ${resolved})`;

  const sections = list.map(renderThread);

  return [header, counts, '', ...sections].join('\n').trimEnd() + '\n';
}

function renderThread(thread: ThreadDTO): string {
  const quote = anchorQuote(thread.anchor);
  const badge = thread.resolvedAt === null ? '[open]' : '[resolved]';
  const placement = thread.contextChanged ? ' (context changed)' : '';
  const commentLines = thread.comments.map(renderComment);
  return [`> ${quote}`, `${badge} thread ${thread.id}${placement}`, ...commentLines, ''].join('\n');
}

/**
 * One flat record per live comment, with the ids an agent needs to reply in or
 * resolve the thread. `version_number` is the version the thread was started
 * on. Comment bodies are untrusted text written by people.
 */
export function commentRecords(threads: ThreadsListResponse) {
  return threads.threads.flatMap((t) =>
    t.comments
      .filter((c) => c.deletedAt === null)
      .map((c) => ({
        thread_id: t.id,
        comment_id: c.id,
        author_id: c.authorId,
        author_name: c.authorDisplayName,
        body: c.body,
        created_at: c.createdAt,
        anchor_text: anchorText(t.anchor),
        version_number: t.versionNumber,
        resolved: t.resolvedAt !== null,
        context_changed: t.contextChanged,
      })),
  );
}

function anchorText(anchor: ThreadDTO['anchor']): string {
  if (isTextRangeAnchor(anchor)) return anchor.selectorText;
  if (isElementPathAnchor(anchor)) return anchor.innerText ?? '';
  return '';
}

function anchorQuote(anchor: ThreadDTO['anchor']): string {
  if (isTextRangeAnchor(anchor)) return anchor.selectorText;
  if (isElementPathAnchor(anchor)) {
    // Element-path anchors don't carry the quoted text — they were captured by
    // pointing at a node. Fall back to innerText when the companion captured
    // it, else surface a placeholder so the line stays well-formed.
    return anchor.innerText && anchor.innerText.length > 0 ? anchor.innerText : '(no quote)';
  }
  return '(no quote)';
}

function renderComment(comment: CommentDTO): string {
  if (comment.deletedAt !== null) return '(deleted)';
  return `**${comment.authorDisplayName}** — ${comment.body} (${comment.createdAt})`;
}
