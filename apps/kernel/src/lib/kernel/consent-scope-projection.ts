/**
 * Consent → scope-manifest publish → channel_links projection (#1804).
 *
 * The OAuth/MCP consent screen used to mint a token without ever touching a
 * connector's scope-manifest, so `auth.channel_links` stayed empty until the
 * owner separately visited the connector card and published one — every new
 * MCP user hit `mcp_no_grant` on every tool call until they found that step
 * (#1804).
 *
 * Decision (see #1804): the consent event itself now auto-publishes the
 * default scope-manifest for whatever was granted on the consent screen, for
 * EVERY granted scope (not just `silent`-tier ones) — "whatever was granted on
 * the consent screen was consented, by definition". This projects the
 * `channel_links` rows immediately, so the connector card stops being the
 * activation gate and becomes the management surface (edit / narrow / revoke
 * afterward). `requireMcpGrant` (the gate) is untouched — this only ever ADDS
 * a row for it to find.
 *
 * ── Generic across connectors and consent surfaces ──────────────────────────
 * A single OAuth/MCP consent event can grant scopes owned by several
 * connectors at once (e.g. `media:read` (mcp) + `github:read` (github) +
 * `warp:dispatch` (warp) are all carried by MCP tokens — see
 * `scope-vocabulary.ts`'s `surfaces: ['mcp']`). This helper groups the granted
 * scopes by their OWNING connector (derived from the vocabulary, never
 * hand-maintained) and publishes/merges each connector's own scope-manifest via
 * the SAME generic publish path the connector card uses
 * (`publishConnectorScopeManifest`) — one artifact, two surfaces, no parallel
 * projection path.
 *
 * This module deliberately takes only `(ownerDid, appDid, scopes)` — no
 * MCP-specific types — so a parallel consent surface (#1803, app-authorization
 * consent) can call the exact same primitive.
 *
 * ── Idempotent / additive, never re-widens a narrowed scope ─────────────────
 * Re-consent (same client re-authorizes, or a scope is added to an existing
 * grant) must MERGE into the existing manifest, not clobber it:
 *   - Every scope already ACTIVE on the connector-wide manifest is always
 *     preserved (the union below never drops it), so an unrelated consent
 *     event can never narrow what the owner already published via the card.
 *   - A newly granted scope is added UNLESS the connector-wide manifest has
 *     EVER held (and then revoked) that exact scope before — that revocation
 *     is the one durable signal available that the owner explicitly narrowed
 *     it via the card, and auto-publish must never re-widen that choice.
 *
 * Caveat (documented rather than guessed around): `auth.channel_links` cannot
 * distinguish "the owner explicitly unchecked this scope on the card" from
 * "this scope's row was revoked by some other lifecycle event (e.g. a full
 * connector disconnect)". Both leave the same trace — a revoked row — and this
 * helper treats both as "leave it alone", which is the conservative,
 * never-re-widen-without-explicit-consent reading of that ambiguity.
 */
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, channelLinks } from '@/src/db';
import {
  CONNECTOR_DIDS,
  CONNECTOR_CHANNELS,
  scopeEntry,
  type ConnectorId,
} from '@imajin/auth/scope-vocabulary';
import { connectorScopeDescriptors, requiresConsentRow } from '@/src/lib/kernel/scope-projections';
import { publishConnectorScopeManifest } from '@/src/lib/kernel/scope-manifest-core';

const log = createLogger('kernel');

/** Result of one connector's auto-publish attempt within a consent event. */
export interface ConsentProjectionOutcome {
  connector: ConnectorId;
  assetId: string | null;
  added: string[];
  skippedNarrowed: string[];
  error?: string;
}

