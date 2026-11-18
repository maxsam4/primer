# @polygonlabs/primer-mcp

Stdio MCP server for Primer — exposes Primer documents, versions, and
comments as tools, and bundles a device-authorization login flow for both
in-agent and CLI use. Used by Claude Code (and any other MCP-compatible
client) via stdio.

## Install in Claude Code

**Preferred — via the Primer plugin marketplace** (also installs the `primer` skill that drives this MCP):

```
/plugin marketplace add 0xPolygon/primer
/plugin install primer@primer
/reload-plugins
```

The plugin bakes the prod `PRIMER_API_URL` into the MCP server registration, so there's nothing else to configure — open a Claude Code session and say "publish this to Primer" to trigger the device-login + create-document flow.

**Manual install** (skip the plugin, register the MCP yourself):

```
claude mcp add primer \
  --env PRIMER_API_URL=https://primer.polygon.tools \
  -- npx -y @polygonlabs/primer-mcp@1.0.0
```

Pin the version so the local install doesn't drift on each `npx` run.

**Local dev** (point at a locally-running API):

```
claude mcp add primer \
  --env PRIMER_API_URL=http://localhost:3000 \
  -- node /abs/path/to/apps/mcp/dist/index.js
```

## Logging in

Primer uses the OAuth 2.0 device authorization flow. Two entry points,
sharing one token store.

### In-agent (preferred)

The Primer skill calls `primer_login`, which returns a `deviceCode`,
`userCode`, and `verificationUri`. The skill prints them to you in this
exact shape (see the [design spec, Section 5][spec]):

```
Open this URL in your browser:
  https://primer.example.com/device

Then type this code on the page:
  WXYZ-1234
```

You open the URL, **type the code from your terminal into the page**
(the page does not pre-fill it from the URL — this is an intentional
phishing mitigation, see [design spec, Section 6][spec]), and approve.
The skill then long-polls `primer_login_status` until the server
returns `approved`; the token is written to your local store, never
shown to the agent or printed in the terminal.

### CLI

If you want to log in without an agent in the loop (e.g. before a
scripted session), run the same flow from the shell:

```
node apps/mcp/dist/index.js login
# or, after install/publish:
primer-mcp login
```

The CLI prints the same `verificationUri` + `userCode` pair, polls
quietly (with a `Still waiting...` heartbeat every ~15s during long
waits), and exits `0` once you approve. On `denied` or `expired` it
exits `1` with a short message.

The CLI never auto-opens a browser and never echoes the bare token.

[spec]: ../../docs/superpowers/specs/2026-06-05-primer-api-mcp-agent-design.md

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `PRIMER_API_URL` | yes | Base URL of the Primer API, e.g. `http://localhost:3000` or `https://primer.example.com`. Used both to call the API and as the token-store key. |
| `PRIMER_API_TOKEN` | no | If set, the server uses this token verbatim and skips the store entirely. Intended for CI / impersonation. Takes precedence over the store. |
| `PRIMER_TOKEN_FILE` | no | Relocate the token store away from the default path. Same JSON shape, same `0600` permission requirements. |

## Token store

`@polygonlabs/primer-mcp` writes tokens to `~/.config/primer/tokens.json`
(override with `PRIMER_TOKEN_FILE`). The file is a plain JSON object
keyed by normalized `PRIMER_API_URL`, so one store can hold tokens for
local-dev, staging, and prod simultaneously without collision.

Each entry holds `{ tokenId, token, prefix, savedAt }`. Writes are
**atomic** — temp file with mode `0600`, `fsync`, rename — so an
in-agent `primer_login_status` and a `primer-mcp login` running side by
side can't tear a write.

Token lookup precedence on every tool call:
1. `PRIMER_API_TOKEN` env var
2. Store entry for the current `PRIMER_API_URL`
3. No token → tools return `code: 'not_authenticated'`.

`primer_logout` revokes the server-side token (`DELETE /api/tokens/:id`)
and removes the local entry. Idempotent.

## Tools

| Tool | Purpose |
|---|---|
| `primer_login` | Start a device-authorization login. Returns `deviceCode`, `userCode`, `verificationUri`, `expiresIn`, `interval`. |
| `primer_login_status` | Long-poll the device flow. Returns `{ status: 'approved' \| 'pending' \| 'denied' \| 'expired' }`. On `approved` the token is written to the store; the agent never sees it. |
| `primer_logout` | Revoke + clear the stored token for the current `PRIMER_API_URL`. |
| `primer_whoami` | Return the authenticated Primer user (`id`, `email`, `displayName`). |
| `primer_create_document` | Create a new document with an initial version. |
| `primer_add_version` | Upload a new version of an existing document. |
| `primer_get_document` | Fetch a document + its latest-version metadata. |
| `primer_get_version_content` | Fetch the stored content (HTML) of a version, or the latest version of a document. Pass `toDisk: true` to save it to a fresh server-owned temp file (returned as `savedTo`) instead of returning it inline. |
| `primer_list_versions` | List all versions of a document, newest first. |
| `primer_get_comments` | Fetch comment threads on a version (or the latest version of a document), including open threads carried from earlier versions. Returns a markdown summary and one record per comment with its `thread_id`, `comment_id`, `author_id`, `anchor_text`, `version_number` and `resolved`. |
| `primer_reply_to_thread` | Reply in a comment thread (`{ thread_id, body }`). Returns `{ thread_id, comment_id }`. |
| `primer_resolve_thread` | Resolve a comment thread (`{ thread_id }`); document owner or thread starter only. |

