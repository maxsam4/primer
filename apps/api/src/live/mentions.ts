// Mention chips notify the person they name.
//
// Every change to a loaded live document schedules a sync (debounced per
// document, like tasks), which reads the mention chips per block and
// announces each new (block, person) pair once through the notifier, in the
// name of whoever changed that block. `doc_mentions` remembers the pairs
// already announced; a pair removed from the document leaves it. Chips are
// client-writable, so a mention notifies only an existing person who can
// read the document, and only when exactly one person or agent changed that
// block in the window (never on the system's behalf, never pinned on someone).
import { sql } from 'drizzle-orm';
import type { Notifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { logger } from '../logger.ts';
import { liveBlocks, validBlockId } from './blockTools.ts';
import { onLiveUpdate, withLiveDocument } from './instance.ts';

const USER_ID = /^[^\u0000-\u001f\u007f]{1,200}$/;

/** The person ids the mention chips in this inline content name. */
function mentionsIn(content: unknown, out: Set<string>): void {
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item !== 'object' || item === null) continue;
      const i = item as { type?: string; props?: { userId?: unknown }; content?: unknown };
      if (i.type === 'mention' && typeof i.props?.userId === 'string' && USER_ID.test(i.props.userId)) out.add(i.props.userId);
      else if (i.content !== undefined) mentionsIn(i.content, out);
    }
  } else if (typeof content === 'object' && content !== null && (content as { type?: string }).type === 'tableContent') {
    for (const row of (content as { rows?: { cells?: unknown[] }[] }).rows ?? []) {
      for (const cell of row.cells ?? []) mentionsIn(typeof cell === 'object' && cell && 'content' in cell ? (cell as { content: unknown }).content : cell, out);
    }
  }
}

/**
 * Announces the document's new mentions and forgets removed ones. `actors`:
 * who changed which block in the window.
 */
export async function syncMentions(notifier: Notifier, documentId: string, actors: Map<string, Set<string>>): Promise<void> {
  const [doc] = (await db.execute(sql`
    SELECT title, uploader_id AS "uploaderId", visibility, format FROM documents WHERE id = ${documentId} AND deleted_at IS NULL
  `)) as unknown as { title: string; uploaderId: string; visibility: Visibility; format: string | null }[];
  if (!doc?.format) return;
  const found = await withLiveDocument(documentId, (d) => {
    const pairs: { blockId: string; userId: string }[] = [];
    for (const { block } of liveBlocks(d)) {
      if (!validBlockId(block.id)) continue;
      const users = new Set<string>();
      mentionsIn(block.content, users);
      for (const userId of users) pairs.push({ blockId: block.id, userId });
    }
    return pairs;
  });
  const rows = (await db.execute(sql`
    SELECT block_id AS "blockId", user_id AS "userId" FROM doc_mentions WHERE document_id = ${documentId}
  `)) as unknown as { blockId: string; userId: string }[];
  const key = (p: { blockId: string; userId: string }) => `${p.blockId}\u0000${p.userId}`;
  const known = new Set(rows.map(key));
  const current = new Set(found.map(key));

  for (const row of rows) {
    if (!current.has(key(row))) {
      await db.execute(sql`DELETE FROM doc_mentions WHERE document_id = ${documentId} AND block_id = ${row.blockId} AND user_id = ${row.userId}`);
    }
  }
  for (const pair of found) {
    if (known.has(key(pair))) continue;
    const [person] = (await db.execute(sql`
      SELECT id, email, display_name AS "displayName", kind, via_user_id AS "viaUserId" FROM users WHERE id = ${pair.userId}
    `)) as unknown as { id: string; email: string; displayName: string; kind: 'person' | 'agent'; viaUserId: string | null }[];
    if (!person) continue;
    // Notify only for the row this sync inserted (a concurrent sync may have got there first).
    const inserted = (await db.execute(sql`
      INSERT INTO doc_mentions (document_id, block_id, user_id) VALUES (${documentId}, ${pair.blockId}, ${pair.userId})
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `)) as unknown as unknown[];
    if (inserted.length === 0) continue;
    const by = [...(actors.get(pair.blockId) ?? [])];
    if (person.kind !== 'person' || by.length !== 1 || by[0] === person.id) continue;
    const role = await loadEffectiveRole({ id: documentId, uploaderId: doc.uploaderId, visibility: doc.visibility }, person);
    if (!canRead(doc.visibility, role)) continue;
    await notifier.notifyDocumentMention({
      doc: { id: documentId, title: doc.title },
      blockId: pair.blockId,
      mentionedUserId: person.id,
      actorUserId: by[0]!,
    });
  }
}

const pending = new Map<string, { actors: Map<string, Set<string>>; timer: ReturnType<typeof setTimeout> }>();
const running = new Set<Promise<void>>();
let current: Notifier | null = null;

function run(documentId: string, actors: Map<string, Set<string>>): void {
  if (!current) return;
  const job = syncMentions(current, documentId, actors).catch((err: unknown) => {
    logger.warn({ documentId, error: String(err) }, 'mentions: sync failed');
  });
  running.add(job);
  void job.finally(() => running.delete(job));
}

let registered = false;

/** Mention chips notify through `notifier` (the app calls this once). */
export function registerMentionNotifications(notifier: Notifier): void {
  current = notifier;
  if (registered) return;
  registered = true;
  onLiveUpdate((documentId, origin, touched) => {
    let entry = pending.get(documentId);
    if (!entry) {
      const created = {
        actors: new Map<string, Set<string>>(),
        timer: setTimeout(() => {
          pending.delete(documentId);
          run(documentId, created.actors);
        }, 500),
      };
      created.timer.unref?.();
      pending.set(documentId, created);
      entry = created;
    }
    if (origin.kind === 'system') return;
    for (const blockId of touched) {
      const set = entry.actors.get(blockId) ?? new Set<string>();
      set.add(origin.actorId);
      entry.actors.set(blockId, set);
    }
  });
}

/** Runs every scheduled mention sync now and waits (tests, shutdown). */
export async function flushMentionSync(): Promise<void> {
  for (const [documentId, entry] of [...pending]) {
    clearTimeout(entry.timer);
    pending.delete(documentId);
    run(documentId, entry.actors);
  }
  await Promise.all([...running]);
}
