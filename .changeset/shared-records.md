---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Shared records: per-document storage for pages and agents, like Claude Artifacts storage.

- **Records.** Every document can hold records in collections, `shared` (every
  reader sees them) or `personal` (only the person or agent who wrote them).
  Verbs get, list, query, set, update (shallow merge), delete and batch (all
  or nothing) over REST (`POST /api/documents/:docId/records/<verb>`), MCP
  (`primer_read_records`, `primer_write_records`) and the page bridge. Writes
  return the merged record, so `records:write` also reveals the records it
  touches. Writes take `expectVersion` and are refused with `record_conflict` when stale.
  Owners, editors and responders write. Records are never tied to page
  versions.
- **Change log, revert, purge.** Every write is logged with before and after
  data (`GET /api/documents/:docId/records/changes?since=`,
  `primer_record_changes`); owners and editors revert a shared change
  (`POST /api/record-changes/:changeId/revert`, `primer_revert_record_change`).
  The owner (a person, never an agent) can delete one user's personal records
  (`…/records/purge-personal`, `primer_purge_personal_records`).
- **Caps.** Shared records: 10,000 and 10 MB per document. Personal records:
  1,000 and 1 MB per person or agent per document. 64 KB per record.
  Crossing one is refused with `records_cap`.
- **Scopes.** New token scopes `records:read`, `records:write` and
  `records:manage` (purge only; never implied by `records:write`).
- **Untrusted data.** An agent reading a record (or a change) that anyone but
  itself contributed to gets `untrusted: true`; merges and reverts keep the
  mark.
- **data.changed.** Shared writes produce one coalesced `primer.data.changed`
  event per (document, writer) about 2 s after a burst. An agent is never
  handed the `data.changed` its own writes caused; a person is, so a second
  tab of the same person still refreshes.
- **Pages.** A page with `<meta name="primer-records" content="read">` is
  served with the `records` outbound policy (nothing remote), gets no
  `open_external`, and gets `window.primer.records` bound by the host to its
  document and viewer (8 calls in flight, 5 s, 256 KB) plus
  `primer:records-changed` events and `changesSince`. A record-reading frame
  that navigates itself loses record access and is reloaded.
  `GET /api/versions/:versionId/page` tells the host a page's document and
  policy.
- **Users.** `GET /api/users/lookup` also returns `email` and `displayName`.
  api-types adds the collaborator refusal codes `user_not_found`,
  `collaborator_exists`, `owner_not_collaborator`,
  `invalid_role_for_visibility` and `role_exceeds_own`.
