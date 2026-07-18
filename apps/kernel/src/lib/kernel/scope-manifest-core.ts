/**
 * Generic connector scope-manifest core (#1355 / Sonar dedup fix).
 *
 * All connectors (GitHub, Discord, QuickBooks, …) share identical logic for:
 *   - Building YAML frontmatter from scope descriptors
 *   - Finding/querying the manifest asset in the DB
 *   - Reading active scopes from channel_links
 *   - Syncing consent_grants rows (grant + revoke)
 *   - The publish/update orchestration
 *
 * Each connector's `scope-manifest.ts` is a thin wrapper that passes its
 * own DID, channel label, scope descriptors, and filenames. This module owns
 * the implementation; the wrappers own the connector identity.
 */
import { and, eq, like, sql } from 'drizzle-orm';
import { db, assets, channelLinks, consentGrants, type Asset } from '@/src/db';
import { createAsset } from '@/src/lib/media/create-asset';
import { updateAssetContent } from '@/src/lib/media/update-asset';
import { generateId } from '@/src/lib/kernel/id';

// ── Shared types ──────────────────────────────────────────────────────────────

/** Re-exported so connector wrappers can import Asset from this module. */
export type { Asset } from '@/src/db';

export interface ConnectorScopeDescriptor {
  verb: string;
  surface: string;
  label: string;
  release: {
    discloses_others: boolean;
    sensitive: boolean;
    release?: 'on-consent' | 'owner-only' | 'never';
    viewer?: string;
  };
}

// ── YAML builder ──────────────────────────────────────────────────────────────

/**
 * Build the YAML-frontmatter markdown content for any connector scope-manifest.
 * Quoted keys (`"scope:name":`) are required because colons are YAML specials.
 */
export function buildConnectorManifestContent(
  connectorDid: string,
  channel: string,
  scopeDescriptors: Readonly<Record<string, ConnectorScopeDescriptor>>,
  selectedScopes: readonly string[],
): string {
  const scopes = selectedScopes.filter((s) => s in scopeDescriptors);

  const lines: string[] = [
    '---',
    'kind: scope-manifest',
    `connector: "${connectorDid}"`,
    `channel: ${channel}`,
  ];

  for (const scope of scopes) {
    const d = scopeDescriptors[scope];
    lines.push(`"${scope}":`, `  verb: ${d.verb}`, `  surface: ${d.surface}`, `  label: "${d.label}"`);
  }

  lines.push('release:');
  for (const scope of scopes) {
    const r = scopeDescriptors[scope].release;
    lines.push(`  "${scope}":`, `    discloses_others: ${r.discloses_others}`, `    sensitive: ${r.sensitive}`);
    if (r.release !== undefined) lines.push(`    release: ${r.release}`);
    if (r.viewer !== undefined) lines.push(`    viewer: "${r.viewer}"`);
  }

  lines.push('---', `# ${connectorDid.split(':').at(-1) ?? channel} connector \u2014 scope manifest`, '');

  return lines.join('\n') + '\n';
}

// ── DB helpers ────────────────────────────────────────────────────────────────

/**
 * Find the active scope-manifest asset for the given owner + connector DID.
 * Uses JSONB operators on `metadata` to distinguish connectors.
 */
export async function findConnectorManifestAsset(
  ownerDid: string,
  connectorDid: string,
): Promise<Asset | null> {
  const [row] = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.ownerDid, ownerDid),
        eq(assets.status, 'active'),
        sql`${assets.metadata}->>'kind' = ${'scope-manifest'}`,
        sql`${assets.metadata}->>'connector' = ${connectorDid}`,
      ),
    )
    .limit(1);

  return row ?? null;
}

/** Read active scopes from `auth.channel_links` for the given connector. */
export async function readActiveConnectorScopes(
  ownerDid: string,
  channel: string,
  connectorDid: string,
): Promise<string[]> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, channel),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, connectorDid),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.flatMap((row) =>
    Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
  );
}

// ── Consent grants ────────────────────────────────────────────────────────────

const PROJECTION_PURPOSE = 'document.projection' as const;
const CONSENT_REF_SEP = ':' as const;

/** Build a stable consentRef for one scope of a manifest asset. */
export function connectorConsentRef(manifestAssetId: string, scopeName: string): string {
  return `${manifestAssetId}${CONSENT_REF_SEP}${scopeName}`;
}

