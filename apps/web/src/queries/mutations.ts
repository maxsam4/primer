import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AnchorData,
  CommentDTO,
  CreateThreadRequest,
  ThreadDTO,
} from '@polygonlabs/primer-api-types';
import { clearThreadsEtag, type ThreadsQueryShape } from './threads.ts';
import { api } from '../lib/fetch.ts';
import { parseApiError } from '../lib/apiError.ts';

// Throws an ApiError carrying the server's own { error, message } on
// failure, instead of a generic Error wrapping raw (often JSON) response
// text — callers need the real message to show the user, and the parsed
// `code` to special-case not_latest_version. See lib/apiError.ts.
async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    throw await parseApiError(res);
  }
  return (await res.json()) as T;
}

function mergeThreadIntoCache(
  qc: ReturnType<typeof useQueryClient>,
  versionId: string,
  thread: ThreadDTO
) {
  qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
    if (!prev) return prev;
    const exists = prev.data.threads.some((t) => t.id === thread.id);
    // Single-thread responses carry the anchor the thread was started with;
    // keep the placement this version's list gave it.
    const threads = exists
      ? prev.data.threads.map((t) =>
          t.id === thread.id ? { ...thread, anchor: t.anchor, contextChanged: t.contextChanged } : t
        )
      : [...prev.data.threads, thread];
    return { ...prev, data: { ...prev.data, threads } };
  });
}

function applyCommentToCache(
  qc: ReturnType<typeof useQueryClient>,
  versionId: string,
  updated: CommentDTO
) {
  qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      data: {
        ...prev.data,
        threads: prev.data.threads.map((t) =>
          t.id === updated.threadId
            ? { ...t, comments: t.comments.map((c) => (c.id === updated.id ? updated : c)) }
            : t
        ),
      },
    };
  });
}

export function useCreateThread(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { anchor: AnchorData; body: string; mentions: string[] }) => {
      const payload: CreateThreadRequest = { anchor: input.anchor, body: input.body, mentions: input.mentions };
      const res = await api(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (newThread) => {
      mergeThreadIntoCache(qc, versionId, newThread);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useReply(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { body: string; mentions: string[] }) => {
      const res = await api(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return jsonOrThrow<{ comment: CommentDTO; thread: ThreadDTO }>(res);
    },
    onSuccess: (out) => {
      mergeThreadIntoCache(qc, versionId, out.thread);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useResolveThread(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api(`/api/threads/${threadId}/resolve`, { method: 'POST' });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (thread) => {
      mergeThreadIntoCache(qc, versionId, thread);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useReopenThread(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api(`/api/threads/${threadId}/reopen`, { method: 'POST' });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (thread) => {
      mergeThreadIntoCache(qc, versionId, thread);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useEditComment(versionId: string, commentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { body: string; mentions: string[] }) => {
      const res = await api(`/api/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return jsonOrThrow<CommentDTO>(res);
    },
    onSuccess: (updated) => {
      applyCommentToCache(qc, versionId, updated);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useDeleteComment(versionId: string, commentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api(`/api/comments/${commentId}`, { method: 'DELETE' });
      return jsonOrThrow<CommentDTO>(res);
    },
    onSuccess: (tombstone) => {
      applyCommentToCache(qc, versionId, tombstone);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

/** Undo a delete. Only succeeds for the author inside COMMENT_UNDO_WINDOW_MS;
 *  the server is the authority, the UI just hides the button outside it. */
export function useRestoreComment(versionId: string, commentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api(`/api/comments/${commentId}/restore`, { method: 'POST' });
      return jsonOrThrow<CommentDTO>(res);
    },
    onSuccess: (restored) => {
      applyCommentToCache(qc, versionId, restored);
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}
