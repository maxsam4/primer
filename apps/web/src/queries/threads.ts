import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadsListResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

// Module-level ETag cache keyed by versionId so re-renders don't lose it.
const etagByVersion = new Map<string, string>();

interface CachedShape {
  data: ThreadsListResponse;
  etag: string | null;
}

async function fetchConditional(
  versionId: string,
  previous: CachedShape | undefined,
  signal: AbortSignal
): Promise<CachedShape> {
  const headers: Record<string, string> = {};
  const cachedEtag = etagByVersion.get(versionId);
  if (cachedEtag) headers['if-none-match'] = cachedEtag;

  const res = await api(`/api/versions/${versionId}/threads`, { headers, signal });

  if (res.status === 304) {
    if (previous) return previous;
    // Cache miss but server said 304 — drop the ETag and refetch unconditionally.
    etagByVersion.delete(versionId);
    return fetchConditional(versionId, undefined, signal);
  }

  if (!res.ok) {
    throw new Error(`threads fetch failed: ${res.status}`);
  }

  const data = (await res.json()) as ThreadsListResponse;
  const etag = res.headers.get('etag');
  if (etag) etagByVersion.set(versionId, etag);
  return { data, etag };
}

/** A version's threads. No polling: the document page refreshes this when a
 *  comment or thread event arrives on the document's event stream, and on
 *  any stream resync (routes/document.tsx). */
export function useThreadsQuery(versionId: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['threads', versionId],
    queryFn: async ({ signal }) => {
      const previous = qc.getQueryData<CachedShape>(['threads', versionId]);
      return fetchConditional(versionId, previous, signal);
    },
    staleTime: 0,
    retry: 1,
    enabled: versionId.length > 0,
  });
}

export type ThreadsQueryShape = CachedShape;

export function clearThreadsEtag(versionId: string): void {
  etagByVersion.delete(versionId);
}
