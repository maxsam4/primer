import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { DocumentStatusDTO, DocumentStatusResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

/**
 * Who is working on the document now (an unexpired `working` status). The
 * document page refreshes this when a `primer.status` event arrives; between
 * events a status still lapses on time, because the hook drops it at its
 * `expiresAt` without asking the server.
 */
export function useDocumentStatus(docId: string): DocumentStatusDTO[] {
  const query = useQuery({
    queryKey: ['status', docId],
    queryFn: async ({ signal }): Promise<DocumentStatusResponse> => {
      const res = await api(`/api/documents/${docId}/status`, { signal });
      if (!res.ok) throw new Error(`status fetch failed: ${res.status}`);
      return res.json();
    },
    enabled: docId.length > 0,
  });
  const [now, setNow] = useState(() => Date.now());
  const statuses = (query.data?.statuses ?? []).filter((s) => Date.parse(s.expiresAt) > now);
  const nextExpiry = Math.min(...statuses.map((s) => Date.parse(s.expiresAt)));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [nextExpiry]);
  return statuses;
}
