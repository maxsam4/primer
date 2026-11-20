import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { handleMcpRequest, type McpTransportDeps } from './transport.ts';

export function registerMcpRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: McpTransportDeps,
): void {
  app.on('POST', '/mcp', async (c) => {
    // authMiddleware owns the 401 + WWW-Authenticate branch for /mcp. If we
    // reach this handler, the user is authenticated.
    return handleMcpRequest(c, deps);
  });
  // Stateless: no server-to-client SSE stream and no sessions to end. The MCP
  // spec's answer is 405, which tells a client not to open that stream; without
  // it a GET fell through to the web app's HTML and clients retried each second.
  app.on(['GET', 'DELETE'], '/mcp', (c) => c.body(null, 405, { Allow: 'POST' }));
}
