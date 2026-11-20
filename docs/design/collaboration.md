# Primer collaboration surface: spec (decided 2026-11-19)

This is the proposed direction for Primer's collaboration surface, for the maintainers to review. The goal is the best surface for humans and AI agents to brainstorm, write and design together. Everything below ships, built in order. Simple and maintainable beats clever. Each concern has one way, with no fallbacks or dual paths. Speed and simplicity come first, without giving up the safety rules below.

## Document model
- A document has an original file (kept as uploaded) and a live block document. Formats differ only in how they import and which parts people can edit. Comments, presence, suggestions, agents, history and attribution are identical for every format.
- **Formats now:**
  - Markdown becomes BlockNote blocks, all of them editable.
  - `.txt` becomes paragraph blocks.
  - HTML becomes one "page block": the agent's page rendered in its sandboxed iframe, with its text editable live.
- **Formats later:** CSV, image and PDF uploads open as single-block documents. Whiteboards (Excalidraw) are a separate document type in phase 2 and are not built now.
- Legacy HTML versions keep rendering as they do today.

## HTML page text editing
- **Try first:** at publish, stamp every element whose children are plain text (and `<br>`) with a stable `data-pid`, using parse5 (already a dependency) with source offsets.
  - Ids survive agent republishes by matching old and new elements: the same pid if the agent kept it, otherwise the same tag, path and text similarity.
  - Script-drawn text is read-only. Detect it by checking that DOM text equals the source text at the span.
- **Fallback, if auto-stamping proves too finicky:** agent-authored explicit text ids, validated at publish, the same as Claude Docs widgets. Keep the code path small so the switch is cheap.
- **Editing happens in an overlay in Primer's own window,** never inside the page's scripts. The iframe bridge reports each editable element's pid, rect and text. Primer draws a small BlockNote inline editor over it, so keystrokes never enter the page.
- **Text state lives in the document's Y.Doc** (per-pid text). The page shows the current values: the host pushes them to the iframe bridge, which only sets `textContent` on stamped nodes.
- **Saving back:** on idle or checkpoint, people's text is spliced into the original HTML at each pid's source span. Nothing else in the page changes, byte for byte.
- **Agent republish:** carry people's text over per pid where the agent didn't change that element. This is a three-way merge against the base text. If both changed, keep the agent's text and post the person's text as a suggestion on that element.

## Block library (BlockNote, MPL-2.0 packages only)
- Text, headings, lists, check and toggle lists, quotes, callouts.
- Tables with merge and split, cell colours, headers, and dropdown and date cells.
- Code (`@blocknote/code-block`), math (`@blocknote/math-block`) and Mermaid (`@blocknote/diagram-block`).
- Image, video, audio and file blocks, with drag-and-drop upload. PDF uses the browser viewer in a file block.
- Embeds and link cards.
- Emoji, and text, background and block colours.
- Custom blocks, built on BlockNote's custom block API:
  - choice block (vote, comment, pick);
  - task block;
  - widget block (agent-drawn SVG diagrams and charts);
  - data table bound to shared records;
  - page block (HTML).
- **Inside HTML pages:** agents place `<primer-table>`, `<primer-code>`, `<primer-mermaid>` and the like, which the sanitizer must allow. The page renders them read-only from the block state. Clicking one opens the block editor in Primer's overlay. The state lives in the doc's Y.Doc.
- **Excluded:** all `@blocknote/xl-*` packages (GPL): AI, multi-column, and the PDF, DOCX, ODT and email exporters.

## Widgets (diagrams and charts)
- The agent owns the code: JSX or SVG modules with no imports, no fetch, no `style`, no `foreignObject`, and theme tokens only.
- Every typed label carries a literal `data-text-id`, and people edit labels in place through the overlay.
- Named parts carry `data-anchor`. Marks drawn from data rows carry row and column provenance.
- Numbers come from rows: either inline rows or a shared-records collection, so charts refresh live.
- A validator at publish rejects missing or computed ids. The agent receives a server-rendered screenshot before publish, using a draft then publish flow, and the last good publish stays live.
- An agent skill provides the visual vocabulary (flows, trees, 2x2s, timelines, funnels, roadmaps, charts) in one house style with light and dark tokens.

