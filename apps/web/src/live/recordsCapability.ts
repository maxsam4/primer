/**
 * The host side of a page's access to shared records. One capability per
 * iframe load, created only for a page the server serves with the records
 * outbound policy, and bound to that page's document. Everything that keeps a
 * page in bounds lives here, in the host, because the bridge script inside the
 * page (`companion/v1.js`) runs in the page's own world and can be bypassed:
 *
 * - the document comes from the capability, never from the page: `args` are
 *   rebuilt from an allow-list, so a `documentId`, owner or user id in them is
 *   dropped (personal records are always the signed-in viewer's own, decided
 *   by the server from the session);
 * - at most 8 calls in flight, 5 s each, 256 KB of arguments, 200 records a
 *   page; the page can cancel a call;
 * - `revoke()` (on unexpected navigation or unmount) fails every in-flight
 *   and later call.
 *
 * Calls go to the same REST verbs agents and tooling use, as the viewer.
 */
import type { Refusal, RefusalCode } from '@polygonlabs/primer-api-types';
import { MAX_RECORDS_PAGE_SIZE } from '@polygonlabs/primer-api-types';
import type { MsgRecordsCall, MsgRecordsResult } from '../companion/protocol.ts';
import { t } from '../i18n/index.ts';

export const MAX_RECORDS_IN_FLIGHT = 8;
export const RECORDS_CALL_TIMEOUT_MS = 5_000;
export const MAX_RECORDS_CALL_BYTES = 256 * 1024;

export interface RecordsCapability {
  readonly documentId: string;
  readonly pageTarget: string;
  /** Runs one page call and answers through `reply`, exactly once. */
  call(msg: MsgRecordsCall, reply: (result: MsgRecordsResult) => void): void;
  cancel(callId: string): void;
  /** Ends access: in-flight calls fail, later calls are refused. */
  revoke(): void;
  readonly revoked: boolean;
}

