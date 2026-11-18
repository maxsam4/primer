import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type {
  AddVersionResponse,
  VersionPatchRequest,
  VersionSummaryDTO,
  VersionsListResponse,
} from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { becameVisible } from '../lib/visibility.ts';

/**
 * The document's version list (and therefore the version switcher). The
 * document page refreshes it when a `primer.version.published` event
 * arrives on the document's event stream (routes/document.tsx); the
 * listener below catches up the moment the tab becomes visible again. This
 * fetch never changes which version is being VIEWED; the page latches that
 * per navigation (lib/viewedVersion.ts).
 */
export function useVersionsQuery(docId: string) {
  const qc = useQueryClient();
  const hiddenRef = useRef(typeof document !== 'undefined' && document.hidden);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityOrFocus = () => {
      const isHiddenNow = document.hidden;
      if (becameVisible(hiddenRef.current, isHiddenNow)) {
        void qc.invalidateQueries({ queryKey: ['versions', docId] });
      }
      hiddenRef.current = isHiddenNow;
    };
    document.addEventListener('visibilitychange', onVisibilityOrFocus);
    window.addEventListener('focus', onVisibilityOrFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.removeEventListener('focus', onVisibilityOrFocus);
    };
  }, [qc, docId]);

  return useQuery({
    queryKey: ['versions', docId],
    queryFn: async ({ signal }): Promise<VersionsListResponse> => {
      const res = await api(`/api/documents/${docId}/versions`, { signal });
      if (!res.ok) throw new Error(`versions fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: docId.length > 0,
    staleTime: 30_000,
  });
}

export function useAddVersion(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: File; versionNote: string | null }): Promise<AddVersionResponse> => {
      const fd = new FormData();
      fd.append('file', input.file);
      if (input.versionNote !== null) fd.append('versionNote', input.versionNote);
      const res = await api(`/api/documents/${docId}/versions`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`add version failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['document', docId] });
      void qc.invalidateQueries({ queryKey: ['library'] });
      // Callers navigate to /d/:docId as soon as this resolves, and that page
      // latches whatever "latest" the cached version list holds on its first
      // render (lib/viewedVersion.ts). So wait for the list to include the
      // new version first, as switchToLatest does; otherwise the publisher
      // lands on the old version and is told a "newer version" (their own)
      // was published. refetchQueries rather than invalidateQueries so a
      // cached list nobody is watching right now (publishing from the
      // library) is refreshed too, not just marked stale.
      await qc.refetchQueries({ queryKey: ['versions', docId], exact: true });
    },
  });
}

export function useEditVersionNote(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (versionNote: string | null): Promise<VersionSummaryDTO> => {
      const payload: VersionPatchRequest = { versionNote };
      const res = await api(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`edit version note failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      // We don't know the docId here; invalidate all versions queries.
      qc.invalidateQueries({ queryKey: ['versions'] });
    },
  });
}
