import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CopyDocumentResponse, DocumentDetailResponse, DocumentPatchRequest, ProposeBranchResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

export function useDocument(docId: string) {
  return useQuery({
    queryKey: ['document', docId],
    // Each fetch records a visit and returns the previous one: opening the page is a visit, cached or not.
    refetchOnMount: 'always',
    queryFn: async (): Promise<DocumentDetailResponse> => {
      const res = await api(`/api/documents/${docId}`);
      if (res.status === 404) {
        throw new Error('not_found');
      }
      if (!res.ok) {
        throw new Error(`fetch failed: ${res.status}`);
      }
      return res.json();
    },
  });
}

export function useEditDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DocumentPatchRequest) => {
      const res = await api(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`edit doc failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

export function useDeleteDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ id: string; deletedAt: string }> => {
      const res = await api(`/api/documents/${docId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`delete failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

export function useRestoreDocument(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api(`/api/documents/${docId}/restore`, { method: 'POST' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`restore failed: ${res.status} ${text}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document', docId] });
      qc.invalidateQueries({ queryKey: ['library'] });
    },
  });
}

/** Copies a live document into a new one of the caller's: a private branch,
 *  or a fork (also "New from template"). Resolves to the new document's id. */
export function useCopyDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docId, kind }: { docId: string; kind: 'branch' | 'fork' }): Promise<string> => {
      const res = await api(`/api/documents/${encodeURIComponent(docId)}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) throw new Error(await refusalMessage(res));
      return ((await res.json()) as CopyDocumentResponse).documentId;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library'] }),
  });
}

/** Proposes a branch back to its parent as one change set of suggestions. */
export function useProposeBranch(docId: string) {
  return useMutation({
    mutationFn: async (): Promise<ProposeBranchResponse> => {
      const res = await api(`/api/documents/${encodeURIComponent(docId)}/propose`, { method: 'POST' });
      if (!res.ok) throw new Error(await refusalMessage(res));
      return res.json();
    },
  });
}

async function refusalMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { refusal?: { message: string; fix: string } } | null;
  return body?.refusal ? `${body.refusal.message} ${body.refusal.fix}` : String(res.status);
}
