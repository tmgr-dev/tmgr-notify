import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildEndpoint, loadConfig } from './config.js';
import { sendPush } from './http-client.js';
import { buildPushPayload } from './payload.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'tmgr-notify', version: '0.1.0' });

  server.registerTool(
    'notify_user',
    {
      description: 'Send a phone push notification to the user via TMGR agent notifications.',
      inputSchema: {
        title: z.string().min(1).max(120).describe('Notification title'),
        body: z.string().max(1000).optional().describe('Notification body'),
        priority: z.enum(['low', 'normal', 'high']).optional().describe('Priority, default normal'),
        link: z.string().url().optional().describe('Absolute http(s) URL to open on tap'),
      },
    },
    async ({ title, body, priority, link }) => {
      let config;
      try {
        config = loadConfig();
      } catch (err) {
        return {
          content: [{ type: 'text', text: `error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      const payload = buildPushPayload({ title, body, priority, link });
      const result = await sendPush(payload, { endpoint: buildEndpoint(config.baseUrl), token: config.token });

      if (result.ok) {
        return { content: [{ type: 'text', text: result.status }] };
      }
      if (result.kind === 'rate_limited') {
        const suffix = result.retryAfter ? ` (retry after ${result.retryAfter}s)` : '';
        return { content: [{ type: 'text', text: `rate limited${suffix}` }], isError: true };
      }
      return { content: [{ type: 'text', text: `error: ${result.message}` }], isError: true };
    }
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
