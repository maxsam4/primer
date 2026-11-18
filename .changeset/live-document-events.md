---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Documents update live. Primer now writes its own events, in the same
transaction as the change: `primer.comment.created`, `primer.thread.resolved`,
`primer.thread.updated`, `primer.version.published` and `primer.status`
(namespace `primer`, audience `readers`: everyone who can read the document;
no client can write them). The document page reads them from its event stream
instead of polling threads every 10s and versions every 30s: comments appear
at once, and a new version replaces the view in place unless you have an
unsent comment, reply or edit (then the "newer version" notice shows as
before). Event ids now follow commit order, so `since` and `Last-Event-ID` are
complete resume points. `GET /api/events/stream?scope=me` streams every
document you own. Agents can show "<name> is revising…" on a document with the
new `primer_set_status` MCP tool (`POST /api/documents/:id/status`); a working
status lapses after 10 minutes unless refreshed.
