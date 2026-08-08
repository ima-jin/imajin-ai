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
import { and, eq, inArray } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { MCP_CONNECTOR_DID, MCP_CHANNEL } from './oauth-config';

/**
 * Return `true` iff an active `auth.channel_links` row exists for this DID +
 * scope, scoped to the calling client when `appDid` is given (#1695).
 *
 * An active row is created by the scope-manifest projection surface (#1209)
 * when the owner grants the scope by editing their MCP scope-manifest asset.
 * The row is flipped to `revoked` when the scope is removed from the manifest
 * or the manifest asset is deleted (#1208).
 *
 * `appDid` is the calling client's app DID (`ctx.appDid`, the access token's
 * `azp`). Per #1695, a grant used to be checked against the constant
 * `MCP_CONNECTOR_DID` for every client, so one client's consent silently
 * covered every other MCP client that ever connected. Now:
 *   - When `appDid` is given, a row written for THAT client (per-client grant)
 *     satisfies the check, and so does a legacy connector-wide row (written
 *     before this fix, `appDid = MCP_CONNECTOR_DID`) — additive, no backfill,
 *     so pre-existing grants keep working until explicitly republished.
 *   - When `appDid` is omitted, behavior is unchanged: only the connector-wide
 *     row is checked.
 *
 * Fail-closed: any DB error propagates as a thrown exception.
 */
export async function resolveActiveMcpGrant(
  ownerDid: string,
  scope: string,
  appDid?: string,
): Promise<boolean> {
  const identities = appDid && appDid !== MCP_CONNECTOR_DID
    ? [appDid, MCP_CONNECTOR_DID]
    : [MCP_CONNECTOR_DID];

  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, MCP_CHANNEL),
        eq(channelLinks.did, ownerDid),
        inArray(channelLinks.appDid, identities),
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
 * scope-manifest grant (all `media:*` and `connections:read` tools). Pass
 * `ctx.appDid` so the grant is checked per calling client (#1695).
 */
export async function requireMcpGrant(ownerDid: string, scope: string, appDid?: string): Promise<void> {
  const hasGrant = await resolveActiveMcpGrant(ownerDid, scope, appDid);
  if (!hasGrant) {
    throw new Error(
      `mcp_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `edit the MCP scope-manifest (metadata.kind: scope-manifest, connector: ${MCP_CONNECTOR_DID}) ` +
      `to enable this scope`,
    );
  }
}

// ── Discovery surface (#1636, re-homed by #1679) ───────────────────────────

/**
 * The read-only scope gating the node's self-description surface.
 *
 * Owned by the MCP connector rather than Warp (#1679): exercising it unseals
 * nothing and spends nothing, so it has no business behind a card that first
 * asks for a Warp Agent key. It reads the OpenAPI specs, the scope vocabulary,
 * and the caller's OWN connector status — nothing else, and nothing for anyone
 * else's DID.
 *
 * There is no write counterpart on purpose — writes go through git/PR.
 */
export const MCP_DISCOVERY_SCOPE = 'discovery:read';

/**
 * Fail-closed gate for the read-only discovery surface.
 *
 * The token-scope check in `handleMcpRpc` is the coarse OAuth gate; this is the
 * sovereignty gate — an active `mcp` channel_links row carrying the scope,
 * written when the owner publishes their MCP scope-manifest with the toggle on.
 * Removing the toggle revokes the row and closes the surface on the next call.
 *
 * Unlike the credential gates this returns nothing: there is no key to unwrap.
 */
export async function requireDiscoveryGrant(ownerDid: string): Promise<void> {
  const hasGrant = await resolveActiveMcpGrant(ownerDid, MCP_DISCOVERY_SCOPE);
  if (!hasGrant) {
    throw new Error(
      `mcp_no_grant: DID ${ownerDid} has no active '${MCP_DISCOVERY_SCOPE}' grant — ` +
      `enable it on the Imajin MCP connector card to read the node API specs, the ` +
      `scope vocabulary, and your connector status. No credential is required.`,
    );
  }
}
