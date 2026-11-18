import type { Context, MiddlewareHandler } from 'hono';
import type { AppVariables } from '../app.ts';
import type { UserResolver } from '../auth/resolver.ts';

export const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/ready',
  '/auth/login',
  '/auth/callback',
  '/api/device/authorize',
  '/api/device/token',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/consent',
  '/oauth/token',
  '/oauth/revoke',
]);

function isApiPath(path: string): boolean {
  return path.startsWith('/api/');
}

// The companion script is loaded as a subresource by the sandboxed artifact
// iframe (`sandbox="allow-scripts allow-forms allow-modals allow-downloads"`,
// no allow-same-origin).
// Sandboxed iframes make subresource requests as cross-site, which strips
// SameSite=Lax cookies — so the companion fetch arrives without a session.
// The script is static, identical for every viewer, and contains no secrets
// (text-anchoring + selection-capture protocol), so it's safe to serve
// without auth.
function isPublicCompanionAsset(path: string): boolean {
  return path.startsWith('/companion/');
}

function isPublicWellKnown(path: string): boolean {
  return path.startsWith('/.well-known/oauth-');
}

// External share plane: the /share/:token SPA page and its /api/share/*
// endpoints authenticate viewers with their own OTP + primer_ext_sid cookie
// (see apps/api/src/external/), never the internal session. They must be
// reachable without an Okta session.
function isExternalSharePath(path: string): boolean {
  return path.startsWith('/share/') || path.startsWith('/api/share/');
}

// The SPA bundle (/assets/* content-hashed JS/CSS, favicon) is identical for
// every visitor and contains no secrets — all data stays behind the API's
// auth. It must be public: unauthenticated visitors on /share/:token load
// index.html, and if its subresource requests 302 to Okta the browser kills
// them as cross-origin (no CORS on the Okta authorize page). Only bites in
// production (SERVE_STATIC=1) — dev serves assets from Vite.
function isPublicSpaAsset(path: string): boolean {
  return path.startsWith('/assets/') || path === '/favicon.svg';
}

// Brand assets (/brand/* fonts and art) are subresources of published
// artifacts, fetched from the sandboxed artifact iframe. Like /companion/,
// those requests arrive cross-site and credential-less — an auth redirect
// kills them (fonts silently fall back). The files are static, identical
// for every viewer, and contain no secrets (see web/public/brand/README.md).
function isPublicBrandAsset(path: string): boolean {
  return path.startsWith('/brand/');
}

export interface AuthMiddlewareOptions {
  /**
   * OAuth issuer URL. When set, unauthenticated requests to /mcp will
   * receive a `WWW-Authenticate: Bearer resource_metadata=...` header
   * pointing clients to the protected-resource metadata document.
   */
  issuer?: string;
  /**
   * Response for an unauthenticated browser (non-API) request. Default:
   * redirect to /auth/login. AUTH_MODE=proxy supplies a 401 page instead,
   * because there is no login flow to redirect to.
   */
  unauthenticatedPage?: (c: Context<{ Variables: AppVariables }>) => Response;
}

export function authMiddleware(
  resolver: UserResolver,
  options?: AuthMiddlewareOptions,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.has(path) || isPublicCompanionAsset(path) || isPublicWellKnown(path) || isExternalSharePath(path) || isPublicSpaAsset(path) || isPublicBrandAsset(path)) return next();

    const user = await resolver(c);
    if (user) {
      c.set('user', user);
      return next();
    }

    if (isApiPath(path) || path.startsWith('/auth/') || path === '/mcp') {
      if (path === '/mcp') {
        const issuer =
          options?.issuer ??
          process.env.OAUTH_ISSUER ??
          process.env.AUTH_BASE_URL ??
          '';
        if (issuer) {
          c.header(
            'www-authenticate',
            `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
          );
        }
      }
      return c.json({ error: 'unauthenticated' }, 401);
    }
    if (options?.unauthenticatedPage) return options.unauthenticatedPage(c);
    const returnTo = encodeURIComponent(path);
    return c.redirect(`/auth/login?return_to=${returnTo}`, 302);
  };
}
