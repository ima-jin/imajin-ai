/**
 * MCP (native) connector scope-manifest publisher (#1394 child 1).
 *
 * Thin wrapper over scope-manifest-core that supplies MCP-specific identity
 * (connector DID, channel `mcp`, scope descriptors, filename). All generic DB
 * logic, consent-grant syncing, and publish orchestration live in the core
 * module to avoid duplication.
 *
 * Unlike OAuth connectors (GitHub, QuickBooks), the MCP connector is
 * credential-free (native): enabling it is purely a matter of toggling scopes
 * in a signed scope-manifest asset. No OAuth App config, no token — the owner
 * just POSTs their desired scopes.
 *
 * Scope release tiers are DERIVED from the declarative vocabulary (#1253) via
 * the #1196 consent 2×2 — see `packages/auth/src/scope-vocabulary.ts`. To add a
 * scope to this connector, add one entry there; this module needs no edit.
 *
 * Refs: #1394 (this epic) · #1253 (vocabulary derivation) · #1222 (MCP grant
 *       back-port) · #1209 (channel-links) · #1207 (projection reactor) ·
 *       #1647 (widening frozen DCR registrations) ·
 *       scope-manifest-core (shared implementation)
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, oauthRefreshTokens, registryApps } from '@/src/db';
import {
  buildConnectorManifestContent,
  findConnectorManifestAsset,
  readActiveConnectorScopes,
  syncConnectorConsentGrants,
  publishConnectorScopeManifest,
  type Asset,
} from '@/src/lib/kernel/scope-manifest-core';
import {
  connectorScopeDescriptors,
  validScopesForConnector,
  requiresConsentRow,
} from '@/src/lib/kernel/scope-projections';
import { MCP_CONNECTOR_DID, MCP_CHANNEL } from './oauth-config';

const log = createLogger('kernel');

// ── Scope registry (derived — #1253) ────────────────────────────────────────

const CONNECTOR = 'mcp' as const;

export const MCP_SCOPE_DESCRIPTORS = connectorScopeDescriptors(CONNECTOR);

export const VALID_MCP_SCOPES = validScopesForConnector(CONNECTOR);

// ── Public API (delegates to core) ────────────────────────────────────────────

export function buildManifestContent(selectedScopes: readonly string[]): string {
  return buildConnectorManifestContent(
    MCP_CONNECTOR_DID, MCP_CHANNEL, MCP_SCOPE_DESCRIPTORS, selectedScopes,
  );
}

export function findMcpManifestAsset(ownerDid: string): Promise<Asset | null> {
  return findConnectorManifestAsset(ownerDid, MCP_CONNECTOR_DID);
}

export function readActiveMcpScopes(ownerDid: string): Promise<string[]> {
  return readActiveConnectorScopes(ownerDid, MCP_CHANNEL, MCP_CONNECTOR_DID);
}

export function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
  appDid?: string,
): Promise<void> {
  return syncConnectorConsentGrants(
    ownerDid, MCP_CONNECTOR_DID, manifestAssetId, requestedScopes,
    (s) => requiresConsentRow(CONNECTOR, s), appDid,
  );
}

/**
 * Publish the MCP scope-manifest for `ownerDid`.
 *
 * `appDid`, when given, writes the resulting `channel_links` (and, for
 * on-consent scopes, `consent_grants`) rows scoped to that specific MCP
 * client instead of the connector as a whole (#1695) — additive only; the
 * pre-existing connector-wide row (if any) is left untouched.
 */
export function publishMcpScopeManifest(
  ownerDid: string,
  scopes: readonly string[],
  appDid?: string,
): Promise<string> {
  return publishConnectorScopeManifest({
    ownerDid, connectorDid: MCP_CONNECTOR_DID, channel: MCP_CHANNEL,
    filename: 'mcp-scope-manifest.md', scopeDescriptors: MCP_SCOPE_DESCRIPTORS,
    scopes, isOnConsent: (s) => requiresConsentRow(CONNECTOR, s), appDid,
  });
}

// ── DCR registration widening (#1647) ─────────────────────────────────────────

/**
 * Client IDs the owner currently holds a live MCP session for.
 *
 * `auth.oauth_refresh_tokens` is the only link between a resource-owner DID and
 * the DCR client registrations acting on its behalf: the row carries both
 * `userDid` and `clientId`. Revoked and expired rows are excluded so a
 * long-disconnected client is never silently re-widened.
 */
async function activeMcpClientIds(ownerDid: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ clientId: oauthRefreshTokens.clientId })
    .from(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.userDid, ownerDid),
        isNull(oauthRefreshTokens.revokedAt),
        gt(oauthRefreshTokens.expiresAt, new Date()),
      ),
    );

  const clientIds = new Set<string>();
  for (const row of rows) clientIds.add(row.clientId);
  return [...clientIds];
}

/** Union `incoming` into one active client registration's `requestedScopes`. */
async function widenOneClientRegistration(
  clientId: string,
  incoming: readonly string[],
): Promise<void> {
  const [app] = await db
    .select({ requestedScopes: registryApps.requestedScopes })
    .from(registryApps)
    .where(and(eq(registryApps.id, clientId), eq(registryApps.status, 'active')))
    .limit(1);

  if (!app) return;

  const existing = Array.isArray(app.requestedScopes) ? app.requestedScopes : [];
  const existingSet = new Set(existing);
  const missing = incoming.filter((scope) => !existingSet.has(scope));
  if (missing.length === 0) return;

  await db
    .update(registryApps)
    .set({ requestedScopes: [...existingSet, ...missing], updatedAt: new Date() })
    .where(eq(registryApps.id, clientId));

  log.info({ clientId, added: missing }, 'widened MCP client requestedScopes (#1647)');
}

/**
 * Widen `requestedScopes` on active MCP client registrations for the given
 * owner DID to include the scopes they just toggled on (#1647).
 *
 * DCR registrations freeze `requestedScopes` at registration time. When the
 * vocabulary expands (e.g. `messages:*` added by #1393), existing clients
 * never pick up the new scopes — the token refresh path intersects with
 * `requestedScopes`, so scopes missing from the registration never reach
 * the JWT `scope` claim (Gate 1 blocks forever).
 *
 * This function finds the user's active MCP client registrations via their
 * active refresh tokens and adds any missing scopes from the publish request.
 * The next token refresh then picks them up via `resolveRefreshScopes`.
 *
 * Never widens past the MCP ceiling: every incoming scope is filtered through
 * `VALID_MCP_SCOPES` first, so a bogus scope string can never be written into a
 * registration.
 *
 * Idempotent: calling with the same scopes twice is a no-op.
 *
 * Fire-and-forget: the publish that triggered this already succeeded, so a
 * failure here is degraded (the user must reconnect) rather than fatal. Errors
 * are logged and swallowed — this never throws.
 */
export async function widenMcpClientScopes(
  ownerDid: string,
  scopes: readonly string[],
): Promise<void> {
  try {
    const ceiling = new Set(VALID_MCP_SCOPES);
    const incoming = [...new Set(scopes.filter((scope) => ceiling.has(scope)))];
    if (incoming.length === 0) return;

    for (const clientId of await activeMcpClientIds(ownerDid)) {
      await widenOneClientRegistration(clientId, incoming);
    }
  } catch (err) {
    log.error(
      { err: String(err), ownerDid },
      'widenMcpClientScopes failed (non-fatal) — clients keep their frozen requestedScopes',
    );
  }
}
