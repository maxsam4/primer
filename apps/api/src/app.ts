import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger as appLogger } from './logger.ts';
import { authMiddleware } from './middleware/auth.ts';
import { csrfMiddleware } from './auth/csrf.ts';
import { proxyUnauthorizedPage } from './auth/proxy.ts';
import { scopeMiddleware } from './auth/scopes.ts';
import { mockResolver, type UserResolver } from './auth/resolver.ts';
import { registerUploadRoute } from './routes/upload.ts';
import { registerConvertRoute } from './routes/convert.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerVersionContentRoute } from './routes/versionContent.ts';
import { registerPageRoutes } from './routes/pages.ts';
import { registerExternalShareRoutes } from './routes/externalShare.ts';
import { registerCompanionRoute } from './routes/companion.ts';
import { registerMermaidAssetRoute } from './routes/mermaidAsset.ts';
import { registerDevFixtureRoute } from './routes/devFixture.ts';
import { registerMockAuthRoutes } from './routes/mockAuth.ts';
import { registerThreadRoutes } from './routes/threads.ts';
import { registerCommentRoutes } from './routes/comments.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerRecordRoutes } from './routes/records.ts';
import { registerEmbedRoutes } from './routes/embeds.ts';
import { registerChoiceRoutes } from './routes/choices.ts';
import { registerTaskRoutes } from './routes/tasks.ts';
import { registerCatchUpRoutes } from './routes/catchup.ts';
import { registerCitationRoutes } from './routes/citations.ts';
import { registerPromoteRoutes } from './routes/promote.ts';
import { registerMentionNotifications } from './live/mentions.ts';
import { registerAutoCheckpoints } from './live/autoCheckpoint.ts';
import { registerAdminRoute } from './routes/admin.ts';
import { registerVersionRoutes } from './routes/versions.ts';
import { registerWidgetRoutes } from './routes/widgets.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerMeRoute } from './routes/me.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerDeviceRoutes } from './routes/device.ts';
import { registerTokenRoutes } from './routes/tokens.ts';
import { registerAgentRoutes } from './routes/agents.ts';
import { registerLiveRoutes } from './routes/live.ts';
import { registerRunRoutes } from './routes/runs.ts';
import { registerSuggestionRoutes } from './routes/suggestions.ts';
import { parseAdminEmails } from './auth/admin.ts';
import { registerCollaboratorRoutes } from './routes/collaborators.ts';
import { registerExternalShareAdminRoutes } from './routes/externalShareAdmin.ts';
import { registerFolderRoutes } from './routes/folders.ts';
import { registerDocumentFolderRoutes } from './routes/documentFolder.ts';
import { registerLibraryRoute } from './routes/library.ts';
import { registerOAuthRoutes } from './auth/oauth/routes.ts';
import { registerMcpRoute } from './mcp/routes.ts';
import { registerHealthRoutes, type DatabaseCheck } from './routes/health.ts';
import type { Storage } from './storage/types.ts';
import type { Notifier } from './notifications/notifier.ts';
import type { OktaAdapter } from './auth/okta.ts';
import type { ApiTokenScope } from '@polygonlabs/primer-api-types';

/** Who is making a request. An agent acts via a person (`viaUserId`); see
 *  lib/permissions.ts for how its role is derived. */
export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  kind: 'person' | 'agent';
  viaUserId: string | null;
};

export type AppVariables = {
  user: AuthUser;
  authMethod?: 'bearer' | 'cookie' | 'mock';
  /** Set only for scoped API tokens; absent = unrestricted. See auth/scopes.ts. */
  tokenScopes?: readonly ApiTokenScope[];
};

