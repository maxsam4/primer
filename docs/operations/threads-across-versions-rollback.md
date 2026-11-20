# Rolling back and re-upgrading threads across versions

Migration 0015 only adds a table (`thread_placements`), a column
(`threads.document_id`) and constraints; no data is dropped.

## Roll back to the previous image

1. Allow the old binary to insert threads, which know nothing of `document_id`:

   ```sql
   ALTER TABLE threads ALTER COLUMN document_id DROP NOT NULL;
   ```

2. Deploy the old image.

The old code reads threads by `threads.version_id`, so every thread still shows
on the version it was started on. Placements carried to later versions are not
shown until the new image returns. Keep `thread_placements` and
`threads.document_id`; drop them only if the feature is abandoned for good.

## Re-upgrade

Deploy the new image. Migration 0015 is already recorded and does not run
again, so threads created during the rollback still lack `document_id` and a
placement, and would not show on their version. Backfill them once the new
image is up:

```sh
psql "$DATABASE_URL" -f apps/api/recovery/threads-across-versions-backfill.sql
```

The script is idempotent (it fills only what is missing) and puts the
`NOT NULL` constraint back. A thread started during the rollback appears on the
version it was started on and moves forward with the next version published.
