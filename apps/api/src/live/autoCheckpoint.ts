import { sql } from 'drizzle-orm';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';
import type { Storage } from '../storage/types.ts';
import { contentUnchangedSince, createCheckpoint } from './checkpoint.ts';
import { onLiveUpdate } from './instance.ts';
import type { LiveOrigin } from './origin.ts';
import { ensureSigningKey } from './signing.ts';

/** A checkpoint is saved this long after the last edit... */
export const SETTLE_MS = 2 * 60_000;
/** ...and at least this often while editing goes on. */
export const MAX_WAIT_MS = 10 * 60_000;

type Pending = { timer: ReturnType<typeof setTimeout>; since: number; actorId: string };

const pending = new Map<string, Pending>();
const running = new Set<Promise<unknown>>();
let current: Storage | null = null;
let registered = false;

/**
 * Automatic checkpoints: once edits to a live document settle (SETTLE_MS after
 * the last one), and at most MAX_WAIT_MS into continuous editing, the live
 * state is saved as a checkpoint marked `automatic`, by whoever edited last.
 * Only content edits by people and agents count (comment marks and system
 * writes touch no block), and nothing is saved when nothing changed since the
 * latest checkpoint. The app calls this once.
 */
export function registerAutoCheckpoints(storage: Storage): void {
  current = storage;
  if (registered) return;
  registered = true;
  onLiveUpdate(schedule);
}

function schedule(documentId: string, origin: LiveOrigin, touched: string[]): void {
  if (origin.kind === 'system' || touched.length === 0) return;
  const now = Date.now();
  const prev = pending.get(documentId);
  if (prev) clearTimeout(prev.timer);
  const since = prev?.since ?? now;
  const delay = Math.max(0, Math.min(SETTLE_MS, since + MAX_WAIT_MS - now));
  const timer = setTimeout(() => run(documentId), delay);
  timer.unref?.();
  pending.set(documentId, { timer, since, actorId: origin.actorId });
}

function run(documentId: string): void {
  const entry = pending.get(documentId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(documentId);
  const job = autoCheckpoint(documentId, entry.actorId).catch((err: unknown) => {
    logger.warn({ documentId, error: String(err) }, 'auto checkpoint failed');
  });
  running.add(job);
  void job.finally(() => running.delete(job));
}

async function autoCheckpoint(documentId: string, actorId: string): Promise<void> {
  if (!current) return;
  const [row] = (await db.execute(sql`
    SELECT u.id, u.email, u.display_name AS "displayName", u.kind, u.via_user_id AS "viaUserId"
      FROM users u JOIN documents d ON d.id = ${documentId}
     WHERE u.id = ${actorId} AND d.deleted_at IS NULL
  `)) as unknown as AuthUser[];
  if (!row) return;
  if ((await contentUnchangedSince(documentId)) !== null) return;
  await ensureSigningKey(current);
  await createCheckpoint(current, documentId, row, null, { automatic: true });
}

/** Runs every scheduled checkpoint now and waits (tests, shutdown). */
export async function flushAutoCheckpoints(): Promise<void> {
  for (const documentId of [...pending.keys()]) run(documentId);
  await Promise.all([...running]);
}
