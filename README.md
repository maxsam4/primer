# Primer

> *"The Primer was a book in appearance only. Its interior was a tissue of paper, but each page was a separate flat-panel display, which formed itself into pictures, words, and animations responsive to the reader."*
> — Neal Stephenson, *The Diamond Age*

Primer is a place to publish HTML and Markdown documents, most often written by an
LLM, at a stable URL, and to review them together. Upload a page (or have your
agent publish it), share the link, and reviewers comment directly on the text.
New versions keep the same URL, and the agent can pull the comments back in to
write the next one.

Polygon builds Primer and runs it for its own teams. The code is open source
under MIT or Apache-2.0, and you can run your own instance.

## Contents

- [What it does](#what-it-does)
- [Publish from Claude and other agents](#publish-from-claude-and-other-agents)
- [Quickstart: run it locally](#quickstart-run-it-locally)
- [How the code is organized](#how-the-code-is-organized)
- [Configuration](#configuration)
- [Running your own instance](#running-your-own-instance)
- [Testing](#testing)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## What it does

- **Publishing.** Upload a self-contained `.html` file or a `.md` file in the
  browser, or through the REST API and MCP tools. Markdown is rendered to HTML,
  with Mermaid diagrams supported.
- **Sandboxed rendering.** Documents run in a sandboxed iframe. A small
  companion script inside the frame reports text selections and positions back
  to the app, so the document itself never touches your session.
- **Anchored comments.** Select text to start a thread on it. Threads support
  replies, mentions and email notifications.
- **Versions.** Each upload of a document is a new version at the same URL. You
  can switch between versions and see a diff between any two.
- **Sharing.** Documents are private to the owner and the collaborators they
  add (editor, responder or commenter), or visible to everyone in the
  organization. A published version can also be shared with people outside the
  organization, who sign in with a code sent to their email.
- **Agent access.** A remote MCP endpoint (`/mcp`, OAuth 2.1), a stdio MCP
  server published to npm, and a REST API with scoped personal and service
  tokens.
- **Document events.** Interactive documents can submit structured events
  (for example, a form answer), which the owner's tooling reads back over the
  API or a live stream. See [the events loop guide](docs/development/events-loop.md).

## Publish from Claude and other agents

This repository is also a Claude plugin marketplace. The `primer` plugin adds
a skill that knows how to publish, version and read comments, and it connects
to Polygon's hosted Primer. At Polygon, install it once in Claude Code:

```
/plugin marketplace add 0xPolygon/primer
/plugin install primer@primer
/reload-plugins
```

Then ask Claude to "publish this to Primer". The first time, it asks you to sign
in through your browser.

To use your own instance instead, point any MCP client at its remote endpoint,
`https://<your-host>/mcp`, or run the stdio server
[`@polygonlabs/primer-mcp`](apps/mcp/) with `PRIMER_API_URL` set to your host.
[`apps/mcp/README.md`](apps/mcp/README.md) lists the tools and the login flow.

## Quickstart: run it locally

You need:

- **Node.js 24** (the version in [`.nvmrc`](.nvmrc)).
- **pnpm.** Run `corepack enable` once (Corepack comes with Node), or install a
  recent pnpm (10 or later) any way you like. Either way, the pnpm version
  pinned in `package.json` is the one that runs.
- **Docker**, for the local Postgres.

```bash
git clone https://github.com/0xPolygon/primer.git && cd primer
cp .env.example .env              # the defaults work for local development
pnpm install --frozen-lockfile
pnpm db:up                        # Postgres 17 in Docker on localhost:5432
pnpm db:migrate                   # create the schema and seed two mock users
pnpm dev                          # API on :3000, web app on :5173
```

Open <http://localhost:5173>. Local development uses `AUTH_MODE=mock`, so
you're already signed in as **Mock User** (`mock@polygon.technology`). To act as
the second persona, **Mock Reviewer**, open <http://localhost:5173/auth/mock>
in another browser or a private window and pick `mock-user-2`. That lets you
try sharing and commenting between two users.

To publish your first document, use **Upload** in the app, or call the API:

```bash
echo '<h1>Hello, Primer</h1><p>Select this text to comment on it.</p>' > hello.html
curl -X POST http://localhost:3000/api/upload \
  -H 'x-primer-csrf: 1' -F file=@hello.html -F title='Hello'
# → {"documentId":"…","versionId":"…","url":"/d/…"}
```

Open `http://localhost:5173` followed by the returned `url`.

In development the API (port 3000) and the web app (port 5173, served by
Vite) are two processes, and Vite forwards `/api`, `/auth` and `/companion`
to the API. Point API clients and MCP clients at port 3000. In production, one
process serves both.

To reach the API from other tools such as curl or an MCP client, create a
token at <http://localhost:5173/settings/tokens> and send it as
`Authorization: Bearer <token>`. Requests with a token don't need the
`x-primer-csrf` header.

### Useful scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Start the API and the web app, with reload on change |
| `pnpm db:up` / `pnpm db:down` | Start or stop the local Postgres |
| `pnpm db:reset` | Delete the local database and migrate it again from scratch |
| `pnpm db:migrate` | Apply migrations to the development database |
| `pnpm db:migrate:test` | Apply migrations to the test database (`primer_test`) |
| `pnpm db:generate` | Create a migration from changes to `apps/api/src/db/schema.ts` (commit the SQL) |
| `pnpm typecheck` | Run `tsc --noEmit` in every package |
| `pnpm test` | Run the Vitest suites (see [Testing](#testing)) |
| `pnpm build` | Build every package |
| `pnpm verify` | Typecheck, test, and `pnpm audit --audit-level=high` |

## How the code is organized

This is a pnpm workspace.

| Path | What's there |
|---|---|
| [`apps/api`](apps/api) | The server (`@primer/api`): Hono on Node 24, Postgres through Drizzle, the REST API, the remote MCP endpoint, auth, and the companion script (`src/companion/v1.js`) that runs inside rendered documents. Migrations are in `apps/api/drizzle/`. |
| [`apps/web`](apps/web) | The web app (`@primer/web`): React 19, React Router 7, TanStack Query, Tailwind 4, built with Vite. |
| [`apps/mcp`](apps/mcp) | The stdio MCP server and login CLI, published to npm as [`@polygonlabs/primer-mcp`](https://www.npmjs.com/package/@polygonlabs/primer-mcp). |
| [`packages/api-types`](packages/api-types) | The REST API's request and response types, published as `@polygonlabs/primer-api-types`. |
| [`plugins/primer`](plugins/primer) | The Claude plugin: the `primer` skill and its MCP connection. [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) makes this repository a plugin marketplace. |
| [`docs`](docs) | The product requirements (`docs/prd-primer.md`), and the design specs and implementation plans behind each feature (`docs/superpowers/`). |

## Configuration

The API reads its settings from environment variables. In development it loads
them from `.env`. [`.env.example`](.env.example) lists every option with notes.

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_MODE` | none, required | `mock` for local development (every request is a mock user; refused when `NODE_ENV=production`), `okta` for OIDC sign-in, or `proxy` to trust a signed identity JWT from a reverse proxy (see [docs/self-host.md](docs/self-host.md)) |
| `DATABASE_URL` | none, required | Postgres connection string |
| `DATABASE_URL_TEST` | none | Test database, used by `pnpm db:migrate:test` and the API tests |
| `PORT` | `3000` | Port the API listens on |
| `STORAGE_BACKEND` | `filesystem` | Where document content is stored: `filesystem` or `gcs` |
| `STORAGE_ROOT` | `./storage` | Directory for the `filesystem` backend |
| `GCS_BUCKET` | none | Bucket for the `gcs` backend, which authenticates with the environment's Google credentials |
| `OKTA_ISSUER`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET` | none | OpenID Connect client, required when `AUTH_MODE=okta` |
| `AUTH_BASE_URL` | none | The public URL of your instance. Required when `AUTH_MODE=okta`; also used for sign-in redirects, links in emails, and secure cookies |
| `PROXY_AUTH_HEADER`, `PROXY_AUTH_PUBLIC_KEY` or `PROXY_AUTH_JWKS_URL`, `PROXY_AUTH_ISSUER`, `PROXY_AUTH_AUDIENCE` | none | Required when `AUTH_MODE=proxy` |
| `OAUTH_ISSUER` | `AUTH_BASE_URL` | Issuer advertised to remote MCP clients |
| `ADMIN_EMAILS` | none | Comma-separated admin emails. Admins can read usage stats |
| `SESSION_TTL_DAYS` | `14` | How long a browser session lasts |
| `SESSION_COOKIE_NAME` | `primer_sid` | Session cookie name |
| `COOKIE_SECURE` | from `AUTH_BASE_URL` | Force the cookie `Secure` flag |
| `MAILGUN_API_KEY`, `EMAIL_FROM` | none | Email notifications through Mailgun. Without them, no email is sent. `MAILGUN_DOMAIN` and `MAILGUN_API_BASE_URL` are optional |
| `SERVE_STATIC`, `STATIC_ROOT` | off | Serve the built web app from the API; the Docker image turns this on |
| `LOG_LEVEL` | `info` | Log level |

## Running your own instance

Primer ships as one Docker image: the API also serves the built web app, and
the container applies database migrations before it starts. Build it from the
repository root:

```bash
docker build -f apps/api/Dockerfile -t primer .
```

To run it, you need:

- **Postgres** (Primer is developed against Postgres 17), set in `DATABASE_URL`.
- **Storage for documents.** Use `STORAGE_BACKEND=gcs` with `GCS_BUCKET`, or
  the filesystem backend with `STORAGE_ROOT` on a persistent volume outside
  `/app`, which is read-only in the image.
- **An OpenID Connect provider** for sign-in: `AUTH_MODE=okta` with the
  `OKTA_*` variables and `AUTH_BASE_URL`. Register
  `<AUTH_BASE_URL>/auth/callback` as the redirect URI. Primer uses standard
  OIDC discovery with the `openid profile email` scopes. It's built and run
  against Okta; other OIDC providers aren't tested.
- `NODE_ENV=production`, set in the image, which rejects `AUTH_MODE=mock`.

Optionally, set `ADMIN_EMAILS` to let admins read usage stats, and the
Mailgun variables to send notification emails. `/api/health` and `/api/ready` are the
liveness and readiness checks.

For a ready-made Docker Compose setup and proxy sign-in, see [docs/self-host.md](docs/self-host.md).

Primer was built for one organization. Everyone who can sign in through your
identity provider can see documents that are shared with the organization and
the usage dashboard at `/admin`, and some text in the interface still says
"Polygon".

## Testing

The API tests run against a real Postgres database, `primer_test`, which
`pnpm db:up` creates next to the development one. Before the first run, and
after you pull new migrations, apply the schema:

```bash
pnpm db:up
pnpm db:migrate:test
pnpm test
```

Other test suites:

- `pnpm --filter @primer/api test:browser` runs the companion script's
  consent-gate tests in a real headless Chrome, which you need installed. It
  isn't part of `pnpm test`; run it after changing `apps/api/src/companion/v1.js`.
- `scripts/container-smoke.sh <db-host>` builds the Docker image, starts it,
  and runs the HTTP smoke tests against it, as the release pipeline does. It
  migrates the database it's given, so point it at a throwaway Postgres; the
  comment at the top of the script has the details.

## Contributing

Issues and pull requests are welcome. Before you open a pull request:

1. Run `pnpm verify` (typecheck, tests and audit), or at least `pnpm typecheck`
   and `pnpm test`.
2. If your change affects a published package, the app, or the plugin, add a
   changeset with `pnpm changeset`, and describe the change for the people who
   use it. CI checks for one.
3. Commit any new migration that `pnpm db:generate` creates.

CI runs the typecheck, build and tests on every pull request.

**Dependencies are locked down on purpose.** `pnpm-workspace.yaml` won't
install a package version less than 14 days old, allows install scripts only
for packages on its `allowBuilds` list (just `esbuild` today), and blocks
transitive dependencies installed from git, tarballs or URLs. Always install with
`pnpm install --frozen-lockfile`. If you add a dependency that needs an
install script or a newer version, explain why in the pull request.

**Releases.** [Changesets](https://github.com/changesets/changesets) collects
changesets into a "Version Packages" pull request. A maintainer merging it is
the release: it publishes the npm packages and the plugin update, and tags the
API version, which builds, tests and publishes the Docker image. See
[`.github/workflows/release.yml`](.github/workflows/release.yml).

## Security

Please don't report vulnerabilities in public issues. Follow Polygon's
[security policy](https://github.com/0xPolygon/primer/security/policy) instead:
use **Report a vulnerability** on this repository's Security tab, or the
Polygon bug bounty programs listed there.

## License

Copyright (c) 2026 PT Services DMCC

Licensed under either:

- Apache License, Version 2.0, ([LICENSE-APACHE](./LICENSE-APACHE) or <http://www.apache.org/licenses/LICENSE-2.0>), or
- MIT license ([LICENSE-MIT](./LICENSE-MIT) or <http://opensource.org/licenses/MIT>)

at your option.

The SPDX license identifier for this project is `MIT` OR `Apache-2.0`.

## Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any additional terms or conditions.