Inline content (passed via `primer_create_document` / `primer_add_version`)
is capped at **10 MB per upload**. Larger payloads will be rejected by
the API with `code: 'bad_request'`.

### Disk round-tripping — content transfer without burning context

Both directions of content transfer can move the document body over the
filesystem so it never transits agent context:

- **Write:** `primer_create_document` / `primer_add_version` take
  `contentPath` *instead of* `content` — an absolute path to a local file
  the server reads and uploads.
- **Read:** `primer_get_version_content` takes `toDisk: true` *in addition
  to* its lookup args — the server writes the fetched content to a **fresh
  temp directory it owns** (`$TMPDIR/primer-<random>/content.html`) and
  returns metadata (`savedTo`, `sizeBytes`, version ids) only. The agent
  moves the file where it wants with its own tools.

The read direction deliberately does **not** accept a destination path: an
agent-chosen absolute path would let a read-shaped tool perform arbitrary
filesystem writes (with overwrite) outside the permission model that
governs the agent's own Write tool. Writing only to a fresh server-owned
temp dir removes the traversal and overwrite surface; relocating the file
goes back through the harness's gated file tools, and that move never
spends context on the body.

Note the asymmetry on the write side: `contentPath` reads are **not
sandboxed to any directory** — the server will read whatever absolute path
the process itself can access. That is equivalent in power to the agent
reading the file and inlining it, but be aware the MCP process touches the
filesystem based on tool arguments.

This matters most for documents with embedded `data:`-URI images: base64
tokenizes at ~2.5–3 characters per token, so inlining a 100 KB image costs
~50k tokens in each direction — and a 10 MB document exceeds model context
windows outright. A path costs a handful of tokens.

## Error code taxonomy

Every tool error returns `{ code, message }` JSON in `content[0].text`
with `isError: true`. Codes are machine-checkable; skills should branch
on `code`, never on `message` text.

| Code | Meaning / fix |
|---|---|
| `not_authenticated` | No token, or the token was rejected. Run `primer_login`. |
| `forbidden` | The token is valid but the document isn't yours. |
| `not_found` | The id is stale or never existed. |
| `bad_request` | Validation failure, payload too large, wrong format, or any non-2xx the client couldn't classify. |
| `rate_limited` | Server returned 429. Back off and retry. |
| `network` | Transport-layer failure (DNS, connection refused, TLS). Transient — retry. |
| `login_denied` / `login_expired` | Surfaced by `primer_login_status` as a status value (not a thrown error). Start a fresh login. |

## Manual smoke (optional)

To verify the bundle locally without a real Primer instance:

```
pnpm --filter @polygonlabs/primer-mcp build
node --check apps/mcp/dist/index.js
PRIMER_API_URL= node apps/mcp/dist/index.js   # should exit 1 with "PRIMER_API_URL is required."
```

To exercise the full device flow, point the CLI at a running API:

```
PRIMER_API_URL=http://localhost:3000 node apps/mcp/dist/index.js login
```

## Publishing to npm (maintainers only)

Releases are cut **manually from a maintainer's machine** with npm 2FA — no automation token, no CI publish workflow. This keeps the publish path narrowly under human + hardware-MFA control.

One-time setup:
- npm account is a member of the [`@polygonlabs` npm org](https://www.npmjs.com/org/polygonlabs) with publish rights.
- npm 2FA enabled (`npm profile enable-2fa auth-and-writes`).
- Locally signed in: `npm whoami` returns your username.

Per release:

```bash
# From repo root, on a clean master with the version bump merged
git checkout master && git pull --ff-only
pnpm install --frozen-lockfile

# Verify
pnpm --filter @polygonlabs/primer-mcp typecheck
pnpm --filter @polygonlabs/primer-mcp test
pnpm --filter @polygonlabs/primer-mcp build   # also runs as prepublishOnly

# Publish (prompts for 2FA OTP interactively)
cd apps/mcp
npm publish --access public

# Confirm
npm view @polygonlabs/primer-mcp version
```

After publishing, **bump the version pin in `plugins/primer/.claude-plugin/plugin.json`** (`mcpServers.primer.args` → `["-y", "@polygonlabs/primer-mcp@<new-version>"]`) so the marketplace plugin picks up the release on the next `/plugin marketplace update primer`.

Optionally tag the release for traceability (no automation hangs off it):

```bash
git tag mcp-v<version>
git push origin mcp-v<version>
```
