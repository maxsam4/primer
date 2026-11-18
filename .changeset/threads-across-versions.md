---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Comment threads now belong to the document instead of one version. When a new
version is published, every open thread moves to it, onto the same quoted text
(matched exactly, with the text right before or after it unchanged). A thread
whose text was changed or removed still shows on the new version, marked
"Context changed", and can be replied to there. Resolved threads stay on the
versions they were open on. Existing threads keep showing on their versions and
move forward with the next version published.

The MCP servers gain `primer_reply_to_thread` and `primer_resolve_thread`, so an
agent can answer feedback in the thread it was left in. `primer_get_comments`
now returns JSON: the markdown summary (with thread ids) plus one record per
comment with `thread_id`, `comment_id`, `author_id`, `anchor_text`,
`version_number`, `resolved` and `context_changed`. `ThreadDTO` gains
`versionNumber` (the version the thread was started on) and `contextChanged`.