/**
 * Sync `kernel.consent_grants` for a connector scope-manifest publish.
 *
 * Grant path: for each on-consent scope (as determined by `isOnConsent`),
 * upsert an active row. Re-activates revoked rows idempotently.
 *
 * Revoke path: flip active rows whose scope is no longer in `requestedScopes`
 * to `revoked`. Must be called BEFORE `updateAssetContent` fires
 * `document.changed` so the broker consent reactor finds the rows.
 */
export async function syncConnectorConsentGrants(
  ownerDid: string,
  connectorDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
  isOnConsent: (scopeName: string) => boolean,
): Promise<void> {
  const requestedSet = new Set(requestedScopes);

  for (const scopeName of requestedScopes) {
    if (!isOnConsent(scopeName)) continue;

    const ref = connectorConsentRef(manifestAssetId, scopeName);
    const [existing] = await db
      .select({ id: consentGrants.id })
      .from(consentGrants)
      .where(eq(consentGrants.consentRef, ref))
      .limit(1);

    if (existing) {
      await db
        .update(consentGrants)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(consentGrants.id, existing.id));
    } else {
      await db.insert(consentGrants).values({
        id: generateId('cgrant'),
        subject: ownerDid,
        grantedTo: connectorDid,
        purpose: PROJECTION_PURPOSE,
        allowedFields: [scopeName],
        mode: 'attestation',
        status: 'active',
        consentRef: ref,
      });
    }
  }

  const existingRows = await db
    .select({ id: consentGrants.id, consentRef: consentGrants.consentRef })
    .from(consentGrants)
    .where(
      and(
        eq(consentGrants.subject, ownerDid),
        eq(consentGrants.grantedTo, connectorDid),
        eq(consentGrants.purpose, PROJECTION_PURPOSE),
        eq(consentGrants.status, 'active'),
        like(consentGrants.consentRef, `${manifestAssetId}${CONSENT_REF_SEP}%`),
      ),
    );

  for (const row of existingRows) {
    const scopeName = row.consentRef.slice(manifestAssetId.length + CONSENT_REF_SEP.length);
    if (!requestedSet.has(scopeName)) {
      await db
        .update(consentGrants)
        .set({ status: 'revoked', updatedAt: new Date() })
        .where(eq(consentGrants.id, row.id));
    }
  }
}

// ── Publish orchestration ─────────────────────────────────────────────────────

/**
 * Create or update a connector scope-manifest asset and fire `document.changed`
 * to project scopes into `auth.channel_links`.
 *
 * Sequence (order matters):
 *   1. Find or create the manifest asset (stamps metadata.kind on create).
 *   2. `syncConnectorConsentGrants` — writes consent_grants rows.
 *   3. `updateAssetContent` — fires document.changed → projection reactor.
 */
export async function publishConnectorScopeManifest(opts: {
  ownerDid: string;
  connectorDid: string;
  channel: string;
  filename: string;
  scopeDescriptors: Readonly<Record<string, ConnectorScopeDescriptor>>;
  scopes: readonly string[];
  isOnConsent: (scopeName: string) => boolean;
}): Promise<string> {
  const { ownerDid, connectorDid, channel, filename, scopeDescriptors, scopes, isOnConsent } = opts;

  const content = buildConnectorManifestContent(connectorDid, channel, scopeDescriptors, scopes);
  let assetId: string;

  const existing = await findConnectorManifestAsset(ownerDid, connectorDid);
  if (existing) {
    assetId = existing.id;
  } else {
    const { asset } = await createAsset({
      ownerDid,
      buffer: Buffer.from(content, 'utf-8'),
      filename,
      mimeType: 'text/markdown',
      access: 'private',
      dedup: false,
      classify: false,
    });

    await db
      .update(assets)
      .set({
        metadata: { kind: 'scope-manifest', connector: connectorDid, channel },
        updatedAt: new Date(),
      })
      .where(eq(assets.id, asset.id));

    assetId = asset.id;
  }

  await syncConnectorConsentGrants(ownerDid, connectorDid, assetId, scopes, isOnConsent);

  const result = await updateAssetContent({ assetId, requesterDid: ownerDid, content });
  if (!result.ok) {
    throw new Error(`${connectorDid} scope-manifest update failed (${result.code}): ${result.message}`);
  }

  return assetId;
}
