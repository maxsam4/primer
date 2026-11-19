# Self-hosting Primer

Primer runs as two containers: the app (the API, which also serves the web
app) and Postgres. Documents are stored on a volume. Sign-in is delegated to a
reverse proxy you already run (AUTH_MODE=proxy), so Primer needs no identity
provider of its own.

## Quick start

```bash
cp .env.selfhost.example .env      # edit it
docker compose -f docker-compose.selfhost.yml up -d --build
```

The app listens on `127.0.0.1:3000` (`PRIMER_PORT` to change). Database
migrations run each time the app container starts, and a failed migration
fails the container. `/api/health` is liveness, `/api/ready` checks the
database. Back up the `primer-pg` and `primer-blobs` volumes.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | Password for the bundled Postgres |
| `AUTH_BASE_URL` | yes | Public URL of the instance (secure cookies, links in emails, OAuth issuer for MCP) |
| `AUTH_MODE` | yes | `proxy` for this guide (also `okta`, or `mock` for local dev) |
| `ADMIN_EMAILS` | no | Comma-separated admin emails (may mint service tokens) |
| `PROXY_AUTH_HEADER` | proxy mode | Request header carrying the identity JWT (e.g. `x-identity`) |
| `PROXY_AUTH_PUBLIC_KEY` | one of | PEM public key (SPKI) that verifies the JWT: Ed25519, RSA or EC. `\n` escapes are accepted |
| `PROXY_AUTH_JWKS_URL` | one of | URL of a JWKS the proxy publishes (cached, keys rotate) |
| `PROXY_AUTH_ISSUER` | proxy mode | Required `iss` |
| `PROXY_AUTH_AUDIENCE` | proxy mode | Required `aud` |
| `MAILGUN_API_KEY`, `EMAIL_FROM` | no | Email notifications. Without them nothing is emailed, and external-share one-time codes (which are emailed) are unavailable. `MAILGUN_DOMAIN`, `MAILGUN_API_BASE_URL` optional |

Everything else in the [README configuration table](../README.md#configuration)
applies too.

## Proxy sign-in (AUTH_MODE=proxy)

Put a reverse proxy in front of Primer that authenticates people however you
like (SSO, mTLS, a Cloudflare Access policy, oauth2-proxy...) and forwards a
short-lived signed JWT in a header. Primer verifies it on every request:
signature, `iss`, `aud` and `exp` (30 s clock skew). Tokens with `alg: none` or
symmetric algorithms are rejected.

Claims:

- `sub` (required): the stable user id. People are keyed by it. The Primer user id is `proxy:<sub>`, so a token can never collide with (or overwrite) the built-in service user or users from another auth mode.
- `email` (optional): shown to collaborators and matched against `ADMIN_EMAILS`.
  Defaults to `<sub>@proxy.invalid`.
- `name` (optional): display name. Defaults to `sub`.

The user row is created or updated on first sight. Behaviour you can rely on:

- Permissions are unchanged: document visibility, collaborator roles, owner and
  admin checks are all enforced by Primer for the user the token names.
- Browser requests keep CSRF protection (`X-Primer-Csrf`, which the web app
  sends). A request with no valid token gets 401; browsers see a plain
  "Sign-in required" page rather than an OIDC redirect.
- `Authorization: Bearer primer_pat_...` service/API tokens and OAuth tokens
  (used by agents and the MCP server) keep working without an identity header,
  so the proxy must let those requests through to Primer.
- The proxy must strip any client-supplied copy of the identity header and set
  its own. Primer should only be reachable through the proxy (the compose file
  publishes it on loopback only).

Example with Cloudflare Access (header `Cf-Access-Jwt-Assertion`, JWKS at the
team domain, `aud` is the application's AUD tag):

```
AUTH_MODE=proxy
PROXY_AUTH_HEADER=cf-access-jwt-assertion
PROXY_AUTH_JWKS_URL=https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
PROXY_AUTH_ISSUER=https://<team>.cloudflareaccess.com
PROXY_AUTH_AUDIENCE=<application AUD tag>
```

Example minting a token yourself (Node, with `jose`), e.g. from a small auth
sidecar. Generate an Ed25519 key pair once and give Primer the public half:

```js
import { SignJWT } from 'jose';
const jwt = await new SignJWT({ email: 'ada@example.com', name: 'Ada' })
  .setProtectedHeader({ alg: 'EdDSA' })
  .setSubject('user-123')
  .setIssuer('https://sso.example.com')
  .setAudience('primer')
  .setExpirationTime('5m')
  .sign(privateKey);
// proxy forwards:  x-identity: <jwt>
```

## Switching an existing Okta install to proxy mode

Okta users are stored under their Okta `sub`; proxy users are stored as
`proxy:<sub>`. After the switch the same person is a **new user**: documents
they own, their collaborator memberships, comments and tokens stay with the old
id. Re-key the old users before anyone signs in through the proxy (if a person
has already signed in, delete their new `proxy:` row first, or the update below
collides on it). Back up the database first, then fill in the mapping and run it
with `psql` (the bundled Postgres user is a superuser, which `session_replication_role`
needs). It rewrites every column that references `users(id)`:

```sql
BEGIN;
SET LOCAL session_replication_role = replica;  -- skip FK checks while ids are rewritten
CREATE TEMP TABLE id_map (old_id text PRIMARY KEY, new_id text NOT NULL);
-- old Okta sub  ->  proxy:<the sub your proxy will send>
INSERT INTO id_map VALUES ('00u1abcdEXAMPLE', 'proxy:ada@example.com');
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT k.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint k
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
    WHERE k.contype = 'f' AND k.confrelid = 'users'::regclass
  LOOP
    EXECUTE format('UPDATE %s SET %I = m.new_id FROM id_map m WHERE %I = m.old_id', r.tbl, r.col, r.col);
  END LOOP;
  UPDATE users u SET id = m.new_id FROM id_map m WHERE u.id = m.old_id;
END $$;
COMMIT;
```

Find each person's old id with `SELECT id, email FROM users;`. Mapping by email
is fine when your proxy's `sub` is the email address; otherwise use whatever
`sub` it issues.

## Signing out

`POST /auth/logout` only clears Primer's own session cookie. In proxy mode the
identity comes from the proxy on every request, so that does not end the
upstream session and the user is still signed in. Users sign out at the proxy,
for example `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout` for
Cloudflare Access or `/oauth2/sign_out` on oauth2-proxy.

## Optional: email

Set `MAILGUN_API_KEY` and `EMAIL_FROM` (and `AUTH_BASE_URL`) to send comment
notifications and external-share codes. With none set Primer logs a warning and
sends no email.

## Notes

Primer was built for one organization and some interface text still says
"Polygon". Real-time updates use an in-process event bus, so run a single app
container.
