# Primer Collaboration Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Primer from a store of immutable HTML versions into a live, block-based surface where people and AI agents write, comment, suggest and design together, while legacy HTML versions keep rendering as they do today.

**Architecture:**
- **Content model.** Every new document gets one Y.Doc. BlockNote's schema is the canonical content model, stored as BlockNote content in that Y.Doc (the only lossless format).
  - Markdown imports map to the richest stock BlockNote block. Each block keeps its source slice, so export is byte-identical for untouched blocks.
  - HTML uploads become one custom `page` block. People edit its text through a host overlay, and the text is spliced back into the stamped original.
- **Live sync.** Hocuspocus 4 runs inside the API process on the existing Node server's `upgrade` event at `/collab`. It authenticates with Primer's own resolver chain and persists `bytea` updates plus compacted snapshots in Postgres.
- **One apply pipeline.** Every server write is a ProseMirror transaction applied through one Yjs binding adapter, with synchronous precondition checks, on a per-document serial queue (C4). That covers agent ops by structured `Target`, suggestions, restores, republish merges, page carry-over, branch proposals and run undo. All of them return one reconciliation format (C7).
- **Postgres.** Content, comment marks and suggestion marks live in the Y.Doc. Thread, suggestion and run rows, run inverses, records and per-viewer state live in Postgres.
- **Render bundles.** Each checkpoint is one immutable render bundle, serving shares, previews, print, exports, compare and restore (C11).

**Tech Stack:**
- Server: Node 24, Hono 4, `@hono/node-server` 2, Drizzle + Postgres, vitest.
- Editor and sync: BlockNote 0.57.0 (`core`, `react`, `ariakit`, `code-block`, `math-block`, `diagram-block`, `server-util`), Yjs 13.6.33, `y-prosemirror` 1.3.7, `y-protocols` 1.0.7, Hocuspocus 4.8.0 (`server`, `provider`) with `crossws` 0.4.16.
- Parsing and rendering: parse5 (already present), markdown-it (already present; stays the one Markdown parser).
- Later milestones: `@handlewithcare/prosemirror-suggest-changes@0.1.8` (M5), `fast-diff@1.3.0` (M4), and for M8 `quickjs-emscripten`, `acorn` + `acorn-jsx` (one parser; Primer generates the JSX→`h()` code itself) and `@resvg/resvg-js`.

**Spec:** [`collaboration.md`](collaboration.md). The plan also folds in these design decisions: Markdown fidelity, BlockNote-first, output equal to input, the agent skill, the `xl-ai` ideas, the BlockNote survey, and an independent Codex review of an earlier draft (not in the repo), all adopted. Executors read the spec, this plan, and Primer's `CLAUDE.md`. Primer has no `AGENTS.md`, and `docs/` has no contributor guide beyond `docs/development/events-loop.md`. Conventions below come from the code and CI.

Base branch: `live-events`, which is PR #143 with #142 merged into it. PR #141 (`proxy-auth`) is independent; see Contract C1.

## Global Constraints

**Dependencies**
- `pnpm-workspace.yaml` enforces `minimumReleaseAge: 20160` (14 days) and `strictPeerDependencies: true`. Pin every new dependency exactly, with no `^`.
- Allowed pins (checked 2026-11-19, all older than 14 days):
  - `@blocknote/*@0.57.0` (2026-10-30)
  - `@hocuspocus/server@4.8.0` and `@hocuspocus/provider@4.8.0` (2026-10-28)
  - `yjs@13.6.33` (2026-09-23)
  - `y-prosemirror@1.3.7`
  - `y-protocols@1.0.7`
  - `crossws@0.4.16` (2026-10-23)
  - BlockNote core's own hard pin, `lib0@1.0.0-rc.36` (2026-09-30)
- Never add `@hocuspocus/extension-database`. It stores whole states, and the spec wants an update log.

**Licences**
- MIT, Apache-2.0 or MPL-2.0 only.
- No `@blocknote/xl-*` package may appear in any `package.json`, import or `pnpm-lock.yaml`. `math-block` and `diagram-block` list them only as *optional* peers, so pnpm does not install them.
- `xl-ai` is GPL: borrow ideas only, never code.
- The M1 PR description (the first PR) asks the maintainer to sign off on BlockNote's MPL-2.0.

**Repo process**
- Every PR that touches a workspace package carries a changeset under `.changeset/` (`pnpm exec changeset add`). `@primer/api` and `@primer/web` are a fixed group. API-types changes bump `@polygonlabs/primer-api-types`. MCP changes bump `@polygonlabs/primer-mcp` and `@polygonlabs/plugin-primer`.
- **Shared-file ownership:** each wave gives each shared file one owner (see Waves). A lane that doesn't own a file doesn't edit it.
- Schema changes go through `pnpm db:generate` and are committed with `apps/api/drizzle/meta`.
  - **Migration collision rule:** milestones built in parallel each generate their own migration. When rebasing onto a merged sibling, delete your generated SQL and snapshot, rebase, and run `pnpm db:generate` again. Never hand-renumber.
  - Every new table is added to the truncate list in `apps/api/src/testing/setup.ts`.
- Every new REST route goes into `ROUTE_SCOPES` or `NOT_GRANTABLE` in `apps/api/src/auth/scopes.ts`. `scopes.test.ts` fails otherwise.
- Every new MCP tool goes into:
  - `TOOL_NAMES`, `TOOL_SCOPES` and the schema map in `apps/api/src/mcp/tools.ts`;
  - a REST route that calls the same lib function;
  - a client method plus a tool in `apps/mcp/src/{client,tools}.ts`;
  - `plugins/primer/skills/primer/reference.md`.
- CI order (`.github/workflows/ci.yml`): `pnpm run codegen-drift-check`, `pnpm db:migrate:test`, `pnpm typecheck`, `pnpm -r run build`, `pnpm test`, `pnpm audit --audit-level=high`. All six must pass for every milestone.
- Static files the API reads at runtime (`companion/v1.js`, skill files) are copied in `apps/api/scripts/build.mjs`.
- Workspace packages that point at `.ts` source (`@polygonlabs/primer-api-types`, the new `@primer/blocks`) are bundled there, never external.

**Security**
- The artifact iframe sandbox stays exactly `allow-scripts allow-forms allow-modals allow-downloads`, with no `allow-same-origin`. `connect-src 'none'` stays in `ARTIFACT_CSP`.
- Trusted editing controls (overlay editors, accept/reject, data edits) live only in the host window.
- Text from viewers, comments, records and pages reaches agents fenced as untrusted data, never as instructions.

**Design rules**
- One way: no fallback or dual paths. A replacement deletes the old path in the same milestone.
- BlockNote first: use stock blocks and stock UI (slash menu, formatting toolbar, side menu, table handles, file panel, comments UI, collaboration cursors, HTML/Markdown import and export). Write a custom block, through BlockNote's custom-block API, only where BlockNote has none.
- Output as similar to input as possible. Never lose content silently.

**Tests**
- Minimal and end to end. API tests run in vitest against the `primer_test` Postgres (`pnpm db:up && pnpm db:migrate:test`), serialized.
- Name each test as it is written here.

## Review Focus

These are the likeliest failures no other test pins. Each line names the task that owns its test.

1. **Cross-site WebSocket hijack.** An attacker page opens `wss://primer/collab` with the victim's cookie. The connection is refused unless `Origin` equals the app origin, and bearer connections are read-only. Owner: M2a.4, test `rejects cookie auth from a foreign Origin`.
2. **Revocation mid-session, or a save failure.** A collaborator is removed, or the document is soft-deleted, while their socket is open. Their connection closes within one recheck, and no further update from them persists. Owner: M2a.4, test `closes connections when access is revoked`.
3. **Concurrent agent op and human typing on the same paragraph.** The agent's op returns `target_changed`, and the human's text is kept. Unrelated blocks in the same batch still apply. A cancel racing an apply never half-applies. Owner: M4.2, tests `stale target conflicts, unrelated ops apply` and `cancel racing an apply…`.
4. **A page republish that reorders or rewords elements, or repeats labels** ("Learn more" ×3). Person-edited text stays on the right element. Ambiguous or both-changed cases become suggestions, never a silent carry. Owner: M6.5, tests `three-way carry-over table` and `repeated labels are never carried silently`.
5. **A page that reads records exfiltrating them.** The attack routes are remote scripts, styles or images, `open_external`, and self-navigation. Record-reading pages get the `records` outbound policy and a document-bound capability, and navigation revokes the capability. Owner: M9.3, tests `record-reading page gets the records policy`, `bridge ignores documentId and owner in args`, `frame navigation revokes record access`.

---
## Cross-milestone contracts

Milestones are built by different agents, some in parallel. These names are fixed: the owning milestone implements them and later ones consume them unchanged. API facts were checked against the pinned sources:
- Hocuspocus 4.8 `DirectConnection.transact` wraps the callback in `document.transact(fn, { source: 'local', context })` (`packages/server/src/DirectConnection.ts`).
- `ServerBlockNoteEditor` exposes `.editor.pmSchema` and has the signature `create(options, document?)`.
- BlockNote's `VersionStorage` requires only `list` and `getContent`; `create`, `restore`, `rename` and `remove` are optional.

