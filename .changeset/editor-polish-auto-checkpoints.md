---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
---

Live documents save checkpoints on their own: two minutes after edits settle,
and at least every ten minutes while editing goes on, only when someone changed
the content since the latest checkpoint. History marks them as automatic.
Saving a checkpoint by hand shows that it is saving, then "Checkpoint vN saved"
with a link to it, or that no one edited it since vN, or that it failed.

People can suggest instead of edit: the editor header has an Editing |
Suggesting switch. While suggesting, edits are a draft sent as suggestions
(apply ops with `mode: 'suggest'`), which the owner and editors accept or
reject. Commenters can suggest too. Reordering, indenting and outdenting
blocks in the draft are suggested as moves, and a new block keeps its nesting;
`add` and `move` take `position: 'firstChild'` to place under a block.

The editor's toolbars, menus, comment popovers and side panels follow Primer's
light and dark tokens: the BlockNote Ariakit theme's own bevelled buttons,
nested toolbar frames and blue focus rings are replaced at the theme layer.

The editor stays live across server restarts and proxies: the header always
shows Live, Reconnecting… or Offline. The browser probes its socket and
reconnects (then resyncs) when the server stops answering, retrying at least
every five seconds; a shutting-down server closes its live connections
(1012) and event streams so browsers move to the next one at once. Comment,
thread and suggestion events also reach open editors over the live socket
(a stateless `primer.event` message), so new comments and replies appear
without reopening the sidebar even when a proxy holds back the event
stream, which now also reopens itself after an error response. After any
break, comments and suggestions are fetched again.
