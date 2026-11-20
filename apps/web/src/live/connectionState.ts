/** What the connection indicator shows (ConnectionStatus.tsx). */
export type ConnectionView =
  | { kind: 'ok' }
  | { kind: 'reconnecting' }
  | { kind: 'offline' }
  | { kind: 'unsaved' }
  | { kind: 'save-failed' }
  | { kind: 'forbidden' };

/** Unsynced changes only count as "unsaved" after this long: most round trips finish sooner. */
export const UNSAVED_AFTER_MS = 5_000;
/** A connection down this long is offline, not a blip. */
export const OFFLINE_AFTER_MS = 10_000;

/**
 * The indicator's state from what the provider reports. A save failure and
 * lost access are sticky until the editor retries or leaves; otherwise a
 * connection that isn't `connected` is reconnecting, and changes the server
 * hasn't acknowledged for more than five seconds are unsaved. Down for more
 * than ten seconds, it is offline.
 */
export function connectionView(input: {
  status: 'connecting' | 'connected' | 'disconnected';
  lastCloseCode: number | null;
  unsyncedSince: number | null;
  downSince?: number | null;
  now: number;
}): ConnectionView {
  if (input.lastCloseCode === 4500) return { kind: 'save-failed' };
  if (input.lastCloseCode === 4403) return { kind: 'forbidden' };
  if (input.status !== 'connected') {
    return input.downSince != null && input.now - input.downSince > OFFLINE_AFTER_MS ? { kind: 'offline' } : { kind: 'reconnecting' };
  }
  if (input.unsyncedSince !== null && input.now - input.unsyncedSince > UNSAVED_AFTER_MS) return { kind: 'unsaved' };
  return { kind: 'ok' };
}
