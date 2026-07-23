/**
 * MCP connector grant resolution (#1222).
 *
 * Back-ports the Claude/MCP connector's media + connections scopes onto the
 * #1204 control-plane pattern: scope grants now live in a userspace
 * `.fair`-signed `metadata.kind: scope-manifest` asset (channel: mcp,
 * connector: did:imajin:mcp-connector) rather than being implied by the OAuth
 * token's granted scopes alone.
 *
 * ── How grants reach channel_links ─────────────────────────────────────────
 * The user edits their MCP scope-manifest (a media asset with
 * `metadata.kind: scope-manifest` and `connector: did:imajin:mcp-connector`).
 * The existing generic projection reactor (#1207) fires on `document.changed`,
 * runs each declared scope through the broker latch, and writes / revokes rows
 * in `auth.channel_links` via `channel-links-surface.ts` (#1209).  No new
 * reactor or surface is needed — the surface is generic across all connectors.
 *
 * ── Authorization model ─────────────────────────────────────────────────────
 * OAuth token  →  authentication (who you are, which DID you are)
 * channel_links row  →  authorization (what Claude may do with your data)
 *
 * Both gates must pass for a tool call to succeed:
 *   1. `handleMcpRpc` checks `ctx.scopes.has(tool.requiredScope)` (token gate).
 *   2. The tool handler calls `requireMcpGrant(ctx.did, scope)` (manifest gate).
 *
 * This mirrors how the GitHub connector works: the token scope is the coarse
 * OAuth surface gate; the channel_links row (derived from the scope-manifest)
 * is the fine, sovereignty-preserving data-layer gate.
 *
 * Refs: #1222 (this back-port) · #1204 EPIC · #1209 channel-links surface ·
 *       #1207 projection reactor · #1203 GitHub connector (first live proof) ·
 *       src/lib/github/connector.ts (the pattern being mirrored).
 */
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { MCP_CONNECTOR_DID, MCP_CHANNEL, getMcpIssuer } from './oauth-config';

/**
 * Return `true` iff an active `auth.channel_links` row exists for this DID +
 * scope via the MCP connector.
 *
 * An active row is created by the scope-manifest projection surface (#1209)
 * when the owner grants the scope by editing their MCP scope-manifest asset.
 * The row is flipped to `revoked` when the scope is removed from the manifest
 * or the manifest asset is deleted (#1208).
 *
 * Fail-closed: any DB error propagates as a thrown exception.
 */
export async function resolveActiveMcpGrant(ownerDid: string, scope: string): Promise<boolean> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, MCP_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, MCP_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.some((row) => {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return scopes.includes(scope);
  });
}

/**
 * Assert that an active MCP scope grant exists for `ownerDid`. Throws with a
 * descriptive `mcp_no_grant` error when no active `channel_links` row is found,
 * so the MCP dispatcher returns an `isError` response the model can read.
 *
 * Call this at the top of every MCP-native tool handler that requires a
 * scope-manifest grant (all `media:*` and `connections:read` tools).
 */
export async function requireMcpGrant(ownerDid: string, scope: string): Promise<void> {
  const hasGrant = await resolveActiveMcpGrant(ownerDid, scope);
  if (!hasGrant) {
    const enableUrl = `${getMcpIssuer()}/auth/connectors?connector=mcp&scope=${encodeURIComponent(scope)}`;
    throw new Error(
      `mcp_no_grant: '${scope}' is not enabled for this account. ` +
      `Enable it at: ${enableUrl}`,
    );
  }
}
