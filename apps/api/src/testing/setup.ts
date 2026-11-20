import { sql } from '../db/client.ts';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { loadSigningKey } from '../live/signing.ts';

// The server loads the import signing key at start (src/index.ts); tests get a fresh one.
beforeAll(async () => {
  await loadSigningKey({
    get: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    put: async () => undefined,
    delete: async () => undefined,
  });
});

beforeEach(async () => {
  // Wipe transactional tables between tests; keep the seeded mock user row.
  await sql`truncate table widgets, doc_mentions, doc_decisions, doc_tasks, suggestions, run_inverses, agent_runs, doc_record_changes, doc_records, doc_updates, doc_snapshots, doc_files, events, external_views, external_viewer_sessions, external_otps, external_recipients, external_shares, document_collaborators, document_views, comment_reactions, comments, threads, versions, documents, document_folders, folders restart identity cascade`;
  // Wipe sessions and non-mock users so session tests start clean.
  await sql`truncate table sessions restart identity cascade`;
  await sql`delete from users where id != 'mock-user-1'`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});
