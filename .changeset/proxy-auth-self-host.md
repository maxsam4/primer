---
"@primer/api": minor
---

Add `AUTH_MODE=proxy`: sign-in delegated to a reverse proxy that forwards a
signed identity JWT (`PROXY_AUTH_HEADER`, `PROXY_AUTH_PUBLIC_KEY` or
`PROXY_AUTH_JWKS_URL`, `PROXY_AUTH_ISSUER`, `PROXY_AUTH_AUDIENCE`). The token's
signature, issuer, audience and expiry are verified, the user is keyed by `sub`
(optional `email` and `name` claims), CSRF protection and bearer-token access
are unchanged, and unauthenticated browsers get a 401 page instead of an OIDC
redirect. Also adds `docker-compose.selfhost.yml` and `docs/self-host.md` for
running Primer with Postgres and a filesystem blob volume.