**C1 Actor (owner M1).**
- **Type.** `AppVariables.user: AuthUser`, where `AuthUser = { id: string; email: string; displayName: string; kind: 'person' | 'agent'; viaUserId: string | null }` (`apps/api/src/app.ts`).
- **Columns.** `users.kind text not null default 'person'` and `users.via_user_id text null references users(id)`.
- **Agent ids.** `agent_<uuidv7>` for minted agents; `agent_oauth_<24 hex of sha256(clientId + ':' + userId)>` for OAuth MCP clients.
- **Label.** The server names every actor through one SQL expression (`actorName` / `actorNameOf(alias)` in `apps/api/src/lib/actors.ts`): an agent always shows as "<name> (via <person>)" (or "<name> (agent)" via no one) in every display name it returns, `AuthUser.displayName` included, so an agent can never pass as a person. Agent and OAuth client names are sanitized (no control or bidi characters, at most 64). *(As built in M1; replaces a client-side `actorLabel` helper after a security review.)*
- **Role.** `loadEffectiveRole(doc: {id; uploaderId; visibility}, actor: AuthUser): Promise<EffectiveRole>` in `apps/api/src/lib/permissions.ts`.
  - An agent gets max(its own role, its via person's role capped at `editor`).
  - A person is `owner` of documents uploaded by their own agents. Those documents appear in the person's library and in `scope: 'mine'`.
- **Resolver chain.** Composition stays in `apps/api/src/index.ts`, so #141's proxy resolver joins whichever PR merges first.

**C2 Versions (owner M1/M2a).** Three distinct values, never mixed:
- `versionNumber` (int): the checkpoint number. The publish precondition is `baseVersionNumber`.
- `docVersion` (int): the id of the latest `doc_updates` row for the document. Every live read returns it.
- `block.version` (16 hex chars): `blockVersion(node)` hashes the block's **whole subtree** (type, props, inline content including mark names and attributes other than `comment`/suggestion marks, and every descendant recursively), so editing a child changes the parent's version. It lives in `apps/api/src/live/blocks.ts`.

**C3 Y.Doc layout and addresses (owner M2a).**
- **Name.** One Y.Doc per document, Hocuspocus name `doc:<documentId>`.
- **Tabs.** `getArray('tabs')` holds `{ id, title }` with `main` first.
  - `main` content is `getXmlFragment('document-store')`; any other tab is `getXmlFragment('tab/<tabId>')`.
- **Address.** `Target = { tabId: string; blockId: string; pid?: string; textId?: string; embedId?: string }` in api-types. `fragmentFor(doc, target)` returns, in this order of precedence:
  - `page/<blockId>/<pid>` when `pid` is set (M6);
  - `embed/<blockId>/<embedId>` when `embedId` is set (M6);
  - `widget/<blockId>/<textId>` when `textId` is set (M8);
  - otherwise the tab fragment.
  
  Every op, anchor, read and overlay uses `Target`; no string ids like `blockId#pid`.
- **Other keys.** `getMap('sources')` holds Markdown source groups (M2b); `getMap('meta')` holds `{ format, frontMatter }`.
- **Reachability.** `reachableFragments(doc): string[]` (`live/reach.ts`) lists:
  - every tab fragment;
  - the `page/…`, `embed/…` and `widget/…` fragments referenced by the current page sources, embeds and published widgets.
  
  Fragments left behind by republishes remain in the Y.Doc but are unreachable.
- **In the Y.Doc:** content, comment marks and suggestion marks (M5).
- **In Postgres:** thread, comment, reaction and suggestion rows, runs, run inverses, per-viewer state and records.

**C4 One apply pipeline (owner M2a; used by imports, republishes, ops, suggestions, restores, page carry-over, branch proposals and undo).**
- **Why ProseMirror.** BlockNote drops `blocknoteIgnore` marks (comments, suggestions) from Block JSON (`packages/core/src/api/nodeConversions/nodeToBlock.ts:241`). So every write is a ProseMirror transaction on the target fragment, bound to Yjs through one adapter. Untouched nodes keep their marks and their Y items.
- **Module.** `apps/api/src/live/pipeline.ts`.
- **Types.**
  ```ts
  type LiveOrigin = { kind: 'person'|'agent'|'system'; actorId: string; runId: string | null };
  type PlannedEdit = { target: Target; expectVersion?: string; build: (tr: Transform, at: Located) => void; inverse: boolean };
  type Located = { pos: number; node: PmNode } | null;
  applyPlan(documentId: string, origin: LiveOrigin, plan: { edits: PlannedEdit[]; onConflict: 'refuse' | 'suggest' }): Promise<Reconciliation>;
  ```
- **Phases, in this order.**
  1. *Async preparation, before any mutation.* The caller converts all input (Markdown and HTML go to nodes through `serverEditor().editor.pmSchema`) and validates the shapes.
  2. *Serialised step.* Enqueue on `docQueue(documentId)`, the one per-document serial queue that persistence, compaction and checkpoint capture also use.
  3. *Synchronous mutation.* Inside one `DirectConnection.transact` (outer origin `{ source: 'local', context: origin }`): recheck every precondition against the live fragment; build one ProseMirror `Transform` per fragment; compute inverses (prior subtree JSON plus its version) for `inverse: true` edits; call `updateYFragment(doc, fragment, tr.doc, { mapping: new Map(), isOMark: new Map() })`. Nothing async runs here; exceptions abort before the first `updateYFragment`.
  4. *Wait for persistence.* Await the queued `doc_updates` insert, then write the run inverses (`run_inverses`, M4) and the `docVersion`.
- **Attribution.** `originOf(tr.origin): LiveOrigin` (`live/origin.ts`) reads `context` for `source: 'local'`, `connection.context.user` for `source: 'connection'`, and `system` otherwise. Stable identity is `(actorId, runId)`, never object identity.
- **Read helpers.**
  - `readBlocks(doc, tabId)` uses `yDocToBlocks` (reads only).
  - `serverEditor()` returns one `ServerBlockNoteEditor.create({ schema: primerSchema }, sharedDocument)`, with `sharedDocument` from `@blocknote/server-util/dom`.
  - `blocksToYDoc` is used only for a document's first import.

**C5 Shared schema (owner M2a).** The private workspace package `packages/blocks` (`@primer/blocks`) exports `primerSchema`: every stock block, plus `codeBlock` from `@blocknote/code-block`, math, Mermaid, and Primer's custom blocks as they land. Custom blocks use BlockNote's patterns:
- `source`, `page` and `widget`: source-with-preview / `renderFrame`;
- `choice`, `task` and `callout`: the prop-driven alert pattern;
- `columnList`/`column`: layout blocks.

UI-only view state stays out of the document.

**C6 Anchors (owner M3; api-types change).**
- **Mark anchors.** `ProseAnchor {type:'prose'; target: Target; quote}`. Its live anchor is BlockNote's `comment` mark in the fragment named by `target`, so the same type covers page text, embeds and widget labels.
- **Structured anchors.** `WidgetPartAnchor {type:'widget-part'; target; anchor}`, `DataPointAnchor {type:'data-point'; target; row; column}` and `BlockAnchor {type:'block'; target}` stay structured rows.
- **Validation.** `isValidAnchor` validates all of them.

**C7 Reconciliation result (owner M4; one format for ops, republish merges, page carry-over, branch proposals and run undo).**
```ts
type EditOutcome = { index: number; target: Target; status: 'applied' | 'conflict' | 'suggested' | 'unchanged'; blocks?: LiveBlockDTO[]; suggestionId?: string; refusal?: Refusal; note?: string };
type Reconciliation = { docVersion: number; outcomes: EditOutcome[] };
```
`Refusal = { code; message; fix; details? }` (M1 shape). Codes are added per milestone, and each milestone names its own.

**C8 Lifecycle events.** Each milestone adds its own types to `PrimerEventPayloads`, carrying ids only.

**C9 Bridge and overlay (owner M6).**
- **Bridge.** `/companion/v1.js` stays the one bridge. Changes are additive and gated by `init.features: ('page-text'|'embeds'|'records')[]`.
- **Overlay.** One host overlay, `apps/web/src/live/Overlay.tsx`, handles positioning, focus, comments and editing for any `Target` that has a sub-fragment (page text, embeds, widget labels).

**C10 Live read format (owner M4).**
- `LiveBlockDTO = { target: Target; type; version; markdown?; html?; json?: PartialBlock; depth; parentId }`.
- `LiveDocDTO = { documentId; docVersion; at; format; blocks; viewer? }`.

**C11 Render bundle (owner M2b).** One immutable bundle per checkpoint, stored at `bundles/<versionId>/`. Its `manifest.json` lists:
- `state.ydoc`: the frozen state, captured synchronously in the queue.
- `export.<md|txt|html>`
- `static.html`: the static rendering.
- `pages/<blockId>.html`: stamped page sources (M6).
- `widgets/<widgetId>.<light|dark>.svg` (M8).
- `files.json`: the file ids referenced.
- `records.json`: shared-records snapshot (M9).
- `threads.json`: open threads with their quotes and comment counts at capture, so a checkpoint keeps its discussion context.

Shares, previews, print, exports, compare and restore all read the bundle. `versions.bundle_key` replaces separate keys; `versions.storage_key` points at `static.html`, so the content route is unchanged.

**C12 Copy policies (owner M10c; restore owner M2b).**

| what | restore | branch | fork/template |
|---|---|---|---|
| tab, page, embed and widget fragments | from bundle | copied | copied |
| comment and suggestion marks | as in bundle (missing rows → orphaned) | re-created: new rows copied, ids rewritten | stripped |
| `widgets` rows | republished from bundle SVG and source | copied with new ids | copied with new ids |
| `doc_files` | kept (never deleted) | rows copied, `primer-blob://` ids rewritten | same as branch |
| records | untouched (not versioned) | none | shared copied, personal not |
| data bindings (block props) | from bundle | copied | copied |

## Legacy documents (decision)

- **Existing documents** get `documents.format = null` and remain version-only HTML. Their versions render through `/api/versions/:id/content` unchanged, and their threads carry over as today. They are not converted, because only rendered HTML is stored for them.
- **New Markdown version on a legacy document (after M2b).** The document becomes a live Markdown document, and its open threads are re-anchored by quote. Any thread whose quote is not found is orphaned, never dropped.
- **New HTML version (after M6).** The document becomes a live page document.
- **Between M2b and M6,** HTML publishes stay on the legacy path.

## Waves, dependencies and shared-file ownership

Dependencies:
- **Core chain:** M1 → M2a → M2b → M2c → M3 → M4 → M5.
- **M6:** needs M3, M4 and M5.
- **M8:** needs M6.
- **M9:** needs M1 and M2a.
- **M9b:** needs M8 and M9.
- **M10a:** needs M2c and M9.
- **M10b:** needs M5 and M6.
- **M10c:** needs M5.
- **M10d:** needs M2c.
- **M10e:** needs M1.

**One owner per shared file per wave.** The shared files are:
- server: `apps/api/src/db/schema.ts` with its migrations and `testing/setup.ts`; `packages/api-types/src/index.ts`; `apps/api/src/auth/scopes.ts`; `apps/api/src/mcp/tools.ts` and `apps/mcp/*`;
- bridge: `apps/api/src/companion/v1.js` and `apps/web/src/companion/protocol.ts`;
- web: `apps/web/src/routes/document.tsx` and `apps/web/src/live/LiveEditor.tsx`;
- `packages/blocks/src/schema.ts`.

A lane that doesn't own a file may not edit it in that wave. Its schema rows, types and scope rows land in the owning milestone of an earlier wave. That is why M2a carries all of M2's migrations, types and scope rows.

| Wave | Lanes, each merged in order | Owns |
|---|---|---|
| W1 | M1 | everything |
| W2 | **A:** M2a | schema/migrations/setup, api-types, scopes, packages/blocks, `app.ts`/`index.ts`, lockfile |
| | **B:** M10e | mcp/tools.ts, apps/mcp, `routes/collaborators.ts` |
| W3 | **A:** M2b → M2c | document.tsx, LiveEditor.tsx, `lib/publish.ts`, `routes/documents.ts`, `live/*` (except `live/pipeline.ts`, frozen after M2a) |
| | **B:** M9 | schema/migrations/setup, api-types, scopes, mcp/tools.ts, apps/mcp, v1.js, protocol.ts, `versionContent.ts`, `records/*` |
| W4 | **A:** M3 → M4 → M5, small dependent PRs developed together | all server shared files, document.tsx, LiveEditor.tsx, packages/blocks, plugin skill |
| W5 | **A:** M6 | v1.js, protocol.ts, `ArtifactIframe.tsx`, `sanitize.ts`, document.tsx, LiveEditor.tsx, packages/blocks, `page/*`, `live/Overlay.tsx` |
| | **B:** M10c | schema/migrations/setup, api-types, scopes, mcp/tools.ts, apps/mcp, `routes/documents.ts`, `HeaderActions.tsx` |
| W6 | **A:** M8 | schema/migrations/setup, api-types, scopes, mcp/tools.ts, apps/mcp, packages/blocks, `widgets/*` |
| | **B:** M10d | document.tsx, LiveEditor.tsx, web chrome, `apps/web/src/i18n/*`, `routes/share.tsx`, print route |
| W7 | **A:** M9b → M10a | packages/blocks, schema/migrations/setup, api-types, scopes, mcp/tools.ts, apps/mcp |
| | **B:** none | M10b would collide on server shared files |
| W8 | **A:** M10b | all server shared files, document.tsx, packages/blocks |

In W2 lane B, M10e needs no schema changes: agent identity comes from M1.

M10 is split into five PRs because the repo's `CLAUDE.md` sizes work as one session per issue.

## Ambiguities resolved (simplest option chosen)

1. **Comment anchors (a spec deviation, decided during planning).** BlockNote's `comment` mark is the anchor of record.
   - The client sends the selection as Yjs relative positions. The server writes the mark through the pipeline, so people and agents share one path.
   - When the mark is gone from reachable content, the thread is orphaned and keeps its quote.
2. **Ops batch semantics.** A malformed op rejects the whole batch, with per-op errors. A valid op whose target is stale becomes a `conflict`, or a suggestion if `onConflict:'suggest'`. The other ops still apply.
3. **Run undo is durable.** Each applied agent edit stores its inverse in Postgres. Undo applies the inverses through the pipeline, with preconditions. A block changed since the run becomes a conflict, which turns into a suggestion. Fragments the run created are tracked and removed.
4. **Page splice is on demand,** not on idle: at export, at checkpoint and on agent reads.
5. **Threads on checkpoints.** Live threads belong to the live document. A checkpoint view shows `threads.json` from its bundle, read-only.
6. **OAuth MCP clients are agents** (`agent_oauth_*`, via the person).
7. **Localisation** covers BlockNote's editor and Primer's own chrome strings (M10d).
8. **Warehouse queries** arrive as records collections `query:<name>`, written over MCP by an external integration (for example an agent fleet such as AidenHQ).
9. **Agent mode** defaults to `auto`: an agent edits documents it owns and suggests everywhere else.
10. **No headless browser** (a deviation from survey decision 8). Widget previews use QuickJS plus resvg, with bounded work. Static pages, shares and email use the bundle's `static.html`. PDF is the browser's print.
11. **Suggestion storage is decided once,** by the spike that is M5's first task.
    - The primary design: suggest-changes marks in the Y.Doc, with metadata rows in Postgres.
    - If the spike fails, M5 ships stored proposals instead and nothing else changes: both produce `suggestionId`s in C7.
12. **Fuzzy matching** applies to live re-anchoring (M10b) and page pid matching (M6). Ambiguous matches are never carried silently. Legacy `threadCarry.ts` stays exact.
13. **markdown-it stays** as the one Markdown parser. Only the Markdown-to-HTML version path is removed.
14. **Republish onto a live document** is refused with `republish_unsupported` until M5. M5 replaces the refusal with the three-way merge, because "both changed" needs suggestions. This keeps the plan free of a temporary conflict-as-comment path.
15. **Residual risk.** A sandboxed frame can still navigate *itself* to a remote URL, and no CSP directive blocks that today.
    - On a record-reading page, the host treats any frame navigation (a second `load` event without a bridge handshake) as a breach. It revokes that frame's record capability and reloads the page from Primer.
    - **Accepted, not blocked:** a record-reading page can still leak data it has already read by navigating, and the leak can repeat. A navigation that gets a 204 response, or that turns into a download, never fires a second `load` event, so the breach check and the reload do not run; the page's script keeps its capability and can do it again. The owner accepted this on 2026-11-19. It is documented in `docs/prd-primer.md` and is not prevented.

---
## M1: Foundations

Ships: originals kept for every publish; REST and MCP publish through one function with an atomic `baseVersionNumber` check; agents are first-class identities replacing `service-claude`; agents can't resolve threads people wrote in; the artifact CSP becomes a function ready for M9. No UI beyond the Agents settings section.

### Task M1.1: One publish path with originals and an atomic base check

**Files:**
- Create: `apps/api/src/lib/publish.ts`, `apps/api/src/lib/publish.test.ts`
- Modify: `apps/api/src/routes/upload.ts`, `apps/api/src/routes/documents.ts:355-484`, `apps/api/src/mcp/tools.ts:482-655` (create/add version handlers and schemas), `apps/api/src/db/schema.ts` (`versions`), `apps/api/src/upload/validate.ts` (accept `.txt` as `text/plain`), `apps/mcp/src/{client,tools}.ts`, `packages/api-types/src/index.ts`
- Delete: `apps/api/src/lib/publishVersion.ts` (absorbed)

**Interfaces:**
- Produces:
  - `versions.original_key text` (storage key `v1/<versionId>.orig`), `versions.source_format text` (`'html'|'markdown'|'text'`, null for legacy rows).
  - `type PublishInput = { actor: AuthUser; documentId?: string; title?: string; description?: string | null; content: Uint8Array; filename: string; format: 'html'|'markdown'|'text'; versionNote?: string | null; baseVersionNumber?: number }`
  - `publishDocument(storage: Storage, input: PublishInput): Promise<{ ok: true; documentId; versionId; versionNumber } | { ok: false; status: 400|403|404|409; refusal: Refusal }>`
  - `Refusal`, `RefusalCode` (initial `'stale_base'|'forbidden'|'not_found'|'bad_request'`) in api-types.
  - REST: `POST /api/documents/:docId/versions` accepts form field `baseVersionNumber`; MCP `primer_add_version` accepts `baseVersionNumber`.
- Consumes: `transactionWithEvents`, `carryOpenThreads`, `loadCarryOrigins` (unchanged).

Decision: the base check and next number run inside the transaction after `SELECT … FROM documents WHERE id = $1 FOR UPDATE`; the `versions_doc_version_unique` race path (`version_race`) is deleted. Markdown docs still render through markdown-it here; M2b replaces that branch.

- [ ] **Step 1: Write failing tests** in `publish.test.ts`:
  - `stores the uploaded bytes verbatim as the original`: publish markdown `"# Hi\n"` → `storage.get(original_key)` bytes equal input; `source_format === 'markdown'`.
  - `stale baseVersionNumber is refused`: doc at v2, publish with `baseVersionNumber: 1` → `{ok:false, status:409, refusal.code:'stale_base'}` and `refusal.fix` contains `"2"`; no version row added.
  - `concurrent publishes on the same base: exactly one wins`: two `Promise.all` publishes with `baseVersionNumber: 1` → one ok, one `stale_base`.
  - `REST and MCP produce identical stored HTML`: same markdown via `POST /api/upload` and `primer_create_document` → stored version bytes equal (pins the dropped `themeManaged` on MCP).
- [ ] **Step 2:** `pnpm --filter @primer/api exec vitest run src/lib/publish.test.ts` → FAIL (`publishDocument` missing).
- [ ] **Step 3:** Implement `publishDocument`; make `routes/upload.ts`, `routes/documents.ts` and both MCP handlers thin adapters over it; `pnpm db:generate`.
- [ ] **Step 4:** Run the file plus `src/routes/upload.test.ts src/routes/documents.test.ts src/mcp/tools.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(api): one publish path keeps originals and checks the base version`.

### Task M1.2: Agent identities

**Files:**
- Create: `apps/api/src/routes/agents.ts`, `apps/api/src/routes/agents.test.ts`, migration via `pnpm db:generate` plus a hand-written data step in the same SQL (`UPDATE users SET kind='agent' WHERE id='service-claude'`)
- Modify: `apps/api/src/db/schema.ts` (`users`), `apps/api/src/app.ts` (`AppVariables.user` → `AuthUser`), `apps/api/src/auth/{bearer.ts,resolver.ts,session.ts}` and `auth/oauth/bearer.ts` (select `kind`, `via_user_id`), `apps/api/src/lib/permissions.ts`, every `effectiveRole(`+`loadCollaboratorRole(` call site (27, in `mcp/tools.ts`, `lib/events.ts`, `routes/{comments,versions,documentFolder,threads,documents,versionContent,externalShareAdmin,collaborators}.ts`), `apps/web/src/routes/settings-tokens.tsx` (Agents section replaces Service tokens), `packages/api-types/src/index.ts` (`CommentDTO.authorKind`, `CommentDTO.authorVia: string | null`; display names arrive labelled, see C1)
- Delete: `apps/api/src/routes/serviceTokens.ts` + test, `SERVICE_USER_ID`. The row becomes an agent with `via_user_id` null; *as built*, the migration also revokes its live tokens, because with the service-token routes gone nobody could list or revoke them.

**Interfaces:**
- Produces: C1 in full. Routes (session-only, `NOT_GRANTABLE`): `GET /api/agents` (agents whose `via` is me), `POST /api/agents {displayName}` → `{id}`, `POST /api/agents/:agentId/tokens {name, scopes}` (mint, `via` must be me; scopes required), `DELETE /api/agents/:agentId/tokens/:tokenId`.
- `ensureOAuthAgent(clientId: string, clientName: string, userId: string): Promise<AuthUser>` in `auth/oauth/bearer.ts`; the OAuth resolver returns the agent.

- [ ] **Step 1: Failing tests** (`agents.test.ts`):
  - `minted agent token authenticates as the agent with via`: `GET /api/me` with it → `{kind:'agent', viaUserId:'mock-user-1'}`.
  - `agent inherits its person's access capped at editor`: doc owned by mock-user-1; agent of mock-user-1 → can add version; `PATCH visibility` and `DELETE` → 403.
  - `oauth token acts as a per-client agent`: issue OAuth token for mock-user-1 → `/api/me` id starts `agent_oauth_`, `displayName` = client name.
  - `a person owns what their agent created`: agent of mock-user-1 creates a doc → mock-user-1 can delete it, share it, and sees it under `mine`.
  - `comments carry the agent label`: agent comments → thread DTO `authorKind:'agent'`, `authorVia:'Mock User'`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; replace all 27 role call sites with `loadEffectiveRole`. **Step 4:** `pnpm --filter @primer/api test` → PASS (whole suite, since call sites moved).
- [ ] **Step 5: Commit** `feat(api): agents are their own identities, acting via a person`.

### Task M1.3: Agents never resolve a person's thread

**Files:** Modify `apps/api/src/routes/threads.ts:205-230,485-514` (`authorizeThreadMutation`); Test `apps/api/src/routes/threads.test.ts`.

Rule: when `actor.kind === 'agent'`, resolve/reopen is allowed only if no comment in the thread (deleted ones included) was written by a `person`; otherwise 403 with refusal `{code:'forbidden', fix:'Reply in the thread and ask a person to resolve it.'}`. Persons keep today's rule.

- [ ] **Step 1: Failing tests:** `agent cannot resolve a thread a person wrote in` (agent owns the doc, person comments → 403); `agent can resolve a thread only agents wrote in` → 200; `MCP primer_resolve_thread returns the refusal fix`.
- [ ] **Step 2–4:** run → FAIL; implement; run → PASS.
- [ ] **Step 5: Commit** `fix(api): agent tokens can't resolve threads people wrote in`.

### Task M1.4: Outbound policy for pages

**Files**
- Create: `apps/api/src/lib/pagePolicy.ts`.
- Modify: `apps/api/src/routes/versionContent.ts:10-31`, plus the files that import from it: `externalShare.ts` and `devFixture.ts`.
- Test: `apps/api/src/lib/pagePolicy.test.ts`.

**Produces:** `type PagePolicy = 'standard' | 'records'` and `artifactCsp(policy: PagePolicy): string`. Delete the `ARTIFACT_CSP` constant.
- **`standard`** returns today's string byte for byte.
- **`records`** is the complete outbound policy for pages that read records:

  ```
  default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline' blob:; img-src data: blob:; font-src 'self' data: blob:; media-src 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'
  ```

  It allows no remote scripts, styles or images.
- **Bridge features.** `pageBridgeFeatures(policy)` is consumed by the host. For `records` it turns off `open_external` and the forwarding of anchor navigation; the host ignores those messages from such pages.

Until M9, every caller passes `'standard'`.

- [ ] **Step 1: Write the failing tests**
  - `standard policy is unchanged`: the output equals the old constant.
  - `records policy allows no remote origin`: no directive contains `https:`, `http:` or a host name.
  - `records policy disables open_external`.
- [ ] **Step 2–4.** Run the tests and watch them fail, implement, then run them again.
- [ ] **Step 5: Commit** `feat(api): per-page outbound policy`.

**M1 verification:** `pnpm typecheck && pnpm test && pnpm run codegen-drift-check && pnpm audit --audit-level=high` → all green. The M1 PR description asks the maintainer for MPL-2.0 sign-off on BlockNote (spec: first PR); M2a is not merged without it. Changeset: api/web minor, api-types minor, mcp + plugin minor ("service tokens become agents").

---

## M2a: Live foundations (contracts, persistence, auth)

Ships: the dependencies, the shared schema package, every M2 migration, type and scope row, the apply pipeline (C4), Y.Doc persistence, and Hocuspocus with Primer auth.

No user-visible change yet. It is exercised by tests and by a dev-only fixture document.

### Task M2a.1: Dependencies, schema package, licence gate

**Files**
- Create:
  - `packages/blocks/{package.json,tsconfig.json,src/index.ts,src/schema.ts,src/source.tsx}`
  - `scripts/check-no-xl.mjs`
- Modify:
  - `apps/api/package.json`. Add, at exact versions:
    - BlockNote 0.57.0 packages: `core`, `server-util`, `code-block`, `math-block`, `diagram-block`, `react`;
    - `yjs@13.6.33`, `y-prosemirror@1.3.7`, `y-protocols@1.0.7`;
    - `@hocuspocus/server@4.8.0`, `crossws@0.4.16`;
    - `react` and `react-dom` at web's versions;
    - `jsdom@29.1.1`, moved to dependencies;
    - `@primer/blocks: workspace:*`.
  - `apps/web/package.json`: the same BlockNote set, plus `@blocknote/ariakit@0.57.0`, `@hocuspocus/provider@4.8.0`, `yjs` and `@primer/blocks`.
  - `apps/api/scripts/build.mjs`: bundle `@primer/blocks`.
  - The root `codegen-drift-check` runs `check-no-xl.mjs`.

**Interfaces.** C5 `primerSchema`, with the `source` block:
- Props: `{ markdown: string; previewHtml: string }`.
- `previewHtml` is computed by the server at import: markdown-it with `html: true`, then `sanitizeUploadedHtml` with scripts removed.
- It renders that preview in an `<iframe sandbox="" srcdoc>` (opaque origin, no scripts). A "Source" toggle shows the raw text, which is editable.

**Steps**
- [ ] **Test `check-no-xl fails on any xl package`.** A lockfile naming `@blocknote/xl-ai` exits with 1.
- [ ] **Install.** `pnpm install` passes `strictPeerDependencies`, `node scripts/check-no-xl.mjs` exits with 0, and `pnpm audit --audit-level=high` is clean.
- [ ] **Test `schema has stock blocks plus source`.**
- [ ] **Commit** `build: BlockNote, Yjs and Hocuspocus (MPL/MIT) and the block schema package`.

### Task M2a.2: Schema rows, types and scopes for all of M2

**Files**
- `apps/api/src/db/schema.ts`
- `apps/api/src/testing/setup.ts`
- `packages/api-types/src/index.ts`
- `apps/api/src/auth/scopes.ts`
- Migration via `pnpm db:generate`

**Interfaces**

Tables:
- `doc_updates`:
  - columns: `id bigserial pk`, `document_id uuid fk cascade`, `update bytea null`, `actor_id text null fk users`, `run_id uuid null`, `touched text[] not null default '{}'`, `created_at`;
  - index on `(document_id, id)`;
  - `update` is set to null after compaction.
- `doc_snapshots`: `document_id uuid pk fk cascade`, `state bytea not null`, `upto_update_id bigint not null`, `updated_at`.
- `doc_files`: `id uuid pk`, `document_id fk cascade`, `storage_key`, `content_type`, `size_bytes`, `uploaded_by`, `created_at`.

Columns:
- `documents.format text null`, `documents.metadata jsonb not null default '{}'`, `documents.agent_mode text not null default 'auto'`.
- `versions.bundle_key text null`, `versions.doc_version bigint null`.

Types:
- C2, C3 `Target`, the `.txt` upload format, checkpoint DTOs.

Scope rows:
- `GET /api/documents/:docId/export`: `documents:read`.
- `POST /api/documents/:docId/checkpoints`: `documents:write`.
- `GET /api/versions/:versionId/ydoc`: `documents:read`.
- `POST /api/versions/:versionId/restore`: `documents:write`.
- `POST /api/documents/:docId/files`: `documents:write`.
- `GET /api/files/:fileId`: `documents:read`.

Wave W3 lane A may not edit these files.

**Steps**
- [ ] **Run** `pnpm db:generate && pnpm db:migrate:test`. Expect a clean run.
- [ ] **Run** `scopes.test.ts`. It passes because the new rows have no routes yet.
- [ ] **Commit** `feat(api): schema and contracts for live documents`.

### Task M2a.3: Apply pipeline, persistence and queue

**Files**
- Create:
  - `apps/api/src/live/{pipeline.ts,origin.ts,queue.ts,persist.ts,blocks.ts,editor.ts,reach.ts}`
  - Tests beside each file.

**Interfaces**
- C4 in full.
- `docQueue(documentId: string): <T>(job: () => Promise<T>) => Promise<T>`. One serial queue per document, shared by persistence, compaction, checkpoint capture and `applyPlan`.
- `loadYDoc(documentId): Promise<{ doc: Y.Doc; docVersion: number }>`.
- `attachPersistence(doc, documentId): () => Promise<void>`. On every `update` it enqueues an insert of `{ update, actor_id, run_id, touched }`.
  - Actor and run come from `originOf`.
  - `touched` comes from the `afterTransaction` changed types: ancestor `blockContainer` ids, plus the names of any non-tab fragments.
- `compact(documentId)`: a queue job that runs above 500 uncompacted rows.
- `blockVersion(node: PmNode): string`: the recursive subtree hash from C2.

**Steps**
- [ ] **Write the failing tests:**
  - `updates round-trip through snapshot and log`.
  - `a write to block A leaves a comment mark in block B intact`.
  - `origin from a DirectConnection context is attributed` (the stored row has `actor_id` and `run_id` from the context).
  - `editing a child changes the parent's version`.
  - `a precondition failure leaves the document untouched` (a stale version → no `doc_updates` row).
  - `compaction never interleaves with an append`: run 1,000 concurrent appends and a compaction, then reload; the state equals the in-memory doc.
- [ ] **Run, implement, run.**
- [ ] **Commit** `feat(api): one apply pipeline over a persisted Y.Doc`.

### Task M2a.4: Hocuspocus in the API with Primer auth

**Files:** Create `apps/api/src/live/hub.ts`, `apps/api/src/live/auth.ts`, `apps/api/src/live/hub.test.ts`; Modify `apps/api/src/index.ts` (attach upgrade), `apps/api/src/app.ts` (`AppDeps.hub?`), `apps/web/vite.config.ts` (`'/collab': { target: 'ws://localhost:3000', ws: true }`), `apps/api/src/routes/collaborators.ts` + `routes/documents.ts` (revocation calls).

**Interfaces:**
- `resolveFromHeaders(resolver: UserResolver, headers: Headers): Promise<{ user: AuthUser; authMethod: 'bearer'|'cookie'|'mock'; scopes?: readonly ApiTokenScope[] } | null>` (`live/auth.ts`): runs the existing resolvers against a minimal context shim (`req.header`, `set`, `get`).
- `createHub(deps: { resolver: UserResolver; appOrigin: string }): { hocuspocus: Hocuspocus; handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void; recheckDocument(documentId: string): Promise<void> }` (`live/hub.ts`). Uses the `Hocuspocus` class plus `crossws/adapters/node` exactly as Hocuspocus's own `Server.ts` does, but on the API's server: `server.on('upgrade')` for path `/collab` only.
- Auth rules in `onAuthenticate`: session, PAT and OAuth all authenticate (spec); bearer connections are always `readOnly` (agents write only through ops) and need `documents:read` when scoped; cookie/mock/proxy → require `Origin === appOrigin` (`AUTH_BASE_URL` origin; dev `http://localhost:5173`); document name must be `doc:<uuid>` of a live, non-deleted doc; role via `loadEffectiveRole`: stranger → reject; `owner|editor` → read-write; anyone else → `connectionConfig.readOnly = true`. Context `{ user, documentId }`.
- `recheckDocument(documentId)` re-evaluates each connection's role and closes those that lost read, flips write → read-only; called after collaborator removal, visibility change and soft delete; plus a 60 s interval recheck.
- Persistence failure (an insert throws) closes that document's connections with code `4500 save_failed`.
- [ ] **Step 1: Failing tests** (real ws via `@hocuspocus/provider` against an in-test server): `editor syncs and the update persists`; `commenter connection is read-only` (its edit doesn't persist); `rejects cookie auth from a foreign Origin`; `bearer connections are read-only`; `closes connections when access is revoked` (remove collaborator → socket closed, later updates not stored); `save failure closes with save_failed`; `proxy-auth headers authenticate` (skip until #141 merges; uses `makeProxyResolver`).
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): Hocuspocus live sync inside the API with session auth`.

---

## M2b: Live Markdown and text documents

Ships:
- Markdown and `.txt` uploads, over REST and MCP, create live documents edited in BlockNote.
- Checkpoints are immutable render bundles. Restore goes through the pipeline.
- Export reproduces the input byte for byte when nothing changed.
- Republishing onto a live document is refused (`republish_unsupported`) until M5.

### Task M2b.1: Import with fidelity (Markdown and .txt)

**Files:** Create `apps/api/src/live/import.ts`, `apps/api/src/live/import.test.ts`, fixtures `apps/api/src/live/__fixtures__/{readme.md,changelog.md,adr.md,notes-gfm.md,html-and-footnotes.md,plain.txt}` (real-world shaped: tables, task lists, nested lists, code fences, front matter, raw HTML, footnotes, GitHub alerts); Modify `apps/api/src/upload/markdown.ts` (keep the gray-matter + markdown-it setup; export the tokenizer; the HTML-document wrapper is deleted in M2b.6).

**Interfaces:**
- `importMarkdown(source: string): Promise<{ blocks: Block[]; sources: Map<string, SourceEntry>; frontMatter: string; metadata: Record<string, unknown> }>`
- `importText(source: string): { blocks: Block[]; sources: Map<string, SourceEntry> }`
- `type SourceEntry = { slice: string; gap: string; groupIds: string[]; version: string; refs: string[] }` (`version` = recursive hash of the whole group; `refs` = reference-definition labels the group uses, collected from markdown-it's `env.references` lookups while rendering it).

Algorithm (pinned):
1. `gray-matter` (existing safe engines) splits `frontMatter` raw text (including fences) and `metadata`.
2. Tokenize the body with the existing markdown-it instance configured `html: true` (tokens only; never render raw HTML into the page). Group tokens into top-level nodes by nesting level 0; each group's `map` = `[startLine, endLine)` gives its `slice` (exact source lines) and `gap` (lines up to the next group's start).
3. For each group: if it contains `html_block`/`html_inline` tokens or footnote syntax (`[^`), or a text check fails, emit one `source` block `{markdown: slice, previewHtml}`. Otherwise render that group's tokens with `md.renderer.render(groupTokens, md.options, env)` using the whole document's `env` (keeps reference-style links) and convert with `ServerBlockNoteEditor.tryParseHTMLToBlocks` (richest stock block: tables, check lists, code with language, quotes, images). GitHub alerts (`> [!NOTE]`) map to a `quote` with the alert line kept until M10d adds `callout`.
4. **Fidelity arbiter (runs at every import, not just in tests):** `normalizeText(textContent(renderedHTML)) === normalizeText(blocksPlainText(blocks))` (whitespace collapsed); on mismatch the group becomes a `source` block.
5. `.txt`: split on blank lines; each paragraph is a `paragraph` block with hard breaks; `slice`/`gap` as in Markdown.
6. `sources` keys are the first block id of each group.
- [ ] **Step 1: Failing tests:** `no text is dropped from real-world samples` (for every fixture: every word of the source body appears in exported Markdown of the imported blocks, or inside a source block); `raw HTML and footnotes become source blocks with a rendered preview`; `front matter is parsed into metadata and kept raw`; `tables, task lists and code fences map to stock blocks` (block types asserted).
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): Markdown and text import keep every byte of content`.

### Task M2b.2: Export that equals the input

**Files:** Create `apps/api/src/live/export.ts`, `apps/api/src/live/export.test.ts`.

**Interfaces:** `exportMarkdown(doc: Y.Doc): Promise<string>`, `exportText(doc: Y.Doc): string`, `exportHtml(doc: Y.Doc): Promise<string>` (static rendering, used for the bundle's `static.html`: `blocksToFullHTML` inside `<div class="bn-root bn-container">` with BlockNote's stylesheet inlined; one function used by checkpoints, external shares and email digests; M6 adds page splicing). PDF is the browser's print of this HTML; no server headless browser.

Algorithm (pinned): output = `meta.frontMatter` + for each top-level group in document order: if the group's current blocks all exist, are contiguous, their recursive group version equals `sources[firstId].version`, and every group defining a label in `refs` is itself verbatim, emit `slice + gap` verbatim; else emit `blocksToMarkdownLossy(groupBlocks)` + `"\n\n"` (new blocks with no source entry likewise). A `source` block whose `markdown` prop is unchanged is verbatim by the same rule.
- [ ] **Step 1: Failing tests:** `untouched round trip is byte-identical` (every M2b.1 fixture: import → export === input); `editing one block changes only its lines` (edit a paragraph through `applyPlan` → line diff of export vs input touches only that paragraph's line range); `editing a child item re-serialises its list group`; `editing a reference definition re-serialises the groups that use it`; `.txt round trip is byte-identical`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): export re-emits untouched source verbatim`.

### Task M2b.3: Live documents through the one publish path

**Files**
- `lib/publish.ts`.
- `live/import.ts`: first import uses `blocksToYDoc` then applies it as one system-origin `DirectConnection.transact`.
- `routes/documents.ts`.

**First publish**
- Create the Y.Doc, the `sources` and `meta` entries, and checkpoint v1.

**Republish onto a live document**
- Refused with `{ code: 'republish_unsupported', fix: 'Edit with primer_apply_ops; republish arrives with suggestions.' }`. M5 replaces this refusal.

**Legacy Markdown documents**
- Convert them, then re-anchor their threads by exact quote; threads whose quote isn't found are orphaned.

**Tests**
- `markdown upload creates a live document with checkpoint 1`.
- `legacy Markdown doc converts and re-anchors open threads by quote`.

**Commit** `feat(api): Markdown documents are live`.

### Task M2b.4: Checkpoints as render bundles; restore

**Files**
- Create `live/checkpoint.ts` and `live/bundle.ts`, with tests.
- Create `apps/web/src/live/versionStorage.ts`.
- Modify `routes/documents.ts` and `compare.tsx`.

**Interfaces**
- `createCheckpoint(documentId, actor, note): Promise<{ versionId; versionNumber; docVersion }>`. Inside `docQueue` it encodes the state synchronously and freezes a copy of it. Outside the queue it renders the C11 bundle from that frozen copy, then inserts the `versions` row.
- `restoreCheckpoint(versionId, actor): Promise<Reconciliation>`. It applies one `PlannedEdit` per tab fragment and auxiliary fragment, replacing their children with the bundle's nodes through the pipeline. It follows C12's restore column. The restore is a new edit, so history is kept.
- `PrimerVersionStorage implements VersionStorage<Uint8Array>`:
  - provides `list`, `getContent`, `create`, `restore` and `rename`;
  - omits the optional `remove`, because versions are never deleted;
  - preview uses BlockNote's versioning view (`ForkYDoc`).
- Compare diffs the bundles' exports.

**Tests**
- `checkpoint bundle is frozen at one docVersion while edits continue`: an edit made during rendering is absent from the bundle.
- `restore is a new edit that keeps later history`.
- `checkpoint view keeps its discussion context` (`threads.json`).
- `compare diffs the Markdown exports`.

**Commit** `feat: checkpoints as immutable render bundles`.

### Task M2b.5: BlockNote editor in the web app

**Files:** Create `apps/web/src/live/LiveEditor.tsx`, `apps/web/src/live/provider.ts`, `apps/web/src/live/LiveEditor.test.tsx`; Modify `apps/web/src/routes/document.tsx` (branch on `doc.format !== null`), `apps/web/src/routes/upload.tsx` (accept `.txt`), `apps/web/src/components/HeaderActions.tsx` ("Save checkpoint", "Export").

**Interfaces:** `createLiveProvider(documentId: string): { provider: HocuspocusProvider; doc: Y.Doc; destroy(): void }` (URL `/collab`, name `doc:<id>`). `LiveEditor({ documentId, readOnly, theme })`: `useCreateBlockNote({ schema: primerSchema, collaboration: { provider, fragment: doc.getXmlFragment('document-store'), user: { name: me.displayName, color } } })` with `BlockNoteView` from `@blocknote/ariakit`, stock slash menu, toolbars, side menu, table handles, file panel; theme follows `useTheme`; dictionary from `navigator.language`. File blocks: `uploadFile` posts to `POST /api/documents/:docId/files` (stores under `files/<docId>/<uuid>`, a `doc_files` row; schema from M2a.2) and returns an opaque `primer-blob://<fileId>`; `resolveFileUrl` maps it to `/api/files/<fileId>` at read time (session-authorised, the doc's read check). The doc never stores expiring links. Code, math and Mermaid blocks are lazy-loaded (`React.lazy` chunks); the companion's vendored Mermaid stays only for legacy pages.
Connection indicator (`apps/web/src/live/ConnectionStatus.tsx`): "Reconnecting…" while the provider status ≠ `connected`; "Unsaved changes" while `unsyncedChanges > 0` for more than 5 s; "Changes not saved" with Retry on close code `4500`.
- [ ] **Step 1: Failing tests** `live document renders the editor and legacy renders the iframe` (jsdom, mocked provider); `connection indicator shows reconnecting, unsaved and save-failed states`.
- [ ] **Step 2–4.** Manual check: two browsers (`/auth/mock`) on one Markdown doc see each other's cursors and edits; reload keeps them.
- [ ] **Step 5: Commit** `feat(web): BlockNote editor for live documents`.

### Task M2b.6: Remove the old Markdown upload path

**Removed**
- The Markdown-to-HTML version branches.
- The HTML wrapper.
- `markdownStylesheet.ts`.

**Kept**
- markdown-it.
- gray-matter.

**Checks**
- `grep -rn "markdownToHtml" apps/api/src` finds nothing.
- `pnpm test` passes.

**Commit** `refactor(api): remove the Markdown-to-HTML version path`.

**M2a/M2b verification:**
- The CI order is green.
- `check-no-xl` exits with 0.
- MPL-2.0 sign-off is recorded on M1's PR.
- Changeset: api and web minor, api-types minor, mcp and plugin minor.

## M2c: Tabs

Ships: documents with several tabs. Every read, op, anchor, run and overlay is addressed by `Target.tabId`. It lands before M3 so that every later consumer uses tabs from the start.

**Files**
- Create: `apps/web/src/live/TabStrip.tsx`.
- Modify:
  - `LiveEditor.tsx`: one BlockNote editor per tab fragment, mounted lazily.
  - `live/reach.ts`.
  - `live/export.ts`: export joins the tabs in order, with `# <title>` separators for tabs after `main`.
  - `live/checkpoint.ts`.

**Tests**
- `pipeline edits on a second tab leave the main tab untouched`.
- `export and checkpoint include every tab`.
- `deleting a tab orphans its threads`.

**Commit** `feat: document tabs`.

---

## M3: Comments on live documents

Ships: BlockNote's comments UI (sidebar, open/resolved filter, reactions) on live docs, backed by Primer's threads; comment marks written server-side; orphaned threads flagged "Text removed" and re-anchorable; deleting commented text warns with an override. Legacy docs keep today's `CommentSidebar`.

### Task M3.1: Thread model for live documents

**Files:** Modify `apps/api/src/db/schema.ts` (`threads.version_id` nullable; `threads.orphaned_at timestamptz null`; new `comment_reactions (comment_id uuid fk cascade, user_id text fk, emoji text, created_at, pk(comment_id,user_id,emoji))`), `packages/api-types/src/index.ts` (C6 union, `isValidAnchor`, `ThreadDTO.orphaned: boolean`, `CommentDTO.reactions: {emoji; userIds: string[]}[]`), `apps/api/src/routes/{threads,comments}.ts` (`authorizeThreadMutation` and `loadDocContextForThread` join `documents` through `threads.document_id`, not `versions`), `packages/api-types` (`PrimerCommentCreatedPayload.version_id: string | null`), `apps/api/src/notifications/{notifier,mailgun}.ts` (links to `/d/:id` when no version), MCP `primer_get_comments`/`primer_get_document_comments` (live threads listed under `live`), `apps/api/src/testing/setup.ts`; Create `apps/api/src/live/marks.ts`, `apps/api/src/live/marks.test.ts`.

**Interfaces:**
- `commentMarkEdit(threadId: string, target: Target, sel: { anchor: string; head: string }): PlannedEdit`. It resolves the base64 Yjs relative positions inside the target's fragment with `relativePositionToAbsolutePosition`, then adds the mark `comment {threadId, orphan:false}` as an `AddMarkStep`. It runs through `applyPlan`, with the creator as the origin.
- `findMarkedQuote(doc: Y.Doc, target: Target, quote: string): { from: number; to: number } | null`. It tries an exact match first; M10b adds fuzzy matching.
- `presentThreadIds(doc: Y.Doc): Set<string>`. It scans `reachableFragments(doc)` only. Fragments left behind by republishes still hold marks, but they don't count.
- Routes: `GET /api/documents/:docId/threads` (live threads), `POST /api/documents/:docId/threads {anchor: AnchorData, body}` (row only), `POST /api/threads/:threadId/anchor {target, anchor, head}` (writes the mark; 409 `target_missing` if positions don't resolve), `POST /api/threads/:threadId/reanchor {target, anchor, head} | {target, quote}`, `POST|DELETE /api/comments/:commentId/reactions/:emoji`. Scopes: reads `documents:read`, writes `comments:write`.
- MCP: `primer_create_thread {documentId, target, quote, body}` and `primer_reanchor_thread {thread_id, target, quote}`. The server finds the quote and runs `commentMarkEdit`, the same path people use..
- [ ] **Step 1: Failing tests:** `commenter creates an anchored thread over a read-only socket` (mark present in the stored Y.Doc, thread anchor `{type:'prose', quote}`); `agent creates a thread by quote via MCP`; `reactions toggle per user`; `resolve works on a live thread`; `anchor validator accepts every C6 kind and rejects unknown`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): threads on live documents anchor with comment marks`.

### Task M3.2: Orphan flag and re-anchor

**Files:** Modify `apps/api/src/live/persist.ts` (post-persist hook), Create `apps/api/src/live/orphans.ts` + test.

`syncOrphans(documentId: string, doc: Y.Doc): Promise<void>`: debounced 2 s per document after persisted updates; open threads with mark-based anchors whose id is not in `presentThreadIds` get `orphaned_at = now()` and emit `thread.orphaned`; present ones get `orphaned_at = null`. Orphaned threads stay open, listed with their quote, label "Text removed".
- [ ] **Step 1: Failing tests:** `deleting the commented text orphans the thread and keeps its quote`; `undoing the delete clears the flag`; `re-anchor by quote restores the mark`; `marks left in unreachable fragments count as removed`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): flag threads whose text was removed`.

### Task M3.3: BlockNote comments UI on Primer's store

**Files:** Create `apps/web/src/live/PrimerThreadStore.ts`, `apps/web/src/live/PrimerThreadStore.test.ts`; Modify `apps/web/src/live/LiveEditor.tsx` (`comments: { threadStore }`, `ThreadsSidebar` with filter), `apps/web/src/routes/document.tsx`.

**Interfaces:** `class PrimerThreadStore extends ThreadStore` (modelled on BlockNote's `RESTYjsThreadStore`; source at `packages/core/src/yjs/comments/RESTYjsThreadStore.ts` in the BlockNote repository), constructor `(documentId: string, me: AuthUser, feed: EventsFeed)`. Implements every abstract method over the M3.1 routes; `addThreadToDocument` sends the selection as Yjs relative positions (`absolutePositionToRelativePosition`) to `/anchor`; `getThreads/subscribe` are fed by `GET …/threads` plus the existing events feed (`comment.created`, `thread.*`). Comment bodies are converted to Markdown text on write (Primer stores text with mentions) and parsed back on read. `PrimerThreadStoreAuth extends ThreadStoreAuth` mirrors the server rules (resolve: owner or thread starter; edit/delete: own comment).
- [ ] **Step 1: Failing test** `store maps ThreadDTO to ThreadData and back` (resolved, reactions, deleted comments).
- [ ] **Step 2–4.** Manual: two personas comment, react, resolve; filter shows resolved. **Step 5: Commit** `feat(web): BlockNote comments backed by Primer threads`.

### Task M3.4: Deleting or replacing commented text warns

**Files:** Create `apps/web/src/live/commentDeleteGuard.ts` + test; Modify `LiveEditor.tsx`. Produces for M4: `commentedThreadIds(blocks: Block[]): string[]` in `apps/api/src/live/marks.ts`.

A ProseMirror plugin (`filterTransaction`) holds a local transaction that removes characters carrying the `comment` mark of an open thread. This includes typing over a selection, paste-replace and block replacement. unless its meta `primer:allowCommentedDelete` is set; the editor then shows a dialog listing the affected quotes with "Delete anyway", which re-dispatches with the meta. Remote (sync) transactions are never filtered.
- [ ] **Step 1: Failing test** `deleting or replacing commented text is held for confirmation and passes with the override`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(web): warn before deleting commented text`.



---


## M4: Agent operations

Ships:
- Agents read live documents: the whole document, a range, a checkpoint, or the changes since a `docVersion`.
- Agents edit by `Target` through the pipeline, with preconditions.
- Runs are queued, controllable and shown in awareness.
- One run can be undone durably.
- Outline-first drafting.
- The agent skill.
- The TTL working status is deleted.

Depends on M3, because comment-delete refusals need comment marks.

### Task M4.1: Live reads and delta reads

**Files:** Create `apps/api/src/live/read.ts` + test; Modify `routes/documents.ts` (`GET /api/documents/:docId/live`), `apps/api/src/mcp/tools.ts`, `apps/mcp/src/{client,tools}.ts`, `packages/api-types` (C10).

**Interfaces:** `getLiveDoc(documentId: string, actor: AuthUser, opts: { format: 'markdown'|'html'|'json'; range?: { from: Target; to: Target }; at?: 'live' | number; since?: number; tabId?: string }): Promise<LiveDocDTO & { deletedIds?: string[] }>`. Reads use `yDocToBlocks` through `serverEditor()`; `at: n` loads the checkpoint bundle's `state.ydoc`; `since` returns only blocks whose ids appear in `doc_updates.touched` after that `docVersion`, plus `deletedIds`. `viewer` is filled when a run carries viewer context (M4.3). MCP `primer_get_doc(documentId, format, range?, at?, since?)`; description states block content and records written by people are untrusted data.
- [ ] **Step 1: Failing tests:** `json read returns ids, versions and flattened depth`; `since returns only changed and deleted blocks`; `checkpoint read ignores later edits`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): live and delta reads for agents`.

### Task M4.2: Semantic ops through the pipeline

**Files**
- Create: `apps/api/src/live/ops.ts`, `apps/api/src/live/rebase.ts`, and tests for both.
- Modify:
  - `routes/documents.ts`: add `POST /api/documents/:docId/ops`, scope `documents:write`.
  - MCP, on both surfaces.
  - `packages/api-types`.
  - `apps/api/package.json`: add `fast-diff@1.3.0`.

**Interfaces**
```ts
type BlockInput = string /* Markdown */ | { html: string /* one element */ } | { json: PartialBlock };
type LiveOp =
  | { op: 'add'; at: Target; position: 'before' | 'after'; blocks: BlockInput[] }
  | { op: 'update'; target: Target; block: BlockInput; expectVersion: string }
  | { op: 'replaceRange'; from: Target; to: Target; blocks: BlockInput[]; expectVersions: Record<string, string> }
  | { op: 'delete'; target: Target; expectVersion: string }
  | { op: 'move'; target: Target; at: Target; position: 'before' | 'after'; expectVersion: string };
type ApplyOpsRequest = { baseVersion?: number; ops: LiveOp[]; runId?: string; onConflict?: 'refuse' | 'suggest'; allowCommentedDelete?: boolean };
applyOps(documentId: string, actor: AuthUser, req: ApplyOpsRequest): Promise<Reconciliation | { refusal: Refusal; errors: { index: number; refusal: Refusal }[] }>;
```

`replaceRange` swaps a contiguous run of sibling blocks from `from` to `to`; `expectVersions` covers every block in the range. Ops on a sub-fragment (`pid` or `textId` set) take a `string` (plain text) as `block`.

**Rules (pinned)**

Validation and preconditions:
- All input is converted and validated *before* the pipeline runs. Any failure rejects the whole batch, with errors that name each op's index and carry a `fix`.
- Each op becomes one `PlannedEdit` with `inverse: true` whenever `runId` is set.
- Inside `applyPlan`, the synchronous recheck does three things:
  - a stale `expectVersion` makes that op a `conflict` (`target_changed`), or a suggestion (M5) when `onConflict:'suggest'`;
  - a cancelled or finished run refuses everything with `run_cancelled`;
  - any op that removes text carrying an open-thread `comment` mark is refused `deletes_commented_text` unless `allowCommentedDelete`. This covers `delete`, `replaceRange` and an `update` that drops the commented text.

Output:
- Markdown input with several top-level nodes yields several blocks, one list item per block.
- `note` reports "you wrote / we stored" when the stored text differs from the input.
- Agents whose effective mode is suggest get every edit as a suggestion (M5 lands in the same wave).

**Rebase (pinned, `rebase.ts`)** applies to `update` with Markdown or HTML input.

1. Convert the input to exactly one node. If its type equals the target's, diff text leaves; otherwise replace the block's content and keep its id.
2. Walk old and new inline content in parallel. A *compatible text leaf* is a maximal run of text nodes. Runs are separated by non-text inline nodes, which the walk treats as atoms: hard breaks, mention/date/dropdown chips, citations. Atoms that appear in both versions in the same order are anchors. Between anchors, `fastDiff` the plain text and emit ProseMirror `ReplaceStep`s, mapped through `tr.mapping`.
3. Formatting the Markdown projection can express is applied from the input over the diffed ranges: bold, italic, strike, inline code, links. A link is replaced only when its href or its text changed. Formatting the projection can't express survives untouched: text and background colour, underline, `comment` marks, suggestion marks, block props, children.
4. If the atoms differ (a chip added or removed), or if the block is a table or contains one, the update replaces that block's content wholesale, and `note` says so.

**Tests**
- `stale target conflicts, unrelated ops apply`
- `invalid op rejects the whole batch with indexed fixes`
- `agent updates a coloured, commented paragraph via Markdown and keeps colour and comment mark`
- `link text edit keeps the href; href edit replaces the link`
- `hard break and chip positions survive a text edit`
- `replaceRange swaps three blocks and refuses if one changed`
- `replacement that drops commented text needs the override`
- `markdown list input becomes one block per item`
- `cancel racing an apply: the apply either fully lands before cancel or is refused` (100 interleavings)
- `raw Yjs updates from agents are impossible`

**Commit** `feat(api): agents edit live documents by block through the pipeline`.

### Task M4.3: Agent runs, asking an agent, awareness status

**Files:** Create `apps/api/src/live/runs.ts`, `apps/api/src/routes/runs.ts`, tests; `apps/api/src/live/awareness.ts`; Modify `schema.ts`, `setup.ts`, `apps/web/src/live/{AskAgentMenu.tsx,AgentStatus.tsx}`, `LiveEditor.tsx`, `apps/web/src/components/NewThreadComposer.tsx`, `MentionTextarea.tsx` (agents in the mention list).

**Interfaces:**
- `agent_runs (id uuid pk, document_id fk cascade, agent_id text fk users, requested_by text fk users, status text ('queued'|'running'|'failed'|'done'|'cancelled'), request jsonb not null, dedupe_key text not null, status_line text null, error text null, edits_applied int not null default 0, blocks_removed int not null default 0, plan text null, plan_approved_by text null, created_at, started_at, finished_at)`, unique index `(document_id, agent_id, dedupe_key) where status in ('queued','running')`.
- `request = { kind: 'mention'|'send'|'inline'|'selection'; prompt: string; threadId?; blockId?; viewer: { tabId: string; selectedBlockIds: string[]; cursorBlockId: string | null; unsentText?: string } }`. `dedupe_key` = sha256 of `kind + threadId/blockId + prompt`.
- Routes: `GET /api/documents/:docId/agents` (agents that are collaborators or whose via is the viewer), `POST /api/documents/:docId/runs`, `GET /api/documents/:docId/runs`, `POST /api/runs/:runId/{claim,status,finish,cancel,retry}`. Emits `run.requested` / `run.updated`. Ops with a cancelled or finished `runId` are refused `run_cancelled`. The run status is rechecked synchronously in the pipeline's phase 3, and cancel and approval run on the document queue, so neither can race an apply.
- `setAgentAwareness(documentId: string, agent: AuthUser, state: { status: string; cursorBlockId: string | null } | null): Promise<void>`: applies an awareness update for a synthetic client id (`fnv1a32(agent.id)`) to the Hocuspocus document's awareness; `applyOps` sets the cursor to each op's target while it applies (BlockNote shows it as a collaboration cursor); `finish/cancel` clear it.
- MCP: `primer_list_runs {documentId?, status?}`, `primer_update_run {run_id, action: 'claim'|'status'|'finish'|'fail', status_line?, error?}`. Run requests reach agents as fenced untrusted text.
- [ ] **Step 1: Failing tests:** `duplicate ask while queued returns the existing run`; `plan approval on a cancelled run is refused (409)`; `cancel stops further ops`; `retry creates a new run with the same request`; `awareness shows the agent status line and clears on finish`.
- [ ] **Step 2–4.** Manual: "Ask agent" on a selection, `@agent` on an empty line (answer written at that line through a `pending` block), comment @-mention and "Send to agent" each create one run. **Step 5: Commit** `feat: controllable agent runs with live status`.

### Task M4.4: Durable undo of one agent run

**Files**
- Create `apps/api/src/live/undo.ts` and `live/undo.test.ts`.
- Modify `schema.ts` and `setup.ts`.

**Table** `run_inverses`:
- columns: `id bigserial pk`, `run_id uuid fk agent_runs cascade`, `document_id`, `target jsonb`, `prior jsonb null` (the target's subtree as ProseMirror JSON before the edit; null when the edit created it), `after_version text` (the target's `blockVersion` right after the edit), `created_fragment text null`, `created_at`;
- index on `(run_id, id)`.

The pipeline writes these rows for every `inverse: true` edit. It also writes them for sub-fragments a run creates (`created_fragment`) and for blocks a run created (`prior: null`).

**Interface** `undoRun(runId: string, actor: AuthUser): Promise<Reconciliation>`.
- Read the run's inverses newest first.
- Each one becomes a `PlannedEdit` whose precondition is `expectVersion = after_version`, and which restores `prior`. A `null` prior deletes the block; a `created_fragment` has its content cleared.
- Run them through `applyPlan` with `onConflict: 'suggest'`. A block someone changed after the run is not overwritten: it becomes a suggestion to restore `prior`.
- Allowed for the requester, the document owner and editors.
- Undo works after a restart and has no expiry.

**Tests**
- `undo removes the run's edits and keeps a person's later edit in another block`.
- `undo after a restart works`.
- `a block changed since the run becomes a restore suggestion`.
- `blocks and fragments the run created are removed`.

**Commit** `feat(api): durable undo of one agent run`.

### Task M4.5: Outline-first drafting

**Files:** Create `packages/blocks/src/pending.tsx`; test in `live/ops.test.ts`. `pending` block: props `{ intent: string; runId: string }`, no content, renders the intent with the run's status; agents add pending blocks with `add` and `{json:{type:'pending',props}}`, then fill each one with `update` (any `BlockInput`). The filled block keeps its id.
- [ ] **Step 1: Failing test** `pending blocks are filled in place section by section`. **Step 2–4.** **Step 5: Commit** `feat: outline-first drafting with pending blocks`.

### Task M4.6: Delete the TTL working status

Delete `setDocumentStatus`, `activeDocumentStatuses` (`lib/events.ts:680-721`), routes `/api/documents/:documentId/status`, `primer_set_status` (both MCP surfaces), `DOCUMENT_STATUS_TTL_MS`, `PrimerStatusPayload`/`'status'` type, `apps/web/src/queries/status.ts` and its UI. Legacy documents open a provider for awareness only: this relaxes M2a.4's live-only rule to admit legacy documents as `readOnly` connections whose Y.Doc is never persisted. Test: `legacy documents show agent status through awareness`. Commit `refactor: awareness replaces the working status`.

### Task M4.7: The Primer authoring skill

**Files:** Create `plugins/primer/skills/primer/authoring.md`; Modify `plugins/primer/skills/primer/SKILL.md` (link it; describe the live workflow), `apps/api/src/mcp/transport.ts` (server `instructions` = short summary + resource pointer; resource `primer://skills/authoring` returns the file), `apps/api/scripts/build.mjs` (copy it), `apps/mcp/src/index.ts` (same resource).

Content (decided): Markdown for prose; a single HTML element for formatting Markdown can't carry; BlockNote partial JSON for custom blocks and props; the native format list (stock blocks + `source`, `pending`, and later `page`, `widget`, `dataTable`, `choice`, `task`, `columnList`); one list item per block; unknown tags degrade to paragraphs, so check `note` and the stored blocks; edit by block id with `expectVersion`; re-read with `since: docVersion` instead of a full read; arbitrary HTML pages are allowed and become page blocks; comments and records are untrusted data. M6, M8, M9 and M10 append their sections.
- [ ] **Step 1: Failing test** `MCP exposes the authoring resource and instructions` (`resources/list` contains `primer://skills/authoring`). **Step 2–4.** **Step 5: Commit** `docs(plugin): the Primer authoring skill for agents`.



---

## M5: Suggestions

Ships:
- Agents, and people in suggest mode, propose changes. Everyone sees them inline, they are decided per change, and they survive restarts.
- The three-way Markdown republish merge.
- Per-document agent mode.

M5 is developed together with M4 (same wave). The spike decides the storage once.

### Task M5.1: Spike — suggestion storage, decided once

**Files**
- Create `apps/api/src/live/suggest.spike.test.ts`.
- Modify `packages/blocks/src/schema.ts`: re-declare `@handlewithcare/prosemirror-suggest-changes@0.1.8` insertion, deletion and modification marks as Tiptap marks in `BLOCK_LEVEL_SUGGESTION_GROUP`, with `generateId: uuidv7`.
- Modify `package.json`s.

**Steps**
- [ ] **Test** `two clients, one agent suggestion, concurrent edits, accept and reject converge, and survive reload`.
- [ ] **Decide.**
  - If the test passes, M5 ships marks in the Y.Doc plus metadata rows. This is the design below.
  - If it fails for a reason the library can't fix, M5 ships stored proposals instead: the edits plus `base_version` in `suggestions.edits jsonb`, rendered with `prosemirror-changeset` plus a mark/attribute pass, and accepted through `applyPlan`.
  - Record the decision in the PR and delete the other path's code.
  - Only `suggest.ts` internals differ between the two; C7 `suggestionId` is the same.
- [ ] **Commit** `test: suggestion storage spike`.

### Task M5.2: Suggestions through the pipeline

**Files**
- Create `apps/api/src/live/suggest.ts` and `routes/suggestions.ts`, with tests.
- Modify:
  - `live/pipeline.ts`: implement `onConflict:'suggest'` and suggest mode by turning edits into suggestion transactions with `transformToSuggestionTransaction`.
  - `schema.ts`: add `suggestions (id uuid pk, document_id fk cascade, author_id text fk users, run_id uuid null, change_set_id uuid null, status text ('open'|'accepted'|'rejected'|'withdrawn'), created_at, decided_by null, decided_at null)`.
  - `routes/documents.ts`: `PATCH` accepts `agentMode`, owner only.
  - MCP, on both surfaces.
  - `setup.ts`.

**Interfaces**
- `decideSuggestion(id, actor, decision: 'accept'|'reject'|'withdraw'): Promise<Reconciliation>`, applied through the pipeline.
- Authorisation:
  - Persons who are the owner or editors may accept or reject.
  - An agent may only `withdraw` its own suggestions. It never accepts or rejects any suggestion.
- `effectiveAgentMode(doc, actor): 'edit'|'suggest'`. `auto` means edit only if the agent owns the document.
- Emits `suggestion.created` and `suggestion.decided`.
- MCP tools: `primer_list_suggestions` and `primer_withdraw_suggestion`. Agents get no decide tool.

**Tests**
- `agent on someone else's document produces suggestions, not edits`.
- `owner flips agent mode to edit`.
- `agent withdraws its own suggestion and cannot accept or reject any`.
- `suggestions survive a server restart`.

**Commit** `feat: inline suggestions with per-change accept and reject`.

### Task M5.3: Three-way Markdown republish

**Files**
- Create `apps/api/src/live/merge.ts` and its test.
- Modify `lib/publish.ts`, which removes the `republish_unsupported` refusal.

**Inputs**
- **base:** the stored `sources` groups.
- **mine:** the live blocks of each group.
- **theirs:** the new file's groups.

**Alignment (pinned)**
1. **Identity.** A theirs group whose slice is byte-equal to a base slice aligns to it. Use the first unused match, in order.
2. **Similarity.** Remaining groups align when they keep their relative order and have the same leading token type. Pairs are taken by descending `similarity(normalize(base), normalize(theirs)) ≥ 0.5`, using M6.4's `similarity`. Such pairs count as *changed*.
3. **Everything else.** Unaligned base groups are *removed*; unaligned theirs groups are *new*.

**Per base group**

| case | result |
|---|---|
| aligned and unchanged | keep mine |
| changed, and mine untouched (`version` equals the source version) | replace with theirs, reusing the first block id |
| changed, and mine edited | keep mine, and add a suggestion of theirs |
| removed, and mine untouched | delete |
| removed, and mine edited | keep |
| new | insert after the preceding aligned group |
| live blocks with no source entry | keep in place |

**Output.** The merge produces one plan through `applyPlan` and returns a `Reconciliation`. `sources` is rewritten for the groups that took theirs.

**Tests**
- `republish merges by block and keeps comment marks and concurrent edits`.
- `a reworded paragraph counts as changed, not deleted plus inserted`.
- `both changed yields a suggestion`.

**Commit** `feat: three-way Markdown republish`.

**M3–M5 verification**
- CI is green after each PR.
- Changesets:
  - api, web and api-types: minor.
  - mcp and plugin: major in M4, because `primer_set_status` is removed.

---

## M6: HTML pages (page block, page text, `<primer-*>` blocks)

Ships:
- HTML uploads become live documents holding one `page` block.
- People edit the page's text, and the `<primer-*>` blocks inside it, through the one host overlay (C9).
- Agent republishes carry people's text over, per element, through the pipeline.
- Export splices text back into the original byte for byte.
- Comments work on page text.

Depends on M3, M4 and M5.

### Task M6.1: Stamping

**Files:** Create `apps/api/src/page/stamp.ts`, `apps/api/src/page/stamp.test.ts`.

**Interfaces:** `type PidInfo = { pid: string; tag: string; path: string; span: [number, number]; text: string }`; `stampPage(original: string, previous?: PidInfo[]): { stamped: string; pids: PidInfo[] }`; `readPids(stamped: string): PidInfo[]`.

Algorithm (pinned): parse the **original upload** (not the sanitized output) with parse5 `{ sourceCodeLocationInfo: true }`. Candidates: elements outside `script|style|template|textarea|title|head`, whose children are only text nodes and `<br>`, with non-whitespace text. `path` = tag names with sibling index from `<body>` (`div[2]/p[0]`); `span` = `[startTag.endOffset, endTag.startOffset]`; `text` = decoded text with `<br>` as `\n`. Ids: keep a valid unique existing `data-pid`; else match `previous` (M6.4); else `p<n>` with `n` above the current maximum. Insert ` data-pid="…"` before the closing `>` (or `/>`) of each start tag that lacks it, applying insertions from the highest offset down; no other byte changes. Elements without an end tag (implied) are not candidates.
- [ ] **Step 1: Failing tests:** `stamping only inserts data-pid attributes` (removing the inserted attributes yields the original exactly); `script, style and nested-markup elements are not stamped`; `br becomes a newline in text`; `existing data-pid is kept`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): stamp page text elements with stable pids`.

### Task M6.2: Page documents, splice and serving

**Files:** Create `apps/api/src/page/splice.ts`, `packages/blocks/src/page.tsx`, tests; Modify `lib/publish.ts` (`format:'html'` → live page), `live/export.ts` (page splicing), `routes/documents.ts` (`GET /api/documents/:docId/pages/:blockId/content`, served with `artifactCsp`).

**Interfaces:**
- `page` block (layout-only custom block, `content: 'none'`): props `{ sourceKey: string; title: string }`; renders `ArtifactIframe` plus the overlay host; stamped source stored at `pages/<docId>/<uuidv7>.html`.
- On publish: original kept (M1), `stampPage`, store stamped, one page block, one fragment `page/<blockId>/<pid>` per pid seeded with its text (system origin), checkpoint.
- `splicePage(stamped: string, texts: Map<string, string>): string`: for each pid whose current text differs from its stamped text, replace `stamped.slice(span)` with `escapeHtml(text)` where `\n` → `<br>`, highest offset first. Unchanged pids keep their bytes.
- Served content = `transformHtml(stamped)` (sanitize + inject, as today); the host pushes current texts. Checkpoint HTML and export = `splicePage(stamped, currentTexts)` (export without injection).
- [ ] **Step 1: Failing tests:** `untouched page exports the original byte for byte (with pid attributes)`; `editing one pid changes only its span`; `HTML upload creates a live page document with one page block`; `page content is served with the artifact CSP and sandbox unchanged`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat: HTML uploads become live page documents`.

### Task M6.3: Bridge and host overlay editor

**Files:** Modify `apps/api/src/companion/v1.js`, `apps/web/src/companion/protocol.ts` (+ tests), `apps/web/src/components/ArtifactIframe.tsx`; Create `apps/web/src/live/Overlay.tsx` (C9: the generic overlay for any `Target` with a sub-fragment, reused by embeds here and by widget labels in M8), `apps/web/src/live/pageBridge.ts` + test.

**Messages (C9, feature `page-text`):** iframe → host `page_elements { elements: { pid: string; text: string; rect: SerializableRect }[] }` (sent once after load, before any text is set, then `page_rects { rects: Record<string, SerializableRect> }` on scroll/resize), `pid_clicked { pid }`; host → iframe `set_page_texts { texts: Record<string, string> }` (bridge only sets `textContent`, with `<br>` for `\n`, on elements carrying that `data-pid`).

Overlay: on `pid_clicked`, the host positions a single-paragraph BlockNote editor (styles disabled, `ariakit` view) over the element's rect (iframe offset × fit scale), bound to `fragmentFor(doc, {tabId, blockId, pid})` via the same provider; keystrokes never enter the iframe. Script-drawn text: pids whose first-reported DOM text ≠ the stamped text (whitespace-normalized) are marked read-only in the host and get no overlay; agent ops on them return `script_text_read_only`.
- [ ] **Step 1: Failing tests:** `protocol parses page_elements and rejects malformed rects`; `set_page_texts only touches stamped nodes` (jsdom over v1.js); `script-drawn pid is read-only`.
- [ ] **Step 2–4.** Run `pnpm --filter @primer/api test:browser` (real-browser tier) after the v1.js change. Manual: two browsers edit the same heading in a page; both see it live. **Step 5: Commit** `feat: edit page text in a host overlay`.

### Task M6.4: Pid matching on republish

**Files:** `apps/api/src/page/match.ts` + test.

`matchPids(previous: PidInfo[], next: Omit<PidInfo,'pid'>[] & { keptPid?: string }[]): string[]` (pid per next element). Pinned order: (1) the agent kept `data-pid` and it exists in `previous`; (2) same `tag` and same `path`, `similarity ≥ 0.6`; (3) same `tag` anywhere, `similarity ≥ 0.8`. Within each stage, matching is greedy by descending score, and each previous pid is used once. (4) Otherwise a fresh pid.

**Ambiguous** (pinned): a stage-2 or stage-3 match is ambiguous when either side's normalized text occurs more than once among the candidates (repeated labels), or when the runner-up score is within 0.1 of the best. Ambiguous matches are returned as `uncertain: true` and are never carried silently (M6.5). Returns `{ pid: string; uncertain: boolean }[]`. `similarity(a, b) = 1 - levenshtein(norm(a), norm(b)) / max(len, 1)`, `norm` = trim + collapse whitespace + lowercase.
- [ ] **Step 1: Failing tests:** `kept pid wins`; `reworded paragraph at the same path keeps its pid`; `moved heading matches by tag and text`; `new element gets a fresh pid; removed pid is dropped`; `repeated labels are uncertain`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): match page elements across republishes`.

### Task M6.5: Three-way carry-over through the pipeline

**Files:** `apps/api/src/page/carry.ts` + test; Modify `lib/publish.ts` (HTML republish of a page doc).

Pinned per matched pair (old pid `o` → new pid `p`), `base` = old stamped text of `o`, `mine` = current fragment text of `o`, `theirs` = new text of `p`:
| condition | result in fragment `p` |
|---|---|
| `mine == base` | `theirs` |
| `theirs == base` | `mine` (carried) |
| `mine == theirs` | `theirs` |
| all differ, or the match is `uncertain` and `mine != base` | `theirs`, plus a suggestion replacing it with `mine`, authored by the person who last edited `o` (the latest `doc_updates.actor_id` whose `touched` contains `page/<blockId>/<o>`) |
Every row becomes a `PlannedEdit` in one `applyPlan` call, which returns a C7 `Reconciliation`. The suggestion rows come from the pipeline's suggest path. Fragments of unmatched old pids become unreachable, so their threads orphan (M3.2). The page block's `sourceKey` switches to the new stamped source in the same plan.
- [ ] **Step 1: Failing tests** `three-way carry-over table` (one case per row, plus "removed element orphans its thread"); `repeated labels are never carried silently`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): carry people's page text over agent republishes`.

### Task M6.6: Page comments and skill section

Comments on page text use the M3 path unchanged (the overlay editor carries BlockNote's comment UI; anchor `page-text`). Ops address a pid with `target: {tabId, blockId, pid}` and a plain-text `block` (`pid_unknown` otherwise). `primer_get_doc` lists page pids with text and version. Append the "HTML pages" section to `authoring.md` (pages are allowed as-is; preserve every `data-pid` when republishing, so people's edits are carried and not turned into suggestions; script-drawn text is read-only). Test: `agent edits a pid through ops and the thread on it survives`. Commit `feat: page text comments and agent edits by pid`.


### Task M6.7: Sanitizer and import of `<primer-*>` blocks

**Files:** Modify `apps/api/src/upload/sanitize.ts` (allow those four tags with `data-embed-id`, `lang`), `page/stamp.ts` (embeds are never pid candidates; their inner content is excluded), Create `apps/api/src/page/embeds.ts` + test.

`readEmbeds(original: string): { embedId: string; kind: 'table'|'code'|'mermaid'|'math'; span: [number, number]; html: string }[]`; publish rejects a missing, computed or duplicate `data-embed-id` (refusal `invalid_op` with the element path). Each embed's inner HTML → blocks (`tryParseHTMLToBlocks`; code → `codeBlock {language}`; mermaid/math → the diagram/math block) into fragment `embed/<blockId>/<embedId>`, with a `sources`-style entry so untouched embeds export verbatim (same rule as M2b.2).
- [ ] **Step 1: Failing tests:** `primer tags survive sanitize with literal ids`; `missing embed id is refused at publish`; `untouched embeds export verbatim`. **Step 2–4.** **Step 5: Commit** `feat(api): Primer blocks inside pages`.

### Task M6.8: Embeds read-only in the page, edited in the overlay

**Files:** `v1.js`, `protocol.ts`, `Overlay.tsx` (target `{tabId, blockId, embedId}`); Messages (feature `embeds`): host → iframe `set_embeds { embeds: Record<string, string> }` (static HTML from the host's BlockNote `blocksToFullHTML`, Mermaid pre-rendered to SVG by the host), iframe → host `embed_clicked { embedId }`. The overlay opens a full BlockNote editor bound to the embed fragment.
- [ ] **Step 1: Failing test** `set_embeds fills only primer-* elements with matching ids`. **Step 2–4** (+ `test:browser`). **Step 5: Commit** `feat(web): edit page blocks in the overlay`.

**M6 verification:** CI green, plus `test:browser`. Changesets: api and web minor; mcp and plugin minor, for the skill sections on pages and `<primer-*>` blocks.

---


---

## M8: Widgets

Ships: agent-authored SVG/JSX diagrams and charts as `widget` blocks: validated, rendered server-side to SVG with a PNG preview for the agent (draft → publish, last good publish live), labels editable in place, parts and data points commentable, the visual-vocabulary skill.

Decision (runtime; a deviation from survey decision 8): no headless browser. Widget code runs in QuickJS (WASM, 50 ms CPU, 16 MB) on the server; the output tree is serialized through an SVG allowlist; PNG previews come from `@resvg/resvg-js` (MPL-2.0). Static rendering elsewhere is the bundle's `static.html` (C11) and PDF is the browser's print.

### Task M8.1: Module format and validator

**Files:** Create `apps/api/src/widgets/{parse.ts,validate.ts,run.ts,serialize.ts}` + tests; deps `quickjs-emscripten`, `acorn`, `acorn-jsx`, `@resvg/resvg-js` (exact pins via the 14-day gate). There is one parser: `parseWidget(source): { ast; code: string }` parses with acorn-jsx, and `code` is produced by Primer's own JSX→`h(tag, props, ...children)` emitter, which replaces each JSX node's source range and keeps every other byte. No Sucrase.

**Interfaces:**
- Module: one source, either `<svg>…</svg>` or JS/JSX with `export default function render({ rows, tokens }) { return <svg>…</svg>; }`, no other imports/exports.
- `validateWidget(source: string): { ok: true } | { ok: false; errors: { line: number; message: string; fix: string }[] }`: rejects `import`, dynamic `import()`, `require`, `fetch`, `eval`, `Function`, `globalThis`, `XMLHttpRequest`, `WebSocket`; `style` attributes and `<style>`; `<foreignObject>`; literal colours (hex/rgb/named) and `var(...)` in `fill`/`stroke`/`color` (use `tokens.*` only; `renderWidget` resolves tokens to concrete colours per theme, so resvg needs no CSS variables); any element with text children lacking a **string-literal** `data-text-id`; computed `data-text-id` or `data-anchor`.
- `renderWidget(source: string, rows: Record<string, unknown>[], theme: 'light'|'dark'): Promise<{ svg: string } | { errors }>`: `parseWidget` → QuickJS → tree → `serializeSvg` (tag/attr allowlist = the sanitizer's SVG lists plus `data-text-id`, `data-anchor`, `data-row`, `data-col`; `href` only `#…`). Elements with `data-row` must name an existing row id. **Runtime output validation** always runs on the produced tree: tag and attribute allowlist, `data-text-id` present on every element with text, no `style` or `foreignObject`. Syntax checks alone never establish safety. **Bounds:** at most 5,000 nodes and 512 KB of SVG; a `viewBox` of at most 4096×4096; rasterised at 1× up to 2048 px on the long side.
- [ ] **Step 1: Failing tests:** `computed text ids are rejected`; `fetch and imports are rejected`; `serializer drops script, event handlers and external hrefs`; `infinite loop is stopped by the CPU limit`; `a tree over 5,000 nodes is refused before rasterising`; `an output with a computed style is refused at runtime even if the source passed`.
- [ ] **Step 2–4.** **Step 5: Commit** `feat(api): validate and render widget modules safely`.

### Task M8.2: Widget block, draft/publish, labels and comments

**Files:** `packages/blocks/src/widget.tsx`, `apps/api/src/widgets/store.ts`, `routes/widgets.ts`, MCP both surfaces, `schema.ts` (`widgets (id uuid pk, document_id fk cascade, block_id text, draft_source text, draft_errors jsonb, published_source text, published_svg_light text, published_svg_dark text, published_hash text, rows jsonb null, collection text null, updated_by text, updated_at)`), `setup.ts`, web `live/WidgetView.tsx`.

**Interfaces:** `widget` block props `{ widgetId }` renders the published SVG inline (allowlisted markup only), overlays label text from `fragmentFor(doc, {blockId, textId})` and offers comments on `[data-anchor]` (`widget-part`) and `[data-row][data-col]` (`data-point`) elements. MCP `primer_widget_draft {documentId, widgetId?, afterBlockId?, source, rows? | collection?}` → errors, or `{ widgetId, previewHash, png_light, png_dark }` as MCP image content. `previewHash` is the sha256 of the light and dark SVG. `primer_widget_publish {widgetId, previewHash}` publishes only if the current draft renders exactly that hash, so a publish is bound to the preview the agent saw (`widget_invalid` otherwise). A draft that fails never replaces the live publish. Ops: `update` with `target: {tabId, blockId, textId}` sets a label. Label editing uses the shared `Overlay.tsx` (C9).
- [ ] **Step 1: Failing tests:** `a draft with errors never replaces the live widget`; `publish with a stale previewHash is refused`; `label edit survives republish when the text id is kept`; `data-point comment anchors to row and column`. **Step 2–4.** **Step 5: Commit** `feat: widgets with drafts, live labels and comments`.

### Task M8.3: Visual-vocabulary skill

Create `plugins/primer/skills/primer/widgets.md` (served with the authoring resource): flows, trees, 2×2s, timelines, funnels, roadmaps, bar/line/area charts as copyable modules in one house style, light and dark tokens (`tokens.fg`, `tokens.muted`, `tokens.accent1..6`, `tokens.surface`, `tokens.grid`). Test: `every skill template validates and renders` (loop over code fences). Commit `docs(plugin): widget vocabulary for agents`.

**M8 verification:** CI green; licence check (resvg MPL-2.0 noted in PR). Changeset: api/web minor, mcp + plugin minor.

---

## M9: Shared records

Ships: per-document records (Claude Artifacts storage) for agents (MCP) and pages (host bridge), change log with revert, caps, coalesced `data.changed`; record-reading pages get the `records` outbound policy and a document-bound bridge capability. M9 (T1–T4) runs in W3 alongside M2b. The records snapshot inside checkpoint bundles (`records.json`) and T5 ship as M9b, after M2b and M8.

### Task M9.1: Tables, verbs, caps, change log

**Files:** Create `apps/api/src/records/{store.ts,store.test.ts}`; Modify `schema.ts`, `setup.ts`, api-types (`RecordDTO`, `RecordQuery`).

**Interfaces:**
- `doc_records (document_id uuid fk cascade, collection text, record_id text, scope text ('shared'|'personal'), owner_user_id text null fk users, data jsonb not null, version int not null, updated_at, updated_by text fk users, pk(document_id, collection, scope, coalesce(owner_user_id,''), record_id))` (implemented as a unique index over the expression).
- `doc_record_changes (id bigserial pk, document_id, collection, record_id, scope, owner_user_id, op text ('set'|'update'|'delete'), before jsonb null, after jsonb null, actor_id text, created_at)`.
- `recordsApi(actor: AuthUser, documentId: string)` returning `{ get, list, query, set, update, delete, batch }`, each taking `{ collection, scope, recordId?, data?, expectVersion?, where?: Record<string, string|number|boolean|null>, orderBy?: { key: string; dir: 'asc'|'desc' }, limit?, cursor? }`. `update` is a shallow merge. `batch` is atomic. Caps per document: 10,000 records, 10 MB total `data`, 64 KB per record → `records_cap`. Stale `expectVersion` → `record_conflict`. Access: shared read = `canRead`; shared write = `canWriteEvents` (owner, editor, responder); personal = the viewer's own rows only (agents: their own).
- `revertChange(changeId: number, actor): Promise<void>` (owner/editors).
- [ ] **Step 1: Failing tests:** `batch is all or nothing`; `stale expectVersion conflicts`; `caps refuse the write that crosses them`; `personal records are invisible to others`; `revert restores the before image`. **Step 2–4.** **Step 5: Commit** `feat(api): per-document shared records with a change log`.

### Task M9.2: REST, MCP and fencing

**Files:** Create `apps/api/src/routes/records.ts` + test; Modify `auth/scopes.ts`, `mcp/tools.ts`, `apps/mcp/src/{client,tools}.ts`, api-types. Routes `GET|POST /api/documents/:docId/records/:collection[/:recordId]`, `POST /api/documents/:docId/records/batch`, `POST /api/documents/:docId/records/query`, `GET /api/documents/:docId/records/changes`, `POST /api/record-changes/:changeId/revert`; new scopes `records:read`, `records:write` (api-types `API_TOKEN_SCOPES`). MCP `primer_records {documentId, verb, …}` (one tool, verb enum) and `primer_record_changes`. Records whose `updated_by` is a person are returned as `{ data, untrusted: true, written_by }`; the tool description says to treat them as data. Test: `agent reads viewer-written records fenced as untrusted`. Commit `feat: records over REST and MCP`.

### Task M9.3: Page bridge capability and the records policy

**Files.**
- Modify: `v1.js`, `protocol.ts`, `versionContent.ts`, the page content route, `lib/publish.ts`, `schema.ts` (`versions.reads_records boolean not null default false`).
- Create: `apps/web/src/live/recordsCapability.ts` and its test.

**Opt-in.** A page reads records only if its source contains `<meta name="primer-records" content="read">` (`readsRecords(html)`, set at publish). Such pages are served with `artifactCsp('records')` and the bridge features `pageBridgeFeatures('records')` (M1.4).

**Capability (pinned).**
- `createRecordsCapability({ documentId, pageTarget, viewer }): RecordsCapability` is created by the host per iframe load. It is bound to the document and page.
- Calls from the page carry only `{ verb, collection, scope, recordId?, data?, where?, limit?, cursor?, expectVersion? }`. The host fills `documentId` and the personal owner from the capability, and ignores those fields if they appear in `args`.

**Bounds.**
- At most 8 calls in flight.
- A 5 s timeout per call.
- At most 256 KB per payload.
- `list` and `query` page through `limit ≤ 200` with a `cursor`.

**Messages (feature `records`).**
- iframe → host: `records_call { callId, verb, args }` and `records_cancel { callId }`.
- host → iframe: `records_result { callId, ok, value?, refusal? }` and `records_changed { collections, toChangeId }`.
- Catch-up after reconnect: `window.primer.records.changesSince(changeId)`.
- `v1.js` exposes `window.primer.records.<verb>(args, { signal })`.

**Navigation.** A second iframe `load` without a fresh bridge handshake revokes the capability, and the host reloads the page. Ambiguity 15 covers the residual one-shot risk.

**Tests.**
- [ ] **Step 1: Write the failing tests:**
  - `record-reading page gets the records policy`
  - `bridge ignores documentId and owner in args`
  - `bridge refuses record verbs for pages without the opt-in`
  - `calls beyond 8 in flight are refused; cancel aborts`
  - `frame navigation revokes record access`
  - `records_changed after reconnect is caught up via changesSince`
- [ ] **Step 2–4:** Run the tests, implement, run again, then run `test:browser`.
- [ ] **Step 5: Commit** `feat: pages read records through a document-bound capability`.

### Task M9.4: Coalesced data.changed

**Files:** Create `apps/api/src/records/changed.ts` + test; Modify `records/store.ts`, api-types (`data.changed`). `scheduleDataChanged(documentId, actorId, collection)`: per `(document, actor)` window of 2 s, one lifecycle event `data.changed { document_id, collections, from_change_id, to_change_id }` authored by that actor, so an agent skips events it authored (skill says so). Test: `ten writes in a burst emit one event per actor`. Commit `feat(api): coalesced data.changed events`.

### Task M9.5 (PR M9b): Data-table block, live charts, records in bundles (needs M2b, M8, M9)

**Files:** Create `packages/blocks/src/dataTable.tsx`, `apps/web/src/live/DataTableView.tsx` + test; Modify `apps/api/src/widgets/store.ts`. `dataTable` block props `{ collection, columns: string (JSON [{key,label,type:'text'|'number'|'date'|'select'}]), scope }`: renders and edits rows through the records routes, refreshes on `data.changed`. Widgets with `collection` re-render server-side on `data.changed` (debounced 2 s) and publish the new SVG if valid. Checkpoint bundles gain `records.json` (shared records at capture); external shares and checkpoint views answer page reads from it, read-only (live data frozen at publish). Warehouse queries from an external integration arrive as collection `query:<name>` written over MCP (no Primer-side query engine). Tests: `external share reads the frozen snapshot`; `editing a cell writes a record and other viewers refresh`; `chart re-renders when its collection changes`. Commit `feat: live data tables and charts`.

**M9 verification:** CI green. Changeset: api/web minor, api-types minor (scopes), mcp + plugin minor.

---
## M10: Collaboration features (five PRs)

Each is one session-sized upstream PR, scheduled in the waves table: **M10e** in W2, **M10c** in W5, **M10d** in W6, **M10a** in W7 after M9b, and **M10b** in W8, after M5 and M6. Decisions and task lists are projections of blocks and records, and their indexes can be rebuilt. Every PR ends with CI green, a changeset, and the matching `authoring.md` section.

**Files convention for M10 tasks:** a custom block lives in `packages/blocks/src/<name>.tsx`. Routes go in `apps/api/src/routes/<feature>.ts` with the logic in `apps/api/src/live/<feature>.ts` or `apps/api/src/records/`. Web UI goes in `apps/web/src/live/<Feature>.tsx`. Tests sit beside each file, named as given. Schema changes go to `schema.ts` plus `testing/setup.ts`. MCP tools follow the Global Constraints rule.

### M10a: Decisions, tasks and Primer blocks (after M2c, M9, M9b)

**Task M10a.1: Choice block and decision register.**
- **Block.** `choice` uses the prop-driven alert pattern. Props: `{ question; options: string /* JSON [{id,label}] */; mode: 'vote'|'pick'; decidedOptionId: string; rationale: string; evidence: string /* JSON [{url|docId, label}] */; openQuestions: string /* JSON string[] */ }`.
- **Votes** are records: collection `primer.choice/<blockId>`, scope `shared`, `recordId` = voter id, `{ optionId }`. They stay out of the Y.Doc. Commenting on an option uses a `block` anchor plus the option label as the quote.
- **Register.** `GET /api/documents/:docId/decisions` and MCP `primer_list_decisions` are a read-time projection over the document's choice blocks (no table). Each entry gives the chosen option, rationale, evidence and open questions. The web shows it as a side panel.
- **Tests:**
  - `votes tally per option and one vote per person`
  - `register lists decided choices with rationale`
- **Commit:** `feat: choice blocks and a decision register`.

**Task M10a.2: Task blocks become tracked tasks.**
- **Block.** `task` props: `{ title; assigneeId; due; status: 'open'|'done' }`.
- **Table.** `doc_tasks (id uuid pk, document_id fk cascade, block_id text unique per doc, title, assignee_id null, due_date date null, status, created_by, created_at, updated_at)`. It is a rebuildable index: the persistence hook keeps it in sync from block props, `rebuildTaskIndex(documentId)` recreates it from the Y.Doc, and it is never written any other way. The hook emits `task.created` and `task.updated`. External integrations consume these; Primer runs no task system of its own.
- **Interfaces.** MCP `primer_list_tasks {documentId? , assigneeId?}`. `GET /api/tasks?assignee=me`.
- **Tests:**
  - `adding a task block creates a tracked task and emits task.created`
  - `checking it off updates status`
- **Commit:** `feat: task blocks become tracked tasks`.

**Task M10a.3: Inline chips.**
- **Content.** `mention` (users and agents), `date` and `dropdown` custom inline content. Each uses BlockNote suggestion menus (`@`, `//date`, `//select`) and is usable inside table cells, which gives the dropdown and date cells.
- **Test:** `a mention chip notifies the mentioned person` (reuses the existing notifier).

**Task M10a.4: Blocks BlockNote lacks.**
- **Layout.** `columnList` / `column` layout blocks (our own; the idea is from `xl-multi-column`, no code).
- **Callouts.** A `callout` block (alert pattern, `{ kind: 'info'|'warning'|'success'|'note' }`). M2b's GitHub-alert import switches from quote to callout here.
- **Embeds.** An `embed` block `{ url }`: a link card from server-fetched OpenGraph with a 5 s timeout, rendered as text and image only, with no third-party iframe.
- **Test:** `GitHub alert imports as a callout and exports verbatim`.


### M10b: Awareness of change (after M5, M6)

**Task M10b.1: Catch-up view and digest.**
- **Schema.** `document_views.last_doc_version bigint null`, set when a viewer opens a live document.
- **Catch-up.** "Since you last looked" = `getLiveDoc({ since: last_doc_version })`, plus threads and comments created after `viewed_at`, plus decided suggestions. It renders as a dismissible panel that highlights the changed blocks.
- **Digest.** `GET /api/me/digest?since=ISO` and MCP `primer_get_digest` return the same data across the caller's library. An external integration pushes it to Slack or Telegram. Primer sends nothing itself.
- **Test:** `catch-up lists only changes after my last view`.
- **Commit:** `feat: catch-up since you last looked`.

**Task M10b.2: Change highlights since the last checkpoint.** Client decorations on blocks in `getLiveDoc({ since: latestCheckpoint.doc_version })`, toggled from the header.
- **Test:** `blocks edited after the checkpoint are highlighted`.
- **Commit:** `feat(web): highlight changes since the last checkpoint`.

**Task M10b.3: Fuzzy re-anchoring.**
- **Matcher.** `findMarkedQuote` adds a fuzzy stage after exact match fails: the best window in the block (or the whole fragment) with `similarity ≥ 0.8`, using M6.4's `similarity`.
- **Behaviour.** It is used by agents' `primer_reanchor_thread` and by a "Re-anchor" button on orphaned threads. It never re-anchors automatically.
- **Legacy.** `threadCarry.ts` for legacy versions stays exact, which keeps its documented behaviour.
- **Test:** `orphaned thread re-anchors to the reworded sentence`.
- **Commit:** `feat: fuzzy re-anchoring of orphaned threads`.

**Task M10b.4: Evidence provenance.**
- **Inline content.** A `citation` custom inline content: `{ url?; docId?; versionNumber?; quote }`, rendered as a numbered chip.
- **Interfaces.** `GET /api/documents/:docId/citations`. Agents add citations through `json` block input.
- **Test:** `citation to a Primer doc pins the cited version`.
- **Commit:** `feat: citations link claims to sources`.

**Task M10b.5: Promote a conversation into a doc.**
- **Interfaces.** MCP `primer_promote_conversation {title, messages: [{author, text}], documentId?}` and `POST /api/documents/from-conversation`. Each message becomes a quote block with its author line, and message text is fenced as untrusted. "Promote thread" on a comment thread uses the same function.
- **Test:** `a thread becomes a document with one quote per message`.
- **Commit:** `feat: promote a conversation into a document`.

**Task M10b.6: Plan-first for big agent edits.**
- **Columns.** `agent_runs.plan`, `plan_approved_by`, `edits_applied` and `blocks_removed` (from M4).
- **Rule.** The pipeline adds every applied edit to the run's counters, cumulatively across batches. An edit that would take a run past 20 edits or 5 removed blocks is refused with `plan_required`, unless the run's plan is approved. Splitting a large change into many small batches therefore does not avoid approval.
- **Approval.** The requester or an editor approves through `POST /api/runs/:runId/plan` and `/approve`. Approval runs on the document queue, so it can't race a cancel or an apply.
- **Tests.**
  - `ten batches of three edits hit plan_required at the 21st edit`
  - `approval after cancel is refused`
- **Commit.** `feat: plan-first for big agent edits`.

### M10c: Branches, forks, templates (after M5)

**Task M10c.1: Private drafts and branches.**
- **Schema.** `documents.branch_of uuid null fk documents`, `documents.branch_base_doc_version bigint null`, `suggestions.change_set_id uuid null`.
- **Branches.** A branch is a private document owned by its creator. It starts from the parent's `Y.encodeStateAsUpdate`, so CRDT identity is kept and nothing is rebuilt from blocks. It is edited like any document. Copying follows C12: comment and suggestion marks are re-created with copied rows and rewritten ids, and files and widgets are copied. The branch's **base state** (`documents.branch_base_state bytea`) is kept for the three-way comparison.
- **Proposing.** "Propose" is a three-way comparison per block id of base, parent and branch. A block only the branch changed becomes a suggestion. A block only the parent changed is left alone, so the branch never proposes reverting the parent's edits. A block both changed becomes a suggestion marked `conflict: true`, which the UI shows as a branch conflict, with both versions. Everything goes through `applyPlan` with one `change_set_id`. Accepting or rejecting the set decides every non-conflict suggestion in it; conflicts are decided individually.
- **Tests:** `branch proposal arrives as one change set and accepting applies all`; `a parent-only edit is never proposed for reversal`; `a block changed on both sides is a conflict`.
- **Commit:** `feat: private branches proposed back as one change set`.

**Task M10c.2: Fork, remix and templates.**
- **Schema.** `documents.forked_from uuid null`, `documents.is_template boolean not null default false`.
- **Behaviour.** Fork follows C12. It copies the Y.Doc state with comment and suggestion marks **stripped** (through a pipeline plan on the new document), the originals, page sources, files and widgets (with new ids), and shared records. It does not copy threads, suggestions or personal records. "New from template" is a fork of a template document. The library gets a Templates filter.
- **Interfaces.** MCP `primer_fork_document {documentId, title}`.
- **Test:** `fork keeps content and block ids but strips marks and threads`.
- **Commit:** `feat: fork, remix and templates`.

### M10d: Editor chrome (after M2c)

**Task M10d.4: Rich paste.**
- **Paste handler.** A BlockNote `pasteHandler`. HTML goes through BlockNote's stock HTML paste. Plain text that `detectMarkdown` recognises goes through the server's Markdown import route (`POST /api/convert/markdown`), so paste and upload share one parser.
- **Test:** `pasted Markdown becomes the same blocks as an upload`.

**Task M10d.5: Read-only and static rendering, export and print.**
- **Rendering.** External shares of live docs show the shared checkpoint bundle's `static.html` (C11) in the existing share page. Email digests use the same `exportHtml`.
- **Export.** The menu offers Markdown, HTML and "Print / PDF", which is `/d/:docId/print` rendering the bundle's `static.html` with a print stylesheet and calling `window.print()`.
- **Test:** `share link of a live doc serves the published checkpoint, not live state`.

**Task M10d.6: Theming and localisation.**
- **Theme.** The BlockNote theme follows Primer's light and dark tokens (`useTheme`).
- **Language.** Every user-facing string in `apps/web/src` moves to `apps/web/src/i18n/en.json`, read through `t(key, vars)` (`apps/web/src/i18n/index.ts`, with no library).
  - Locale files: `de`, `es`, `fr`, `ja`, `zh`.
  - The locale and BlockNote's dictionary come from `navigator.language`, with `en` as the fallback.
- **Tests.**
  - `editor uses the dark theme when Primer is dark`
  - `every locale file has every key in en.json`
  - `no JSX text literal remains outside i18n`: a lint test over `apps/web/src`.

**Commits:** one per task, `feat(web): …`.

### M10e: Collaborator tools for agents (issue #98; after M1)

**Shared logic.** Extract `addCollaborator(actor, docId, { userId|email, role })` and `listCollaborators` from `routes/collaborators.ts`. REST and MCP share them.

**Tools.** `primer_lookup_user`, `primer_add_collaborator` and `primer_list_collaborators`, with the issue's guardrails:
- owner only (`canManage`). An agent counts as owner of documents it uploaded, so it may add collaborators there, at roles up to its own effective role. The person it acts for is also an owner (C1), so they can revoke;
- add only;
- visibility rule parity;
- rejects adding the caller itself;
- not-found for unknown emails;
- notifier parity.

**Tests.** One test per guardrail checkbox in #98. Commit `feat(mcp): collaborator tools for agents (#98)`.

---

## Self-review notes

- **Spec coverage.** Every spec section maps to a task.
  - Interface-only, because they live in an external integration: the Slack/Telegram digest push (M10b.1) and warehouse queries (M9.5).
  - Not planned, because the spec says "later": whiteboards and CSV, image and PDF uploads.
- **Codex review.** Every point is adopted:
  - one pipeline (C4) and one address (C3);
  - one reconciliation format (C7) and one render bundle (C11);
  - copy policies (C12);
  - durable undo (M4.4);
  - the complete outbound policy and capability (M1.4, M9.3);
  - uncertain pid matches (M6.4–5);
  - text-leaf rebase rules (M4.2);
  - widget preview binding and bounds (M8);
  - three-way branch proposals (M10c);
  - authorisation fixes (M5.2, M10e);
  - waves with one owner per shared file;
  - all the UX items.
- **Naming.** Used consistently: `docVersion`, `versionNumber`, `block.version`, `Target`, `applyPlan`, `PlannedEdit`, `Reconciliation`, `readBlocks`, `serverEditor`, `applyOps`, `getLiveDoc`, `findMarkedQuote`, `reachableFragments`.
