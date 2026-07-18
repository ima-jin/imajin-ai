/**
 * GitHub connector scope-manifest publisher (#1352).
 *
 * The channel-links projection surface (#1209) already exists and wires
 * `document.changed` → `auth.channel_links`, but there was no path to CREATE
 * or UPDATE the scope-manifest asset that drives the surface. This module
 * provides that path.
 *
 * Flow:
 *   publishGitHubScopeManifest(ownerDid, scopes)
 *     → find or create a media asset with metadata.kind = 'scope-manifest'
 *     → write the YAML frontmatter declaring the requested scopes
 *     → updateAssetContent fires document.changed
 *     → projection reactor runs the release-gate per scope
 *     → channel-links surface upserts auth.channel_links rows
 *
 * Scope release tiers (from the #1196 consent 2×2 / fixture):
 *   github:read    → silent    (materialises on publish)
 *   github:write   → on-consent (materialises only when a consent_grants row
 *                               exists for did:imajin:github-connector)
 *   github:org     → on-consent (requires consent; touches others)
 *   github:actions → never     (structural drop; never materialises)
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, assets, channelLinks, type Asset } from '@/src/db';
import { createAsset } from '@/src/lib/media/create-asset';
import { updateAssetContent } from '@/src/lib/media/update-asset';
import { GITHUB_CONNECTOR_DID } from './connector';

// ── Scope registry ────────────────────────────────────────────────────────────

interface ScopeDescriptor {
  verb: string;
  surface: string;
  label: string;
  release: {
    discloses_others: boolean;
    sensitive: boolean;
    /** Explicit tightening override (omit → derived tier used). */
    release?: 'on-consent' | 'owner-only' | 'never';
    /** Connector DID that acts as the viewer for on-consent scopes. */
    viewer?: string;
  };
}

/** All four GitHub connector scopes, mirroring the #1203 fixture. */
export const GITHUB_SCOPE_DESCRIPTORS: Readonly<Record<string, ScopeDescriptor>> = {
  'github:read': {
    verb: 'read',
    surface: 'repos',
    label: 'Read your own repos, issues and PRs',
    release: { discloses_others: false, sensitive: false },
    // Derived tier: silent → materialises on publish.
  },
  'github:write': {
    verb: 'write',
    surface: 'issues',
    label: 'Open and comment on issues & PRs on your repos',
    release: {
      discloses_others: false,
      sensitive: false,
      // Tightened to on-consent: the connector needs explicit consent to write.
      release: 'on-consent',
      viewer: GITHUB_CONNECTOR_DID,
    },
  },
  'github:org': {
    verb: 'write',
    surface: 'org',
    label: 'Act on repos owned by an org or other people',
    release: { discloses_others: true, sensitive: false, viewer: GITHUB_CONNECTOR_DID },
    // Derived tier: on-consent (touches others).
  },
  'github:actions': {
    verb: 'execute',
    surface: 'actions',
    label: 'Trigger Actions / deploy / spend CI minutes',
    release: { discloses_others: true, sensitive: true },
    // Derived tier: never (touches others + sensitive).
  },
};

export const VALID_GITHUB_SCOPES = Object.keys(GITHUB_SCOPE_DESCRIPTORS) as Array<
  keyof typeof GITHUB_SCOPE_DESCRIPTORS
>;

// ── Manifest content builder ──────────────────────────────────────────────────

const MANIFEST_CHANNEL = 'github';

/**
 * Build the YAML-frontmatter markdown content for a GitHub scope-manifest
 * asset. Only the requested `scopes` are emitted (must be a subset of
 * {@link VALID_GITHUB_SCOPES}). Unknown scopes are silently dropped.
 *
 * The resulting file is parsed by `parseFrontmatter` (gray-matter), so the
 * YAML must be syntactically valid. Quoted YAML keys (`"github:read":`) are
 * required because the colon is a YAML special character.
 */
