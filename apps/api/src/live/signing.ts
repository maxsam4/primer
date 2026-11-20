import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Storage } from '../storage/types.ts';

/**
 * The server's key for import provenance. Export re-emits a source slice or
 * the front matter verbatim only when the server signed it at import: the
 * `sources` and `meta` maps live in the Y.Doc, which every editor can write,
 * so an unsigned entry could carry text the editor never shows.
 *
 * The key is random, made once and kept in Primer's storage (no new config).
 * The server loads it before serving requests; signing or verifying without
 * it is a bug, so it throws.
 */
const KEY_PATH = 'keys/live-import-hmac';
let key: Buffer | null = null;

export async function loadSigningKey(storage: Storage): Promise<void> {
  let stored: Buffer;
  try {
    stored = Buffer.from(await new Response(await storage.get(KEY_PATH)).arrayBuffer());
  } catch (err) {
    // Only a missing key is made: any other failure (storage briefly down)
    // must not replace the key every existing signature depends on.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    stored = randomBytes(32);
    await storage.put(KEY_PATH, stored);
  }
  if (stored.length < 32) throw new Error(`live: the signing key at ${KEY_PATH} is too short`);
  key = stored;
}

function currentKey(): Buffer {
  if (!key) throw new Error('live: the import signing key is not loaded');
  return key;
}

/** MAC over a document id and the given fields, in order. */
export function sign(documentId: string, fields: unknown[]): string {
  return createHmac('sha256', currentKey()).update(JSON.stringify([documentId, ...fields])).digest('hex');
}

export function verify(documentId: string, fields: unknown[], mac: unknown): boolean {
  if (typeof mac !== 'string' || !/^[0-9a-f]{64}$/.test(mac)) return false;
  return timingSafeEqual(Buffer.from(sign(documentId, fields), 'hex'), Buffer.from(mac, 'hex'));
}
