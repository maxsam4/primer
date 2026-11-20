-- Re-runnable backfill for migration 0015 (threads across versions). Run it
-- after re-upgrading from a rollback: threads created by the old binary have no
-- document_id and no placement. Live threads (no version_id) have no
-- placement. Safe to run any number of times.
UPDATE threads t SET document_id = v.document_id
  FROM versions v
  WHERE v.id = t.version_id AND t.document_id IS NULL;

INSERT INTO thread_placements (thread_id, version_id, anchor, created_at)
  SELECT t.id, t.version_id, t.anchor, t.created_at FROM threads t
  WHERE t.version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM thread_placements p WHERE p.thread_id = t.id AND p.version_id = t.version_id
  );

ALTER TABLE threads ALTER COLUMN document_id SET NOT NULL;