export function buildManifestContent(selectedScopes: readonly string[]): string {
  const scopes = selectedScopes.filter((s) => s in GITHUB_SCOPE_DESCRIPTORS);

  const lines: string[] = [
    '---',
    'kind: scope-manifest',
    `connector: "${GITHUB_CONNECTOR_DID}"`,
    `channel: ${MANIFEST_CHANNEL}`,
  ];

  // Scope data rows
  for (const scope of scopes) {
    const d = GITHUB_SCOPE_DESCRIPTORS[scope];
    lines.push(`"${scope}":`, `  verb: ${d.verb}`, `  surface: ${d.surface}`, `  label: "${d.label}"`);
  }

  // Release policy block
  lines.push('release:');
  for (const scope of scopes) {
    const r = GITHUB_SCOPE_DESCRIPTORS[scope].release;
    lines.push(`  "${scope}":`, `    discloses_others: ${r.discloses_others}`, `    sensitive: ${r.sensitive}`);
    if (r.release !== undefined) lines.push(`    release: ${r.release}`);
    if (r.viewer !== undefined) lines.push(`    viewer: "${r.viewer}"`);
  }

  lines.push(
    '---',
    '# GitHub connector — scope manifest',
    '',
    'Edit this document to grant or revoke GitHub connector scopes. ' +
      'Saving it projects into the live permission DB through the release-gated reactor (#1207).',
  );

  return lines.join('\n') + '\n';
}

// ── Asset lookup ──────────────────────────────────────────────────────────────

/**
 * Find the active GitHub scope-manifest asset for `ownerDid`, or `null` when
 * none exists yet. The lookup uses JSONB operators on `metadata` to target
 * exactly the GitHub connector manifest (connector DID is stored alongside
 * `kind` to avoid false matches from other connectors).
 */
export async function findGitHubManifestAsset(ownerDid: string): Promise<Asset | null> {
  const [row] = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.ownerDid, ownerDid),
        eq(assets.status, 'active'),
        sql`${assets.metadata}->>'kind' = ${'scope-manifest'}`,
        sql`${assets.metadata}->>'connector' = ${GITHUB_CONNECTOR_DID}`,
      ),
    )
    .limit(1);

  return row ?? null;
}

// ── Publish / update ──────────────────────────────────────────────────────────

/**
 * Create or update the GitHub scope-manifest asset for `ownerDid` and trigger
 * the projection reactor that materialises `auth.channel_links` rows.
 *
 * - On first call: creates a private `text/markdown` asset, stamps its
 *   `metadata` with `{ kind, connector, channel }`, then calls
 *   `updateAssetContent` to fire `document.changed`.
 * - On subsequent calls: finds the existing asset and calls
 *   `updateAssetContent` directly.
 *
 * Throws on unrecoverable storage / DB errors; the caller should map these
 * to 500 responses.
 *
 * @param ownerDid  Owner DID requesting the grant.
 * @param scopes    Desired set of connector scopes (empty = revoke all).
 * @returns         The stable asset id of the manifest document.
 */
export async function publishGitHubScopeManifest(
  ownerDid: string,
  scopes: readonly string[],
): Promise<string> {
  const content = buildManifestContent(scopes);

  let assetId: string;

  const existing = await findGitHubManifestAsset(ownerDid);
  if (existing) {
    assetId = existing.id;
  } else {
    // Create a new text/markdown asset. dedup=false ensures a fresh owner-pinned
    // asset even if another DID published an identical manifest; classify=false
    // skips AI classification (it would be meaningless for a config manifest).
    const { asset } = await createAsset({
      ownerDid,
      buffer: Buffer.from(content, 'utf-8'),
      filename: 'github-scope-manifest.md',
      mimeType: 'text/markdown',
      access: 'private',
      dedup: false,
      classify: false,
    });

    // Stamp the metadata BEFORE updateAssetContent fires document.changed so
    // channel-links-surface can gate on metadata.kind === 'scope-manifest'.
    await db
      .update(assets)
      .set({
        metadata: {
          kind: 'scope-manifest',
          connector: GITHUB_CONNECTOR_DID,
          channel: MANIFEST_CHANNEL,
        },
        updatedAt: new Date(),
      })
      .where(eq(assets.id, asset.id));

    assetId = asset.id;
  }

  // Write the content (creates a new file version) and fire document.changed →
  // projection reactor → channel-links surface → auth.channel_links upsert.
  const result = await updateAssetContent({ assetId, requesterDid: ownerDid, content });
  if (!result.ok) {
    throw new Error(`scope-manifest update failed (${result.code}): ${result.message}`);
  }

  return assetId;
}

// ── Active grant reader ───────────────────────────────────────────────────────

/**
 * Read the currently active GitHub connector scopes from `auth.channel_links`
 * for `ownerDid`. Returns the set of scope strings with `status = 'active'`.
 */
export async function readActiveGitHubScopes(ownerDid: string): Promise<string[]> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, MANIFEST_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, GITHUB_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.flatMap((row) =>
    Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
  );
}