/** Group scope strings by owning connector. Unknown / platform (no owning connector) scopes are dropped — they are granted via attestations, not a connector manifest. */
function groupByConnector(scopes: readonly string[]): Map<ConnectorId, string[]> {
  const groups = new Map<ConnectorId, string[]>();
  for (const scope of scopes) {
    const entry = scopeEntry(scope);
    if (!entry || entry.connector === null) continue;
    const bucket = groups.get(entry.connector);
    if (bucket) bucket.push(scope);
    else groups.set(entry.connector, [scope]);
  }
  return groups;
}

/** Every scope currently ACTIVE on the connector-wide manifest (the card's grantee). */
async function activeConnectorWideScopes(ownerDid: string, channel: string, connectorDid: string): Promise<Set<string>> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(and(
      eq(channelLinks.channel, channel),
      eq(channelLinks.did, ownerDid),
      eq(channelLinks.appDid, connectorDid),
      eq(channelLinks.status, 'active'),
    ));
  const set = new Set<string>();
  for (const row of rows) {
    if (Array.isArray(row.scopes)) for (const s of row.scopes as string[]) set.add(s);
  }
  return set;
}

/** Candidate scopes that the connector-wide manifest has EVER revoked before (the owner's narrowing signal). */
async function everRevokedConnectorWide(
  ownerDid: string, channel: string, connectorDid: string, candidates: readonly string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(and(
      eq(channelLinks.channel, channel),
      eq(channelLinks.did, ownerDid),
      eq(channelLinks.appDid, connectorDid),
      eq(channelLinks.status, 'revoked'),
    ));
  const candidateSet = new Set(candidates);
  const narrowed = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.scopes)) continue;
    for (const s of row.scopes as string[]) if (candidateSet.has(s)) narrowed.add(s);
  }
  return narrowed;
}

/**
 * Auto-publish (or merge into) each granted scope's owning connector
 * scope-manifest, projecting `auth.channel_links` immediately.
 *
 * `appDid` identifies the consenting app (the OAuth client, or a peer app for
 * #1803's lane) — passed through to `publishConnectorScopeManifest` so the
 * per-client attribution machinery (#1695) records who this specific consent
 * event came from. Non-fatal per connector: a publish failure for one
 * connector's manifest is logged and does not prevent the others (or the
 * caller's consent commit) from succeeding.
 */
export async function projectConsentedScopes(opts: {
  ownerDid: string;
  appDid: string;
  scopes: readonly string[];
}): Promise<ConsentProjectionOutcome[]> {
  const { ownerDid, appDid, scopes } = opts;
  const groups = groupByConnector(scopes);
  const outcomes: ConsentProjectionOutcome[] = [];

  for (const [connector, granted] of groups) {
    const connectorDid = CONNECTOR_DIDS[connector];
    const channel = CONNECTOR_CHANNELS[connector];

    const [existingActive, narrowed] = await Promise.all([
      activeConnectorWideScopes(ownerDid, channel, connectorDid),
      everRevokedConnectorWide(ownerDid, channel, connectorDid, granted),
    ]);

    const added = granted.filter((s) => !existingActive.has(s) && !narrowed.has(s));
    const skippedNarrowed = granted.filter((s) => narrowed.has(s));
    const finalScopes = [...new Set([...existingActive, ...added])];

    try {
      const assetId = await publishConnectorScopeManifest({
        ownerDid,
        connectorDid,
        channel,
        filename: `${connector}-scope-manifest.md`,
        scopeDescriptors: connectorScopeDescriptors(connector),
        scopes: finalScopes,
        isOnConsent: (s) => requiresConsentRow(connector, s),
        appDid,
      });
      outcomes.push({ connector, assetId, added, skippedNarrowed });
      log.info(
        { ownerDid, appDid, connector, added, skippedNarrowed },
        'auto-published scope-manifest on OAuth consent (#1804)',
      );
    } catch (err) {
      outcomes.push({ connector, assetId: null, added, skippedNarrowed, error: String(err) });
      log.error(
        { err: String(err), ownerDid, appDid, connector },
        'auto-publish-on-consent: scope-manifest publish failed (non-fatal)',
      );
    }
  }

  return outcomes;
}
