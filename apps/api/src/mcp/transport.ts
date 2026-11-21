import type { Context } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AppVariables } from '../app.ts';
import { tokenScopes } from '../auth/scopes.ts';
import {
  buildMcpToolHandlers,
  TOOL_CONFIGS,
  toolsForScopes,
  type ToolDeps,
} from './tools.ts';
import { MCP_INSTRUCTIONS, registerAuthoringResource } from './authoring.ts';

export interface McpTransportDeps extends ToolDeps {
  serverName?: string;
  serverVersion?: string;
}

/**
 * Handles a single /mcp POST by building a fresh MCP server + Streamable HTTP
 * transport per request. Stateless: no session store, no notifications, no
 * subscriptions. The tool handlers see the request user via a closure —
 * captured from `c.get('user')` at request time.
 */
export async function handleMcpRequest(
  c: Context<{ Variables: AppVariables }>,
  deps: McpTransportDeps,
): Promise<Response> {
  const user = c.get('user');
  // authMiddleware only reaches the handler when user is set — but be defensive.
  if (!user) {
    return c.json({ jsonrpc: '2.0', error: { code: -32001, message: 'not_authenticated' } }, 401);
  }

  const handlers = buildMcpToolHandlers(deps);
  const server = new McpServer(
    { name: deps.serverName ?? 'primer', version: deps.serverVersion ?? '0.0.0' },
    { instructions: MCP_INSTRUCTIONS },
  );
  registerAuthoringResource(server);

  // Scoped API tokens only see the tools their scopes grant.
  for (const name of toolsForScopes(tokenScopes(c))) {
    const config = TOOL_CONFIGS[name];
    const handler = handlers[name];
    server.registerTool(
      name,
      { description: config.description, inputSchema: config.inputSchema },
      async (args: Record<string, unknown>) => {
        const { images, ...result } = await handler(args ?? {}, user, tokenScopes(c));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (images ? { ...result, content: [...result.content, ...images] } : result) as any;
      },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });
  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
}
