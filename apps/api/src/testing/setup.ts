import { sql } from '../db/client.ts';
import { afterAll, beforeEach } from 'vitest';

beforeEach(async () => {
  // Wipe transactional tables between tests; keep the seeded mock user row.
  await sql`truncate table suggestions, run_inverses, agent_runs, doc_updates, doc_snapshots, doc_files, events, external_views, external_viewer_sessions, external_otps, external_recipients, external_shares, document_collaborators, document_views, comment_reactions, comments, threads, versions, documents, document_folders, folders restart identity cascade`;
  // Wipe sessions and non-mock users so session tests start clean.
  await sql`truncate table sessions restart identity cascade`;
  await sql`delete from users where id != 'mock-user-1'`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});
