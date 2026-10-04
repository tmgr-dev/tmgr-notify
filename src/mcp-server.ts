import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createAlarm, getAlarm, waitForAlarm } from './alarm-client.js';
import { formatAlarm, formatAlarmFailure } from './alarm-format.js';
import { buildAlarmsUrl, buildEndpoint, loadConfig } from './config.js';
import { sendPush } from './http-client.js';
import { buildPushPayload } from './payload.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'tmgr-notify', version: '0.2.0' });

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

  const configOrError = () => {
    try {
      return { config: loadConfig() };
    } catch (err) {
      return { error: textResult(`error: ${err instanceof Error ? err.message : String(err)}`, true) };
    }
  };

  server.registerTool(
    'alarm',
    {
      description:
        "Only for incidents that need the human NOW (production down, data loss, security). Rings the owner's phone: silent push to the app alarm, then a voice call if not acknowledged. Prefer notify_user for everything else. Calls repeat up to callAttempts times (default 3) until acknowledged. You decide when/whether to retry; one call = one escalation.",
      inputSchema: {
        title: z.string().min(1).max(120).describe('Alarm title, read aloud on the call'),
        message: z.string().min(1).max(500).describe('What happened and what is needed, read aloud on the call'),
        ackTimeoutSeconds: z.number().int().positive().optional().describe('Seconds to wait for an app acknowledgement before calling'),
        deliveryTimeoutSeconds: z.number().int().positive().optional().describe('Seconds to wait for the app to receive the alarm before calling'),
        call: z.boolean().optional().describe('Voice-call fallback (default true). With false the alarm ends expired if not acknowledged in the app'),
        callAttempts: z.number().int().min(1).max(5).optional().describe('Voice-call attempts until acknowledged (1-5, default 3)'),
        waitForResult: z.boolean().optional().describe('Wait for a final status (default true); false returns {id, status} immediately'),
        maxWaitSeconds: z
          .number()
          .positive()
          .max(3600)
          .optional()
          .describe('Overall wait cap in seconds when waiting (default 600). On timeout the last status is returned with timedOut=true; re-check with alarm_status'),
      },
    },
    async ({ title, message, ackTimeoutSeconds, deliveryTimeoutSeconds, call, callAttempts, waitForResult, maxWaitSeconds }, extra) => {
      const { config, error } = configOrError();
      if (!config) return error;
      const opts = { alarmsUrl: buildAlarmsUrl(config.baseUrl), token: config.token };

      const created = await createAlarm(
        {
          title,
          message,
          ...(ackTimeoutSeconds !== undefined ? { ackTimeoutSeconds } : {}),
          ...(deliveryTimeoutSeconds !== undefined ? { deliveryTimeoutSeconds } : {}),
          ...(call !== undefined ? { call } : {}),
          ...(callAttempts !== undefined ? { callAttempts } : {}),
        },
        opts
      );
      if (!created.ok) return textResult(formatAlarmFailure(created), true);

      if (waitForResult === false) {
        return textResult(JSON.stringify({ id: created.alarm.id, status: created.alarm.status }));
      }

      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const result = await waitForAlarm(created.alarm.id, {
        ...opts,
        maxWaitSeconds,
        onUpdate: async (alarm) => {
          if (progressToken === undefined) return;
          progress += 1;
          await extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress, message: `alarm ${alarm.id}: ${alarm.status}` },
            })
            .catch(() => {});
        },
      });
      if (!result.ok) return textResult(formatAlarmFailure(result, created.alarm.id), true);
      return textResult(formatAlarm(result.alarm, result.timedOut));
    }
  );

  server.registerTool(
    'alarm_status',
    {
      description:
        'Check an alarm created by the alarm tool. With waitSeconds (max 50) it long-polls until the status changes. Use it to re-check after the alarm call timed out or was started with waitForResult=false.',
      inputSchema: {
        id: z.string().min(1).describe('Alarm id returned by the alarm tool'),
        waitSeconds: z.number().int().min(0).max(50).optional().describe('Long-poll seconds, default 0'),
      },
    },
    async ({ id, waitSeconds }) => {
      const { config, error } = configOrError();
      if (!config) return error;
      const result = await getAlarm(id, waitSeconds ?? 0, { alarmsUrl: buildAlarmsUrl(config.baseUrl), token: config.token });
      if (!result.ok) return textResult(formatAlarmFailure(result), true);
      return textResult(formatAlarm(result.alarm));
    }
  );

  return server;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

export async function runMcpServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
