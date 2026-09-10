/**
 * MCP Gmail connector tools (#2144, v1).
 *
 * `google_gmail_list_threads` / `google_gmail_get_message` — requiredScope: 'google:gmail:read'
 * `google_gmail_send`                                      — requiredScope: 'google:gmail:send'
 * `google_gmail_watch`                                     — requiredScope: 'google:gmail:read'
 *
 * All tools act on behalf of `ctx.did`, the resource-owner DID from the MCP
 * access token — modelled on `github.ts`.
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import { listThreads, getMessage, sendMessage, watch } from '@/src/lib/google/gmail';

const listThreadsTool: McpTool = {
  name: 'google_gmail_list_threads',
  requiredScope: 'google:gmail:read',
  description:
    'List your Gmail threads, optionally filtered by Gmail search syntax (e.g. "from:boss@example.com is:unread"). ' +
    'Requires an active google:gmail:read grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query, e.g. "is:unread newer_than:7d"' },
      maxResults: { type: 'number', description: 'Max threads to return (default 20, ceiling 100)' },
      pageToken: { type: 'string', description: 'Page token from a previous call, to continue listing' },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const result = await listThreads(ctx.did, {
      query: str(args, 'query'),
      maxResults: num(args, 'maxResults'),
      pageToken: str(args, 'pageToken'),
    });
    return json(result);
  },
};

const getMessageTool: McpTool = {
  name: 'google_gmail_get_message',
  requiredScope: 'google:gmail:read',
  description: 'Get one Gmail message by id. Requires an active google:gmail:read grant.',
  inputSchema: {
    type: 'object',
    properties: {
      messageId: { type: 'string', description: 'Gmail message id' },
    },
    required: ['messageId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const messageId = str(args, 'messageId');
    if (messageId === undefined) throw new Error('messageId is required');
    return json(await getMessage(ctx.did, messageId));
  },
};

const sendTool: McpTool = {
  name: 'google_gmail_send',
  requiredScope: 'google:gmail:send',
  description:
    'Send an email on your behalf via Gmail. Sent-as is your own connected mailbox; the send is recorded as a ' +
    'signed mail.sent event with onBehalfOf set to your DID. Requires an active google:gmail:send grant.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject' },
      body: { type: 'string', description: 'Plain-text email body' },
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const to = str(args, 'to');
    const subject = str(args, 'subject');
    const body = str(args, 'body');
    if (to === undefined || subject === undefined || body === undefined) {
      throw new Error('to, subject, and body are all required');
    }
    return json(await sendMessage(ctx.did, { to, subject, body }));
  },
};

const watchTool: McpTool = {
  name: 'google_gmail_watch',
  requiredScope: 'google:gmail:read',
  description:
    'Register (or renew) a Gmail push subscription so new mail arrives as mail.received signed events instead of ' +
    'requiring polling. A daily cron also renews this automatically before Google\u2019s ~7-day expiry; call this only ' +
    'to (re)start push immediately after connecting. Requires an active google:gmail:read grant.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    return json(await watch(ctx.did));
  },
};

export const gmailTools: McpTool[] = [listThreadsTool, getMessageTool, sendTool, watchTool];
