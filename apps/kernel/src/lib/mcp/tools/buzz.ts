/**
 * MCP Buzz/Nostr connector tools (#1412).
 *
 * Adds `buzz_*` tools to the MCP registry. All tools act on behalf of
 * `ctx.did`; no tool ever accesses a different DID's vault.
 *
 * ── Key generation ────────────────────────────────────────────────────────────
 * `buzz_connect`: generates a vault-sealed secp256k1 keypair.
 * The private key is NEVER logged, NEVER echoed, NEVER returned.
 *
 * ── Message send ──────────────────────────────────────────────────────────────
 * `buzz_send_message`: NIP-42 relay auth + NIP-29 kind:9 send.
 *
 * Template: modelled on tools/discord.ts (same security shape, same scope gate).
 * RFC-32 federated-growth contract: only this file + tools/index.ts change
 * when adding or removing a Buzz tool.
 */
import type { McpTool } from '../types';
import { str, json } from './utils';
import { generateAndSeal, getPublicKey, sendKind9 } from '@/src/lib/buzz/connector';

// ── Key generation ─────────────────────────────────────────────────────────────

const connectTool: McpTool = {
  name: 'buzz_connect',
  requiredScope: 'buzz:write',
  description:
    'Generate a vault-sealed secp256k1 Nostr keypair for your DID. ' +
    'The private key is encrypted immediately on generation and is never logged, ' +
    'echoed, or returned. Returns only the public key (hex). ' +
    'Re-run to rotate the key. ' +
    'Requires an active buzz:write grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    const { pubkeyHex } = await generateAndSeal(ctx.did);
    // Private key never surfaced — return only the safe public key.
    return json({ connected: true, did: ctx.did, nostr_pubkey: pubkeyHex });
  },
};

// ── Message send ───────────────────────────────────────────────────────────────

const sendMessageTool: McpTool = {
  name: 'buzz_send_message',
  requiredScope: 'buzz:write',
  description:
    'Send a NIP-29 kind:9 group message to a Buzz/Nostr relay. ' +
    'Authenticates to the relay via NIP-42 challenge-response (using your ' +
    'vault-sealed Nostr key), then publishes a signed kind:9 event with the ' +
    'required #h group tag. Waits for relay confirmation before returning. ' +
    'Requires buzz_connect to have been run first. ' +
    'Requires an active buzz:write grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {
      relay_url: {
        type: 'string',
        description: 'WebSocket URL of the Nostr/Buzz relay (e.g. wss://relay.example.com)',
      },
      group_id: {
        type: 'string',
        description: 'NIP-29 group ID — the value of the #h tag',
      },
      content: {
        type: 'string',
        description: 'Message content to publish to the group',
      },
    },
    required: ['relay_url', 'group_id', 'content'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const relayUrl = str(args, 'relay_url');
    if (relayUrl === undefined) throw new Error('relay_url is required');
    const groupId = str(args, 'group_id');
    if (groupId === undefined) throw new Error('group_id is required');
    const content = str(args, 'content');
    if (content === undefined) throw new Error('content is required');

    const { eventId } = await sendKind9(ctx.did, relayUrl, groupId, content);
    return json({ sent: true, event_id: eventId });
  },
};

// ── Status / key inspect ───────────────────────────────────────────────────────

const statusTool: McpTool = {
  name: 'buzz_status',
  requiredScope: 'buzz:write',
  description:
    'Check whether a Nostr keypair is sealed for your DID, and return the ' +
    'public key if so. Safe to call at any time. ' +
    'Requires an active buzz:write grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    const pubkeyHex = await getPublicKey(ctx.did);
    if (pubkeyHex === undefined) {
      return json({ connected: false, did: ctx.did });
    }
    return json({ connected: true, did: ctx.did, nostr_pubkey: pubkeyHex });
  },
};

export const buzzTools: McpTool[] = [connectTool, sendMessageTool, statusTool];
