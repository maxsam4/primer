import { describe, expect, it, vi } from 'vitest';
import type { MsgRecordsResult } from '../companion/protocol.ts';
import { createRecordsCapability, MAX_RECORDS_IN_FLIGHT } from './recordsCapability.ts';

const DOC = '01900000-0000-7000-8000-000000000001';

function fakeFetch() {
  const calls: { url: string; init: RequestInit; resolve: (r: Response) => void }[] = [];
  const fetchImpl = (url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, resolve });
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('records capability', () => {
  it('bridge ignores documentId and owner in args', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const cap = createRecordsCapability({ documentId: DOC, pageTarget: 'v1', fetchImpl });
    const replies: MsgRecordsResult[] = [];
    cap.call(
      {
        type: 'records_call',
        callId: 'c1',
        verb: 'set',
        args: { documentId: 'someone-elses-doc', ownerUserId: 'victim', owner: 'victim', userId: 'victim', collection: 'votes', scope: 'personal', recordId: 'r', data: { a: 1 } },
      },
      (r) => replies.push(r),
    );
    cap.call(
      {
        type: 'records_call',
        callId: 'c2',
        verb: 'batch',
        args: { documentId: 'x', ops: [{ verb: 'set', documentId: 'x', ownerUserId: 'victim', collection: 'c', scope: 'shared', recordId: 'r', data: {} }] },
      },
      (r) => replies.push(r),
    );
    expect(calls.map((c) => c.url)).toEqual([`/api/documents/${DOC}/records/set`, `/api/documents/${DOC}/records/batch`]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ collection: 'votes', scope: 'personal', recordId: 'r', data: { a: 1 } });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ ops: [{ verb: 'set', collection: 'c', scope: 'shared', recordId: 'r', data: {} }] });
    calls[0].resolve(json({ record: { recordId: 'r' } }));
    calls[1].resolve(json({ error: 'forbidden', refusal: { code: 'forbidden', message: 'no', fix: 'ask' } }, 403));
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[0]).toMatchObject({ callId: 'c1', ok: true, value: { record: { recordId: 'r' } } });
    expect(replies[1]).toMatchObject({ callId: 'c2', ok: false, refusal: { code: 'forbidden' } });
  });

  it('answers bad_request for arguments JSON cannot carry', () => {
    const { calls, fetchImpl } = fakeFetch();
    const cap = createRecordsCapability({ documentId: DOC, pageTarget: 'v1', fetchImpl });
    const replies: MsgRecordsResult[] = [];
    const call = (callId: string, args: unknown) =>
      cap.call({ type: 'records_call', callId, verb: 'set', args: args as Record<string, unknown> }, (r) => replies.push(r));
    call('big', { collection: 'c', data: { n: 1n } });
    call('null', null);
    expect(replies[0]).toMatchObject({ callId: 'big', ok: false, refusal: { code: 'bad_request' } });
    expect(calls).toHaveLength(1);
  });

  it('calls beyond 8 in flight are refused; cancel aborts', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const cap = createRecordsCapability({ documentId: DOC, pageTarget: 'v1', fetchImpl });
    const replies: MsgRecordsResult[] = [];
    for (let i = 0; i <= MAX_RECORDS_IN_FLIGHT; i++) {
      cap.call({ type: 'records_call', callId: `c${i}`, verb: 'list', args: { collection: 'c', scope: 'shared' } }, (r) => replies.push(r));
    }
    expect(calls).toHaveLength(MAX_RECORDS_IN_FLIGHT);
    expect(replies).toEqual([expect.objectContaining({ callId: 'c8', ok: false, refusal: expect.objectContaining({ code: 'records_busy' }) })]);

    cap.cancel('c0');
    expect(calls[0].init.signal?.aborted).toBe(true);
    expect(replies[1]).toMatchObject({ callId: 'c0', ok: false, refusal: { code: 'records_busy' } });
    // A slot is free again.
    cap.call({ type: 'records_call', callId: 'again', verb: 'list', args: { collection: 'c', scope: 'shared' } }, (r) => replies.push(r));
    expect(calls).toHaveLength(MAX_RECORDS_IN_FLIGHT + 1);

    // Oversized payloads never leave the host.
    cap.call({ type: 'records_call', callId: 'big', verb: 'set', args: { collection: 'c', scope: 'shared', recordId: 'r', data: { x: 'x'.repeat(300_000) } } }, (r) => replies.push(r));
    expect(replies.at(-1)).toMatchObject({ callId: 'big', ok: false, refusal: { code: 'bad_request' } });
  });

  it('a call times out after 5 s', async () => {
    vi.useFakeTimers();
    try {
      const { calls, fetchImpl } = fakeFetch();
      const cap = createRecordsCapability({ documentId: DOC, pageTarget: 'v1', fetchImpl });
      const replies: MsgRecordsResult[] = [];
      cap.call({ type: 'records_call', callId: 'slow', verb: 'get', args: { collection: 'c', scope: 'shared', recordId: 'r' } }, (r) => replies.push(r));
      vi.advanceTimersByTime(4_999);
      expect(replies).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(calls[0].init.signal?.aborted).toBe(true);
      expect(replies).toEqual([expect.objectContaining({ callId: 'slow', ok: false, refusal: expect.objectContaining({ code: 'records_busy' }) })]);
    } finally {
      vi.useRealTimers();
    }
  });
});