## Live sync and storage
- One Y.Doc per document holds BlockNote content, per-pid page text, widget labels and native block state.
- Hocuspocus 4 runs inside the API process over WebSocket.
- Auth reuses Primer's session, PAT and OAuth checks. Read, comment and edit roles are enforced per connection and rechecked on revocation or deletion.
- Persistence is Postgres `bytea` updates plus compacted snapshots.
- Awareness carries cursors and agent status, which replaces the custom "working status" TTL.
- Comments, per-viewer state and shared records stay **outside** the Y.Doc.
- **Deploy exactly one API process.** Open Y.Docs, the apply queue, live event fan-out and agent wake-ups are process-local. A second process would hold its own copy of a document and the two would diverge until reload.
  - Run one replica, and roll out with a stop-then-start strategy (Kubernetes `strategy: Recreate`, Compose's default), never a rolling update that overlaps the old and new process.
  - Clients reconnect on their own after the restart and catch up from Postgres.
  - Scaling past one process needs cross-process wake-ups (LISTEN/NOTIFY) and document routing first; that is out of scope here.
- **Versions are checkpoints.** A checkpoint stores the Y.Doc binary and a rendered export (Markdown for prose; HTML with splices for page blocks) at the same revision. Compare diffs the exports with the existing diff viewer.
  - Autosave is separate from publishing.
  - MCP reads choose live state or a checkpoint explicitly.
  - Never rebuild CRDT identity from an export.
  - External shares stay pinned to published checkpoints, and live data is frozen at publish.
- The old markdown-it upload path is removed once Markdown documents are live (one way).

## Comments
- Threads stay in Postgres.
- **Anchor kinds:**
  - prose: Yjs relative positions plus the quote;
  - page text: pid plus a range in that element's text;
  - widget label: text id;
  - widget part: anchor name;
  - data point: row and column;
  - block: block id;
  - later, whiteboard shape.
- **Anchor gone:** the thread stays open, is flagged "Text removed" with its quote, can be listed, and can be re-anchored by agents and people.
- **Deleting commented text** shows a reviewable warning with an explicit override. It is not a hard refusal.
- **Agents never resolve a person's thread.** Fix `routes/threads.ts` so a service or agent token can't resolve threads people wrote in.
- BlockNote's comments UI (thread sidebar with open/resolved filter, reactions) uses a custom thread store backed by Primer's API.

## Agents
- **Agent identity:** each agent has its own identity (principal, display name, via). Replace the shared `service-claude` for attribution and ownership.
- **Semantic operations:** agents send operations such as "replace these blocks", "insert after", "set a widget label" or "edit a range as Markdown". The server validates them and applies them to the Y.Doc with BlockNote server-util, merging as small changes. Raw peer updates from agents are not accepted.
- **Preconditions:** every op names the target and the revision or block hash it read. If that target changed since, the op returns a conflict (or becomes a suggestion), with a refusal code and a ready fix. Edits to unrelated blocks still go through.
- **Suggestions are stored proposals:** target blocks, new content and base revision, shown as diff cards. Accepting runs the normal op path.
  - Agents suggest on documents they don't own and edit their own. The owner can flip this per document.
  - Agents may withdraw their own suggestions, never decide others'.
- **Outline-first drafting:** pending placeholder blocks with an intent, filled section by section live.
- **Asking an agent:**
  - an @-mention in a comment, or "Send to agent";
  - @agent on an empty line, where the answer is written there;
  - a selection menu ("Ask agent" on a range).

  The agent receives the viewer context (tab, selection, unsent text) when asked.
- **Agent runs are controllable:** queued, running and failed states; cancel; retry; duplicate suppression; a status line in awareness.
- **Undo one agent run** without erasing other people's later work, scoped by agent origin per run.
- **Delta reads:** what changed since a given revision.
- **Refusals** carry a code and a fix.
- **One publish path:** consolidate REST and MCP publish preparation, with an atomic base-revision check.

## Shared data (Claude Artifacts storage, for every document)
- One `doc_records` table: `(document_id, collection, record_id, scope shared|personal, owner_user_id, data jsonb, version, updated_at, updated_by)`.
- Verbs: get, list, query, set, update, delete, batch.
- Pages reach records only through the host bridge, with the host authorizing per viewer. Close the `img-src https:` exfiltration path in `ARTIFACT_CSP` for pages that read records.
- Agents use MCP tools.
- A coalesced `data.changed` event wakes agents. Agents are not woken by their own writes.
- Records are not tied to page versions. An append-only change log gives audit and undo.
- Records written by viewers are fenced as untrusted when agents read them.
- Caps per document (records, bytes).
- Data-table blocks and charts bind to a collection or to a named warehouse query (supplied by an external integration, for example an agent fleet such as AidenHQ), and refresh live.

## Collaboration features (all ship)
- Choice blocks, with a decision register (option chosen, rationale, evidence, open questions).
- Catch-up view ("since you last looked"), plus a digest an external integration can push to Slack or Telegram.
- Task blocks that become tracked tasks.
- Private drafts and branches, proposed back as one change set.
- Fuzzy re-anchoring.
- Inline change highlights since the last checkpoint.
- Live data blocks.
- Fork and remix.
- Promote a conversation into a doc.
- Plan-first for big agent edits.
- Templates.
- Evidence provenance: links from claims to sources and source versions.
- Collaborator tools for agents (issue #98).
- Tabs.
- Inline chips: mentions, dates, dropdowns.
- Export to Markdown and HTML, and PDF via print.
- Rich paste.
- Read-only and static rendering for external shares and email digests.
- Dark mode and theming.
- Localisation.

## Constraints
- **Dependencies:** Primer's `pnpm-workspace.yaml` enforces `minimumReleaseAge` of 14 days. Pin exact versions.
  - BlockNote 0.57.0: `core`, `react`, `ariakit`, `code-block`, `math-block`, `diagram-block`, `server-util`.
  - Yjs 13.6.x.
  - Hocuspocus 4.x (`server`, `provider`, and its database extension if suitable).
- **Licences:** MIT, Apache or MPL only. BlockNote's MPL needs the maintainer's sign-off, so ask in the first PR's description.
- **Repo process:** follow Primer's CLAUDE.md and changesets, and work from the open PRs (#141 proxy-auth; #142 merged into #143's `live-events`).
- **Security:**
  - The page sandbox stays `allow-scripts` without same-origin, and `connect-src 'none'` stays.
  - Trusted editing controls live in the host only.
  - Text from viewers or data is treated as data, never as instructions.
- **Tests:** minimal and end to end. Prove behaviour, not counts.

## Fidelity and BlockNote-native authoring

1. **Keep as much of BlockNote's functionality as possible.** BlockNote's schema is the canonical model for editable docs. Use its stock blocks, UI, comments, collaboration, and import/export. Write a custom piece only where BlockNote has nothing, and build custom blocks through its custom block API.
2. **Keep as much of the original content and format as possible.**
   - Never lose content silently.
   - Front matter becomes metadata.
   - Constructs BlockNote can't represent stay verbatim as raw source blocks that still render.
   - Imports map to the richest matching block.
3. **Output as similar to input as possible.**
   - Each block keeps the source slice it came from, and the original file is kept.
   - Export re-emits untouched blocks verbatim and serialises only the blocks that changed.
   - An untouched round trip is byte-identical; a one-block edit gives a one-block diff.
4. **A Primer skill for agents,** served via MCP.
   - It teaches agents to author BlockNote-native content so docs are fully editable and render identically. It covers the native format, the block catalogue including Primer's custom blocks, and the widget rules.
   - Arbitrary HTML is still allowed and becomes a page block.
   - Agents edit by block id through semantic ops.
5. **BlockNote's `xl-ai` module (GPL):** borrow ideas only, never code. No `xl-*` package anywhere.

## Decisions from studying BlockNote's AI module (ideas only, no code)
- **Canonical storage** is BlockNote JSON in the Y.Doc, which BlockNote documents as lossless.
- **Markdown import** goes markdown-it → HTML → `tryParseHTMLToBlocks`, which is richer than BlockNote's own Markdown parser. Token `map` line ranges give each block's source slice. markdown-it stays as the single Markdown parser.
- **Agent reads:** `primer_get_doc(format, range?)` returns top-level blocks with real ids plus a version, and optional viewer context (selected blocks and cursor block).
- **Agent writes:** `primer_apply_ops(baseVersion, ops[])` with `add`, `update`, `delete` and `move` by block id. Blocks are given as Markdown, a single HTML element, or BlockNote partial JSON.
  - Atomic in one Yjs transaction, tagged with the agent as origin.
  - Per-op errors with a fix.
  - Returns the changed blocks and the new version, plus a "you wrote / we stored" note.
- **Rebase for fidelity:** an agent edit made through Markdown or HTML is applied to a projection, then mapped back. Colours, comment marks and props the agent never saw survive.
- **Suggestions** are stored proposals rendered with `prosemirror-changeset` (MIT), with an extra pass for changes that touch only marks or attributes.
- **Agent cursor and status** go through Yjs awareness.

## Decisions from the BlockNote plugin survey (v0.57)
- **Comments:**
  - BlockNote's `comment` mark (threadId, orphan) anchors prose and page text in the doc. Postgres stays the source of truth.
  - A Primer `ThreadStore`, modelled on `RESTYjsThreadStore`, writes through the server, which places marks via a direct connection.
  - Deleted text leaves an orphaned thread that keeps its quote. Reactions are supported.
- **Suggestions:**
  - Use `@handlewithcare/prosemirror-suggest-changes` (MIT) marks in the doc, with UUID ids, plus a Postgres metadata table for author and audit.
  - Prototype Yjs coexistence first; stored proposals are the fallback only if that fails.
- **Server:**
  - `ServerBlockNoteEditor` runs with our schema and one shared JSDOM.
  - Reads go through `yDocToBlocks`; writes go through Hocuspocus transactions.
  - Never rebuild a live doc.
- **Versions:**
  - Checkpoints are `encodeStateAsUpdate` behind BlockNote's `VersionStorage` interface, in Postgres.
  - Restore is a new edit; preview uses ForkYDoc; Compare diffs exports.
- **Custom blocks:**
  - Use BlockNote's layout-block and source-with-preview patterns.
  - Multi-column is built ourselves as layout blocks (an idea from `xl-multi-column`, no code).
  - Mentions use the suggestion-menu pattern.
- **Code, math and Mermaid** use BlockNote's MPL packages, lazy-loaded.
- **Uploads:** opaque `primer-blob://` URLs, resolved and authorised at read time.
- **Static render:** `blocksToFullHTML` plus BlockNote's CSS, for shares, email and PDF. One shared headless renderer serves PDF and widget screenshots; this is the main new runtime piece.
- **UI kit:** `@blocknote/ariakit`. **Undo:** yUndo, with a Yjs origin per agent run.