export interface AppDeps {
  storage: Storage;
  notifier: Notifier;
  userResolver?: UserResolver;     // defaults to mockResolver (tests + dev)
  oktaAdapter?: OktaAdapter;            // NEW
  proxyAuth?: boolean;                  // AUTH_MODE=proxy: no login flow, 401 page instead
  authCookieName?: string;              // NEW; defaults to 'primer_sid'
  authStateCookieName?: string;         // NEW; defaults to 'primer_auth_state'
  authBaseUrl?: string;                 // NEW; base URL used in device verification links
  adminEmails?: string[];               // normalized allowlist; defaults to ADMIN_EMAILS env
  checkDatabase?: DatabaseCheck;        // /api/ready probe; defaults to `select 1`
}

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  const issuer = (
    process.env.OAUTH_ISSUER ??
    deps.authBaseUrl ??
    process.env.AUTH_BASE_URL ??
    ''
  ).replace(/\/$/, '');

  const resolver = deps.userResolver ?? mockResolver;
  app.use(
    '*',
    authMiddleware(resolver, {
      ...(issuer.length > 0 ? { issuer } : {}),
      ...(deps.proxyAuth ? { unauthenticatedPage: proxyUnauthorizedPage } : {}),
    }),
  );
  app.use('*', scopeMiddleware);
  app.use('*', csrfMiddleware);

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    appLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
        user_id: c.get('user')?.id,
      },
      'request'
    );
  });

  registerHealthRoutes(app, { checkDatabase: deps.checkDatabase });
  registerUploadRoute(app, deps);
  registerConvertRoute(app);
  registerDocumentRoutes(app, deps);
  registerCollaboratorRoutes(app, deps);
  registerExternalShareAdminRoutes(app, deps);
  registerVersionContentRoute(app, deps);
  registerPageRoutes(app, deps);
  registerExternalShareRoutes(app, deps);
  registerCompanionRoute(app);
  registerMermaidAssetRoute(app);
  registerThreadRoutes(app, deps);
  registerLiveRoutes(app, deps);
  registerRunRoutes(app);
  registerSuggestionRoutes(app);
  registerCommentRoutes(app, deps);
  registerEventRoutes(app, { resolver });
  registerRecordRoutes(app);
  registerChoiceRoutes(app);
  registerEmbedRoutes(app);
  registerTaskRoutes(app);
  registerCatchUpRoutes(app, deps);
  registerCitationRoutes(app);
  registerPromoteRoutes(app, deps);
  registerMentionNotifications(deps.notifier);
  registerAutoCheckpoints(deps.storage);
  registerFolderRoutes(app);
  registerDocumentFolderRoutes(app);
  registerLibraryRoute(app);
  registerAdminRoute(app);
  registerVersionRoutes(app);
  registerWidgetRoutes(app);
  registerAuthRoutes(app, deps);
  const adminEmails = deps.adminEmails ?? parseAdminEmails(process.env.ADMIN_EMAILS);
  registerMeRoute(app, { adminEmails });
  registerUserRoutes(app);
  registerDeviceRoutes(app, { baseUrl: deps.authBaseUrl ?? process.env.AUTH_BASE_URL ?? '' });
  registerTokenRoutes(app);
  registerAgentRoutes(app);

  if (issuer.length > 0) {
    registerOAuthRoutes(app, {
      issuer,
      sessionCookieName: deps.authCookieName ?? 'primer_sid',
    });
    registerMcpRoute(app, {
      storage: deps.storage,
      notifier: deps.notifier,
      apiBaseUrl: issuer,
    });
  }

  if (process.env.NODE_ENV !== 'production') {
    registerDevFixtureRoute(app);
    // Mock-persona selector: strictly inside BOTH gates — dev only AND mock
    // auth only. index.ts already refuses AUTH_MODE=mock in production at
    // boot; this repeats the check so the route can never be registered by
    // any other composition path. Under AUTH_MODE=okta it does not exist.
    if ((process.env.AUTH_MODE ?? '').toLowerCase() === 'mock') {
      registerMockAuthRoutes(app);
    }
  }

  // Production: serve the built SPA. Dev: Vite handles this at :5173, skip.
  if (process.env.SERVE_STATIC === '1') {
    // Default: resolve relative to this source file so the path is correct
    // regardless of cwd (the repo root or the package dir).
    const here = dirname(fileURLToPath(import.meta.url));
    const staticRoot = process.env.STATIC_ROOT ?? resolvePath(here, '../../web/dist');
    // Brand assets are fetched from inside the sandboxed artifact iframe,
    // whose opaque origin makes every @font-face request cross-origin
    // (Origin: null) — without ACAO the fonts silently fall back to the
    // system stack. The files are contract-named and immutable (see
    // web/public/brand/README.md), so cache them hard.
    app.use('/brand/*', async (c, next) => {
      await next();
      c.res.headers.set('Access-Control-Allow-Origin', '*');
      c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.use('/*', serveStatic({ root: staticRoot }));
    app.get('/*', async (c) => {
      const p = c.req.path;
      if (p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/companion/')) {
        return c.notFound();
      }
      // Only fall back to index.html for routes (no file extension after the last /).
      // Missing assets like /assets/foo.js stay as 404 so we don't mask bad bundle paths.
      const last = p.slice(p.lastIndexOf('/') + 1);
      if (last.includes('.')) return c.notFound();
      try {
        const html = await readFile(resolvePath(staticRoot, 'index.html'), 'utf-8');
        return c.html(html);
      } catch {
        return c.text('SPA build missing', 500);
      }
    });
  }

  return app;
}
