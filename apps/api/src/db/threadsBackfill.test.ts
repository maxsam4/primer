import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { v7 as uuidv7 } from 'uuid';
import { sql, db } from './client.ts';
import { users, documents, versions, threads } from './schema.ts';
import { insertThread } from '../testing/threads.ts';

const backfill = readFileSync(
  new URL('../../recovery/threads-across-versions-backfill.sql', import.meta.url),
  'utf8',
);

describe('threads-across-versions backfill (re-upgrade after a rollback)', () => {
  it('fills document_id and the placement of a thread made by the old binary, and re-running changes nothing', async () => {
    const userId = `t-${uuidv7()}`;
    const documentId = uuidv7();
    const versionId = uuidv7();
    const threadId = uuidv7();
    await db.insert(users).values({ id: userId, email: 'r@p.t', displayName: 'R' });
    await db.insert(documents).values({ id: documentId, title: 'D', uploaderId: userId });
    await db.insert(versions).values({
      id: versionId, documentId, versionNumber: 1, storageKey: `v1/${versionId}.html`, sizeBytes: 1, versionNote: null,
    });
    await insertThread({
      id: threadId,
      versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
    });

    // A live thread has no version and so no placement; the backfill skips it.
    await db.insert(threads).values({
      id: uuidv7(),
      documentId,
      versionId: null,
      anchor: { type: 'text-range', selectorText: 'y', prefix: '', suffix: '', containerPath: 'body' },
    });

    // The state the old binary leaves: nullable column, no document_id, no placement.
    await sql`ALTER TABLE threads ALTER COLUMN document_id DROP NOT NULL`;
    try {
      await sql`UPDATE threads SET document_id = NULL WHERE id = ${threadId}`;
      await sql`DELETE FROM thread_placements WHERE thread_id = ${threadId}`;

      const state = async () => ({
        threads: await sql`SELECT id, document_id FROM threads ORDER BY id`,
        placements: await sql`SELECT thread_id, version_id, anchor, created_at FROM thread_placements ORDER BY thread_id`,
      });

      await sql.unsafe(backfill);
      const once = await state();
      expect(once.threads).toContainEqual({ id: threadId, document_id: documentId });
      expect(once.placements).toHaveLength(1);
      expect(once.placements[0]).toMatchObject({ thread_id: threadId, version_id: versionId });

      await sql.unsafe(backfill);
      expect(await state()).toEqual(once);
    } finally {
      await sql`DELETE FROM threads WHERE document_id IS NULL`;
      await sql`ALTER TABLE threads ALTER COLUMN document_id SET NOT NULL`;
    }
  });
});
