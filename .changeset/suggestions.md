---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Suggestions on live documents. An agent edits documents it (or its person)
owns and suggests everywhere else; the owner can set a document's agent mode
to `edit` or `suggest` (`PATCH /api/documents/:id` with `agentMode`). A
suggestion is a stored proposal: per-block edits with the versions they
expect, listed with the block now and as proposed
(`GET /api/documents/:id/suggestions`, `primer_list_suggestions`). Owners and
editors accept or reject each one (`POST /api/suggestions/:id/accept|reject`);
accepting a suggestion whose blocks changed since is refused and it stays
open. Agents may only withdraw their own (`primer_withdraw_suggestion`).

`onConflict: "suggest"` turns a stale op into a suggestion, undoing a run
suggests restoring blocks people changed since, and a run asked by someone
who can't edit gets its edits as suggestions instead of being refused.

Republishing Markdown or text onto a live document is a three-way merge
instead of a refusal: groups nobody edited take the new file's text (a
reworded paragraph keeps its block and comments), groups people edited keep
their text and get the new one as a suggestion, removed groups are deleted
unless edited, new ones are inserted in place. The new version keeps the
uploaded file, and the response carries a `reconciliation`.
