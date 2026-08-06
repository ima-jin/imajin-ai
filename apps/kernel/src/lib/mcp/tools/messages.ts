/**
 * MCP native Imajin messages connector tools (#1393).
 *
 * Exposes Imajin's own chat surface over MCP so the model can list the caller's
 * conversations, read recent messages, and send a message onBehalfOf the caller.
 * All tools act on `ctx.did` (the resource-owner DID from the OAuth access
 * token); no tool ever touches another DID's conversations.
 *
 * ── Scope model (mirrors the Discord connector) ─────────────────────────────
 * Read tier (disclosure, ungated beyond the grant):
 *   imajin_list_conversations — requiredScope: 'messages:read'
 *   imajin_read_messages      — requiredScope: 'messages:read'
 * Write tier (capability, onBehalfOf signing):
 *   imajin_send_message       — requiredScope: 'messages:write'
 *   imajin_send_dm            — requiredScope: 'messages:write'
 *
 * Both gates apply, exactly like every other MCP-native tool:
 *   1. server.ts checks ctx.scopes.has(requiredScope)     (OAuth token gate)
 *   2. the handler calls requireMcpGrant(ctx.did, scope)  (scope-manifest gate)
 *
 * Conversation/thread discovery is imajin_list_conversations (this file);
 * identity discovery is connections_list (connections:read, #1195) — the two
 * compose (resolve a name → DID, then list/read/send in that conversation).
 *
 * FOLLOW-UP (#1366): once the write-gating rail lands, imajin_send_message
 * should route through the human-confirm + global write rate-ceiling path.
 * Until then it follows the same requiredScope + requireMcpGrant contract as
 * the other MCP write connectors (media_*, discord_post_message).
 *
 * RFC-32 federated-growth contract: only this file + tools/index.ts change when
 * adding or removing a messages tool.
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import { requireMcpGrant } from '../mcp-grant';
import {
  listConversations,
  readConversationMessages,
  sendTextMessageAsDid,
} from '@/src/lib/chat/queries';
import { dmDid } from '@/src/lib/chat/conversation-did';

// ── Read tools ──────────────────────────────────────────────────────────────

const listConversationsTool: McpTool = {
  name: 'imajin_list_conversations',
  requiredScope: 'messages:read',
  description:
    'List your Imajin conversations (DMs and groups), so you can resolve a person or thread to a conversation id for reading or sending. ' +
    'Returns each conversation id, type, name, the other participant (for DMs), a last-message preview, and unread count. ' +
    'Only returns your own conversations. Requires an active messages:read grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    await requireMcpGrant(ctx.did, 'messages:read');
    const conversations = await listConversations(ctx.did);
    return json({
      count: conversations.length,
      conversations: conversations.map((c) => ({
        conversation_id: c.did,
        type: c.type,
        name: c.name,
        other_participant: c.otherParticipant,
        last_message_preview: c.lastMessagePreview,
        unread: c.unread,
        last_message_at: c.lastMessageAt,
      })),
    });
  },
};

const readMessagesTool: McpTool = {
  name: 'imajin_read_messages',
  requiredScope: 'messages:read',
  description:
    'Read recent messages in one of your Imajin conversations. ' +
    'Returns up to 100 messages (default 50), oldest-first. ' +
    'Use imajin_list_conversations to find the conversation_id. ' +
    'Requires an active messages:read grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'Conversation DID to read messages from (from imajin_list_conversations)',
      },
      limit: {
        type: 'number',
        description: 'Number of messages to return (1–100, default 50)',
      },
    },
    required: ['conversation_id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    await requireMcpGrant(ctx.did, 'messages:read');
    const conversationId = str(args, 'conversation_id');
    if (conversationId === undefined) throw new Error('conversation_id is required');
    const limit = num(args, 'limit') ?? 50;

    const result = await readConversationMessages(ctx.did, conversationId, limit);
    if (!result.ok) {
      throw new Error(result.error);
    }

    return json(
      result.messages.map((m) => {
        const content = m.content as Record<string, unknown> | null;
        const text = content && typeof content.text === 'string' ? content.text : null;
        return {
          id: m.id,
          from: m.fromDid,
          content_type: m.contentType,
          text,
          created_at: m.createdAt,
        };
      }),
    );
  },
};

// ── Write tool ────────────────────────────────────────────────────────────────

const sendMessageTool: McpTool = {
  name: 'imajin_send_message',
  requiredScope: 'messages:write',
  description:
    'Send a text message in one of your Imajin conversations, authored on your behalf (onBehalfOf you). ' +
    'Use imajin_list_conversations to find the conversation_id. ' +
    'Requires an active messages:write grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'Conversation DID to send the message to (from imajin_list_conversations)',
      },
      content: {
        type: 'string',
        description: 'Message text to send',
      },
    },
    required: ['conversation_id', 'content'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    await requireMcpGrant(ctx.did, 'messages:write');
    const conversationId = str(args, 'conversation_id');
    if (conversationId === undefined) throw new Error('conversation_id is required');
    const content = str(args, 'content');
    if (content === undefined) throw new Error('content is required');

    const result = await sendTextMessageAsDid(ctx.did, conversationId, content);
    if (!result.ok) {
      throw new Error(result.error);
    }

    return json({
      sent: true,
      conversation_id: conversationId,
      message_id: result.message?.id ?? null,
      created_at: result.message?.createdAt ?? null,
    });
  },
};

const sendDmTool: McpTool = {
  name: 'imajin_send_dm',
  requiredScope: 'messages:write',
  description:
    'Send a direct message to a person by their DID, authored on your behalf (onBehalfOf you). ' +
    'The DM conversation is derived deterministically from the two DIDs, so you do not need to know — ' +
    'or first create — the conversation id. ' +
    'Use connections_list (or an identity lookup) to resolve a name to the recipient DID. ' +
    'Requires an active messages:write grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Person DID to send the DM to (from connections_list or identity lookup)',
      },
      content: {
        type: 'string',
        description: 'Message text to send',
      },
    },
    required: ['to', 'content'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    await requireMcpGrant(ctx.did, 'messages:write');
    const toDid = str(args, 'to');
    if (toDid === undefined) throw new Error('to is required');
    const content = str(args, 'content');
    if (content === undefined) throw new Error('content is required');

    const conversationDid = dmDid(ctx.did, toDid);
    const result = await sendTextMessageAsDid(ctx.did, conversationDid, content);
    if (!result.ok) {
      throw new Error(result.error);
    }

    return json({
      sent: true,
      conversation_id: conversationDid,
      message_id: result.message?.id ?? null,
      created_at: result.message?.createdAt ?? null,
    });
  },
};

export const messagesTools: McpTool[] = [
  listConversationsTool,
  readMessagesTool,
  sendMessageTool,
  sendDmTool,
];