export interface RecordsCapabilityOptions {
  documentId: string;
  /** The page this capability serves (its version id, for now). */
  pageTarget: string;
  /** Same-origin, cookie-authed fetch (inject `api` from lib/fetch.ts). */
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

const QUERY_KEYS = ['collection', 'scope', 'recordId', 'data', 'expectVersion', 'where', 'orderBy', 'limit', 'cursor'] as const;
const OP_KEYS = ['verb', 'collection', 'scope', 'recordId', 'data', 'expectVersion'] as const;

function pick(raw: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

/** The arguments the server will see: only the keys a page may choose. */
export function boundArgs(verb: MsgRecordsCall['verb'], rawArgs: unknown): Record<string, unknown> {
  const args = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  if (verb === 'changesSince') return pick(args, ['changeId', 'limit']);
  if (verb === 'batch') {
    const ops = Array.isArray(args.ops) ? args.ops : [];
    return { ops: ops.map((op) => (typeof op === 'object' && op !== null ? pick(op as Record<string, unknown>, OP_KEYS) : op)) };
  }
  return pick(args, QUERY_KEYS);
}

function refusal(code: RefusalCode, message: string, fix: string): Refusal {
  return { code, message, fix };
}

export function createRecordsCapability(opts: RecordsCapabilityOptions): RecordsCapability {
  const { documentId, pageTarget, fetchImpl } = opts;
  const timeoutMs = opts.timeoutMs ?? RECORDS_CALL_TIMEOUT_MS;
  const inFlight = new Map<string, { abort: AbortController; settle: (r: MsgRecordsResult) => void }>();
  let revoked = false;
  const base = `/api/documents/${encodeURIComponent(documentId)}/records`;

  const request = (verb: MsgRecordsCall['verb'], args: Record<string, unknown>, signal: AbortSignal) => {
    if (verb === 'changesSince') {
      const since = Number.isInteger(args.changeId) && (args.changeId as number) >= 0 ? (args.changeId as number) : 0;
      const limit = Number.isInteger(args.limit) ? `&limit=${args.limit as number}` : '';
      return fetchImpl(`${base}/changes?since=${since}${limit}`, { signal, credentials: 'same-origin' });
    }
    return fetchImpl(`${base}/${verb}`, {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
  };

  return {
    documentId,
    pageTarget,
    get revoked() {
      return revoked;
    },

    call(msg, reply) {
      const answer = (r: Omit<MsgRecordsResult, 'type' | 'callId'>) => reply({ type: 'records_result', callId: msg.callId, ...r });
      if (revoked) {
        answer({ ok: false, refusal: refusal('records_unavailable', 'Record access for this page has ended.', 'Reload the page.') });
        return;
      }
      if (inFlight.has(msg.callId)) {
        answer({ ok: false, refusal: refusal('bad_request', 'callId is already in flight.', 'Use a fresh callId per call.') });
        return;
      }
      const args = boundArgs(msg.verb, msg.args);
      let body: string;
      try {
        body = JSON.stringify(args);
      } catch {
        // BigInt or a circular structure survives postMessage but not JSON.
        answer({ ok: false, refusal: refusal('bad_request', 'The call arguments are not JSON-serializable.', 'Send plain JSON values.') });
        return;
      }
      if (new TextEncoder().encode(body).byteLength > MAX_RECORDS_CALL_BYTES) {
        answer({ ok: false, refusal: refusal('bad_request', `A record call carries at most ${MAX_RECORDS_CALL_BYTES} bytes.`, 'Send less data per call.') });
        return;
      }
      if (typeof args.limit === 'number' && args.limit > MAX_RECORDS_PAGE_SIZE) {
        answer({ ok: false, refusal: refusal('bad_request', `limit is at most ${MAX_RECORDS_PAGE_SIZE}.`, 'Page through with cursor.') });
        return;
      }

      if (inFlight.size >= MAX_RECORDS_IN_FLIGHT) {
        answer({
          ok: false,
          refusal: refusal('records_busy', t('records.tooMany', { max: MAX_RECORDS_IN_FLIGHT }), 'Wait for a call to finish, then retry.'),
        });
        return;
      }
      const abort = new AbortController();
      let done = false;
      const settle = (r: MsgRecordsResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        inFlight.delete(msg.callId);
        reply(r);
      };
      const timer = setTimeout(() => {
        abort.abort();
        settle({
          type: 'records_result',
          callId: msg.callId,
          ok: false,
          refusal: refusal('records_busy', t('records.timeout', { seconds: timeoutMs / 1000 }), 'Retry, or ask for fewer records.'),
        });
      }, timeoutMs);
      inFlight.set(msg.callId, { abort, settle });

      request(msg.verb, args, abort.signal)
        .then(async (res) => {
          const json = (await res.json().catch(() => null)) as { refusal?: Refusal; error?: string; message?: string } | null;
          if (res.ok) {
            settle({ type: 'records_result', callId: msg.callId, ok: true, value: json });
          } else {
            settle({
              type: 'records_result',
              callId: msg.callId,
              ok: false,
              refusal: json?.refusal ?? refusal('bad_request', json?.message ?? json?.error ?? `HTTP ${res.status}`, 'Check the arguments.'),
            });
          }
        })
        .catch(() => {
          settle({
            type: 'records_result',
            callId: msg.callId,
            ok: false,
            refusal: refusal('records_busy', 'The call did not complete.', 'Retry.'),
          });
        });
    },

    cancel(callId) {
      const entry = inFlight.get(callId);
      if (!entry) return;
      entry.abort.abort();
      entry.settle({
        type: 'records_result',
        callId,
        ok: false,
        refusal: refusal('records_busy', 'The call was cancelled.', 'Call again if you still need it.'),
      });
    },

    revoke() {
      if (revoked) return;
      revoked = true;
      for (const [callId, entry] of [...inFlight]) {
        entry.abort.abort();
        entry.settle({
          type: 'records_result',
          callId,
          ok: false,
          refusal: refusal('records_unavailable', 'Record access for this page has ended.', 'Reload the page.'),
        });
      }
    },
  };
}
