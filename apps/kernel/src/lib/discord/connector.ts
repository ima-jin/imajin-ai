/**
 * Discord connector backend library (#18).
 *
 * Connects a human DID's Discord Bot Token (sealed in imajin-vault) to the
 * Discord REST API v10, gated by an active `auth.channel_links` row for the
 * discord connector app DID + the required scope.
 *
 * Mirrors the #1228 GitHub connector's security shape exactly:
 * - Fail-closed on every gate: no active grant OR no sealed token ⇒ throw.
 * - Token is NEVER logged, NEVER returned to callers, NEVER echoed.
 * - Per-DID vault field isolation: `discord-bot-token:${ownerDid}`.
 * - Cross-DID reads are structurally impossible: field name encodes owner DID.
 *
 * ── Attribution ───────────────────────────────────────────────────────────────
 * After each successful Discord post, a `discord.message.posted` bus event is
 * published non-fatally (mirroring the `github.issue.created` pattern).
 */
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { sealAndStore, loadAndUnseal } from '@/src/lib/vault';

const log = createLogger('kernel');

/** Connector app DID — matches the scope-manifest for the discord connector. */
export const DISCORD_CONNECTOR_DID = 'did:imajin:discord-connector';

/** Channel name — matches the scope-manifest fixture `channel:` field. */
const DISCORD_CHANNEL = 'discord';

/** Discord REST API base URL (v10). */
const DISCORD_API_BASE = 'https://discord.com/api/v10';

// ── Vault field helpers ───────────────────────────────────────────────────────

/**
 * Per-DID vault field name for a Discord Bot Token.
 *
 * Encoding ownerDid in the field name ensures per-DID isolation at the vault
 * layer: different DIDs cannot share or cross-read each other's tokens.
 */
export function vaultField(ownerDid: string): string {
  return `discord-bot-token:${ownerDid}`;
}

/**
 * Seal and store a Discord Bot Token for the given DID.
 *
 * The plaintext token is never logged or returned; the only observable output
 * is the sealed VaultEntry. Callers must validate the token is non-empty.
 */
export async function sealToken(ownerDid: string, token: string): Promise<void> {
  await sealAndStore(vaultField(ownerDid), token);
}

// ── Grant resolution ──────────────────────────────────────────────────────────

/**
 * Check whether an active `channel_links` row exists for this DID + scope.
 *
 * Returns `true` only when at least one ACTIVE row for the discord channel
 * and the discord connector app DID contains the requested scope.
 * Fail-closed: any DB error propagates as a thrown exception.
 */
export async function resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, DISCORD_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, DISCORD_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.some((row) => {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return scopes.includes(requiredScope);
  });
}

// ── Gate helper ───────────────────────────────────────────────────────────────

/**
 * Resolve the connector grant and unseal the bot token. Fail-closed on both gates.
 *
 * This is the single mandatory entry point for all Discord tools.
 * The resolved token is returned only to the calling scope; it must not be
 * logged, stored in plaintext, or returned to external callers.
 *
 * Throws:
 *   - `discord_no_grant` — no active channel_links row for ownerDid + scope.
 *   - `discord_no_token` — no sealed bot token in the vault for ownerDid.
 *   - Any vault integrity error from loadAndUnseal.
 */
async function requireGrantAndToken(ownerDid: string, scope: string): Promise<string> {
  const hasGrant = await resolveActiveGrant(ownerDid, scope);
  if (!hasGrant) {
    throw new Error(
      `discord_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `edit the scope-manifest to enable this connector scope`,
    );
  }

  const token = await loadAndUnseal(vaultField(ownerDid));
  if (token === undefined) {
    throw new Error(
      `discord_no_token: no Discord Bot Token sealed for DID ${ownerDid} — ` +
      `use discord_connect to store a token first`,
    );
  }

  return token;
}

// ── Discord REST API helper ───────────────────────────────────────────────────

interface DiscordApiOptions {
  method: 'GET' | 'POST';
  path: string;
  token: string;
  body?: Record<string, unknown>;
}

/**
 * Call the Discord REST API v10. Throws a descriptive error on non-2xx responses.
 *
 * The token is only used in the Authorization header; it is never logged.
 */
async function callDiscordApi(opts: Readonly<DiscordApiOptions>): Promise<unknown> {
  const url = `${DISCORD_API_BASE}${opts.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bot ${opts.token}`,
    'User-Agent': 'imajin-mcp/1.0',
  };

  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord API error ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json() as Promise<unknown>;
}

// ── Public Discord actions ────────────────────────────────────────────────────

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: { id: string; username: string } | null;
}

/**
 * Post a message to a Discord channel on behalf of ownerDid.
 *
 * Gates: active `discord:post` channel_links row + sealed bot token.
 * Attribution: publishes `discord.message.posted` bus event (non-fatal).
 */
export async function postMessage(
  ownerDid: string,
  channelId: string,
  content: string,
): Promise<DiscordMessage> {
  const token = await requireGrantAndToken(ownerDid, 'discord:post');

  const data = await callDiscordApi({
    method: 'POST',
    path: `/channels/${channelId}/messages`,
    token,
    body: { content },
  }) as DiscordMessage;

  try {
    await bus.publish('discord.message.posted', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'discord',
      payload: {
        ownerDid,
        channelId,
        messageId: data.id,
        context_id: data.id,
        context_type: 'discord' as const,
      },
    });
  } catch (err) {
    log.error(
      { err: String(err), channelId, messageId: data.id },
      'discord.message.posted publish failed (non-fatal)',
    );
  }

  return data;
}

/**
 * Read recent messages from a Discord channel on behalf of ownerDid.
 *
 * Gates: active `discord:read` channel_links row + sealed bot token.
 */
export async function readMessages(
  ownerDid: string,
  channelId: string,
  limit: number = 50,
): Promise<DiscordMessage[]> {
  const token = await requireGrantAndToken(ownerDid, 'discord:read');

  const clampedLimit = Math.min(Math.max(1, limit), 100);

  return callDiscordApi({
    method: 'GET',
    path: `/channels/${channelId}/messages?limit=${clampedLimit}`,
    token,
  }) as Promise<DiscordMessage[]>;
}
