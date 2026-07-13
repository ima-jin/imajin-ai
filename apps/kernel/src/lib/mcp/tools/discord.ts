/**
 * MCP Discord connector tools (#18).
 *
 * Adds `discord_*` tools to the MCP registry. All tools act on behalf of
 * `ctx.did` (the resource-owner DID from the OAuth access token); no tool
 * ever accesses a different DID's vault or grant.
 *
 * ── Token ingestion ───────────────────────────────────────────────────────────
 * `discord_connect`: takes the bot token and seals it immediately via the vault.
 * The token is NEVER logged, NEVER echoed back, NEVER exposed beyond the
 * scope of the `sealToken` call.
 *
 * ── Discord actions ───────────────────────────────────────────────────────────
 * `discord_post_message`  — requiredScope: 'discord:post'
 * `discord_read_messages` — requiredScope: 'discord:read'
 *
 * Template: modelled verbatim on tools/github.ts.
 * RFC-32 federated-growth contract: only this file + tools/index.ts change
 * when adding or removing a Discord tool.
 */
import type { McpTool, McpContent } from '../types';
import { sealToken, postMessage, readMessages } from '@/src/lib/discord/connector';

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

function json(value: unknown): McpContent[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

// ── Token ingestion ───────────────────────────────────────────────────────────

const connectTool: McpTool = {
  name: 'discord_connect',
  requiredScope: 'discord:post',
  description:
    'Seal your Discord Bot Token in the Imajin vault so that discord_post_message ' +
    'can post to channels on your behalf. ' +
    'The token is encrypted immediately on receipt and is never logged, echoed, ' +
    'or returned. Run this once; re-run to rotate the token. ' +
    'Requires an active discord:post grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'Your Discord Bot Token (from the Discord Developer Portal)',
      },
    },
    required: ['token'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const token = str(args, 'token');
    if (token === undefined) throw new Error('token is required');

    await sealToken(ctx.did, token);

    // Do NOT echo the token or any derivative. Return only a safe confirmation.
    return json({ connected: true, did: ctx.did });
  },
};

// ── Write tools ───────────────────────────────────────────────────────────────

const postMessageTool: McpTool = {
  name: 'discord_post_message',
  requiredScope: 'discord:post',
  description:
    'Post a message to a Discord channel on your behalf using your sealed Bot Token. ' +
    'The message is sent as the bot user associated with your token. ' +
    'Requires an active discord:post grant in your scope-manifest and a ' +
    'stored token from discord_connect.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Discord channel ID to post the message to',
      },
      content: {
        type: 'string',
        description: 'Message content (plain text or Discord markdown)',
      },
    },
    required: ['channel_id', 'content'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const channelId = str(args, 'channel_id');
    if (channelId === undefined) throw new Error('channel_id is required');
    const content = typeof args.content === 'string' ? args.content : '';

    const message = await postMessage(ctx.did, channelId, content);

    return json({
      id: message.id,
      channel_id: message.channel_id,
      timestamp: message.timestamp,
    });
  },
};

// ── Read tools ────────────────────────────────────────────────────────────────

const readMessagesTool: McpTool = {
  name: 'discord_read_messages',
  requiredScope: 'discord:read',
  description:
    'Read recent messages from a Discord channel on your behalf using your sealed Bot Token. ' +
    'Returns up to 100 messages (default 50). ' +
    'Requires an active discord:read grant in your scope-manifest and a stored token from discord_connect.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: {
        type: 'string',
        description: 'Discord channel ID to read messages from',
      },
      limit: {
        type: 'number',
        description: 'Number of messages to return (1–100, default 50)',
      },
    },
    required: ['channel_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const channelId = str(args, 'channel_id');
    if (channelId === undefined) throw new Error('channel_id is required');
    const limit = num(args, 'limit') ?? 50;

    const messages = await readMessages(ctx.did, channelId, limit);

    return json(
      messages.map((m) => ({
        id: m.id,
        author: m.author?.username ?? null,
        content: m.content,
        timestamp: m.timestamp,
      })),
    );
  },
};

export const discordTools: McpTool[] = [
  connectTool,
  postMessageTool,
  readMessagesTool,
];
