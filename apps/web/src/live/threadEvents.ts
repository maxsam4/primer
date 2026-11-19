import { useEffect, useRef } from 'react';

const THREAD_EVENTS = new Set(['comment.created', 'thread.resolved', 'thread.updated', 'thread.orphaned']);

/**
 * Calls `onChange` when the document's comments change (Primer's own
 * lifecycle events on the document's event stream), so every viewer's
 * comments sidebar follows other people's comments, replies and resolves.
 */
export function useThreadEvents(documentId: string, onChange: () => void, types: ReadonlySet<string> = THREAD_EVENTS): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource(`/api/documents/${encodeURIComponent(documentId)}/events/stream`);
    source.onmessage = (message) => {
      const row = JSON.parse(message.data as string) as { namespace?: string; type?: string };
      if (row.namespace === 'primer' && row.type && types.has(row.type)) latest.current();
    };
    return () => source.close();
  }, [documentId, types]);
}
