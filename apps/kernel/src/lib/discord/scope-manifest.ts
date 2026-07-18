/**
 * Discord connector scope-manifest publisher (#1355).
 *
 * Replicates the GitHub scope-manifest pattern (#1352) for the Discord
 * connector (Pattern B — token-paste, no OAuth). Connects the existing
 * `channel-links-surface` projection machinery to a Discord-specific
 * scope-manifest asset so the Connectors page can grant `discord:post`
 * and `discord:read` through the UI.
 *
 * Scope release tiers (#1196 consent 2×2):
 *   discord:post — touches others (shared channel) → on-consent
 *   discord:read — reads others' messages        → on-consent
 *
 * Both scopes are on-consent, so every POST that includes them writes a
 * matching `consent_grants` row (via syncConsentGrants) before firing
 * `document.changed`, ensuring the broker release gate passes.
 */
import { and, eq, like, sql } from 'drizzle-orm';
import { db, assets, channelLinks, consentGrants, type Asset } from '@/src/db';
import { createAsset } from '@/src/lib/media/create-asset';
import { updateAssetContent } from '@/src/lib/media/update-asset';
import { generateId } from '@/src/lib/kernel/id';
import { DISCORD_CONNECTOR_DID, vaultField } from './connector';
import { vaultFieldExists } from '@/src/lib/vault';

// ── Scope registry ────────────────────────────────────────────────────────────

interface ScopeDescriptor {
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

/** Discord connector scopes with #1196 release classifications. */
export const DISCORD_SCOPE_DESCRIPTORS: Readonly<Record<string, ScopeDescriptor>> = {
  'discord:post': {
    verb: 'post',
    surface: 'channels',
    label: 'Post messages to Discord channels',
    release: {
      // Posting touches a shared channel visible to other server members.
      discloses_others: true,
      sensitive: false,
      // Derived tier = on-consent; no explicit override needed.
      viewer: DISCORD_CONNECTOR_DID,
    },
  },
  'discord:read': {
    verb: 'read',
    surface: 'channels',
    label: 'Read messages from Discord channels',
    release: {
      // Reading returns others' messages — discloses content about other users.
      discloses_others: true,
      sensitive: false,
      viewer: DISCORD_CONNECTOR_DID,
    },
  },
} as const;

export const VALID_DISCORD_SCOPES = Object.keys(DISCORD_SCOPE_DESCRIPTORS) as Array<
  keyof typeof DISCORD_SCOPE_DESCRIPTORS
>;

// ── Manifest content builder ──────────────────────────────────────────────────

const MANIFEST_CHANNEL = 'discord';

/** Effective release class derived from the #1196 2×2 + optional explicit override. */
function discordScopeReleaseClass(
  scopeName: string,
): 'silent' | 'on-consent' | 'owner-only' | 'never' {
  const desc = DISCORD_SCOPE_DESCRIPTORS[scopeName];
  if (!desc) return 'never';
  const r = desc.release;
  if (r.release) return r.release;
  if (!r.discloses_others && !r.sensitive) return 'silent';
  if (r.discloses_others && !r.sensitive) return 'on-consent';
  if (!r.discloses_others && r.sensitive) return 'owner-only';
  return 'never';
}

/**
 * Build the YAML-frontmatter markdown content for a Discord scope-manifest
 * asset. Only the requested `scopes` are emitted. Unknown scopes are dropped.
 */
export function buildManifestContent(selectedScopes: readonly string[]): string {
  const scopes = selectedScopes.filter((s) => s in DISCORD_SCOPE_DESCRIPTORS);

  const lines: string[] = [
    '---',
    'kind: scope-manifest',
    `connector: "${DISCORD_CONNECTOR_DID}"`,
    `channel: ${MANIFEST_CHANNEL}`,
  ];

  for (const scope of scopes) {
    const d = DISCORD_SCOPE_DESCRIPTORS[scope];
    lines.push(`"${scope}":`, `  verb: ${d.verb}`, `  surface: ${d.surface}`, `  label: "${d.label}"`);
  }

  lines.push('release:');
  for (const scope of scopes) {
    const r = DISCORD_SCOPE_DESCRIPTORS[scope].release;
    lines.push(`  "${scope}":`, `    discloses_others: ${r.discloses_others}`, `    sensitive: ${r.sensitive}`);
    if (r.release !== undefined) lines.push(`    release: ${r.release}`);
    if (r.viewer !== undefined) lines.push(`    viewer: "${r.viewer}"`);
  }

  lines.push(
    '---',
    '# Discord connector — scope manifest',
    '',
    'Edit this document to grant or revoke Discord connector scopes.',
  );

  return lines.join('\n') + '\n';
}

// ── Asset lookup ──────────────────────────────────────────────────────────────

/** Find the active Discord scope-manifest asset for `ownerDid`, or `null`. */
export async function findDiscordManifestAsset(ownerDid: string): Promise<Asset | null> {
  const [row] = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.ownerDid, ownerDid),
        eq(assets.status, 'active'),
        sql`${assets.metadata}->>'kind' = ${'scope-manifest'}`,
        sql`${assets.metadata}->>'connector' = ${DISCORD_CONNECTOR_DID}`,
      ),
    )
    .limit(1);

  return row ?? null;
}

// ── Consent grants sync ───────────────────────────────────────────────────────

const PROJECTION_PURPOSE = 'document.projection' as const;
const CONSENT_REF_SEP = ':' as const;

function manifestConsentRef(manifestAssetId: string, scopeName: string): string {
  return `${manifestAssetId}${CONSENT_REF_SEP}${scopeName}`;
}

/**
 * Sync `kernel.consent_grants` rows for a Discord scope-manifest publish.
 * Mirrors the GitHub implementation (#1357): grant-by-edit IS the consent act.
 *
 * Must be called BEFORE `updateAssetContent` fires `document.changed`.
 */
export async function syncConsentGrants(
  ownerDid: string,
  manifestAssetId: string,
  requestedScopes: readonly string[],
): Promise<void> {
  const requestedSet = new Set(requestedScopes);

  // Grant: upsert active row for each on-consent scope.
  for (const scopeName of requestedScopes) {
    if (discordScopeReleaseClass(scopeName) !== 'on-consent') continue;

    const ref = manifestConsentRef(manifestAssetId, scopeName);
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
        grantedTo: DISCORD_CONNECTOR_DID,
        purpose: PROJECTION_PURPOSE,
        allowedFields: [scopeName],
        mode: 'attestation',
        status: 'active',
        consentRef: ref,
      });
    }
  }

  // Revoke: flip rows for scopes removed from the manifest.
  const existingRows = await db
    .select({ id: consentGrants.id, consentRef: consentGrants.consentRef })
    .from(consentGrants)
    .where(
      and(
        eq(consentGrants.subject, ownerDid),
        eq(consentGrants.grantedTo, DISCORD_CONNECTOR_DID),
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

// ── Publish / update ──────────────────────────────────────────────────────────

/**
 * Create or update the Discord scope-manifest asset and trigger the projection
 * reactor that materialises `auth.channel_links` rows.
 *
 * @param ownerDid  Owner DID requesting the grant.
 * @param scopes    Desired set of connector scopes (empty = revoke all).
 * @returns         The stable asset id of the manifest document.
 */
export async function publishDiscordScopeManifest(
  ownerDid: string,
  scopes: readonly string[],
): Promise<string> {
  const content = buildManifestContent(scopes);
  let assetId: string;

  const existing = await findDiscordManifestAsset(ownerDid);
  if (existing) {
    assetId = existing.id;
  } else {
    const { asset } = await createAsset({
      ownerDid,
      buffer: Buffer.from(content, 'utf-8'),
      filename: 'discord-scope-manifest.md',
      mimeType: 'text/markdown',
      access: 'private',
      dedup: false,
      classify: false,
    });

    // Stamp metadata BEFORE document.changed fires so the surface gates correctly.
    await db
      .update(assets)
      .set({
        metadata: { kind: 'scope-manifest', connector: DISCORD_CONNECTOR_DID, channel: MANIFEST_CHANNEL },
        updatedAt: new Date(),
      })
      .where(eq(assets.id, asset.id));

    assetId = asset.id;
  }

  // Write consent_grants rows BEFORE updateAssetContent fires document.changed.
  await syncConsentGrants(ownerDid, assetId, scopes);

  const result = await updateAssetContent({ assetId, requesterDid: ownerDid, content });
  if (!result.ok) {
    throw new Error(`discord scope-manifest update failed (${result.code}): ${result.message}`);
  }

  return assetId;
}

// ── Active grant reader ───────────────────────────────────────────────────────

/** Read currently active Discord connector scopes from `auth.channel_links`. */
export async function readActiveDiscordScopes(ownerDid: string): Promise<string[]> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, MANIFEST_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, DISCORD_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.flatMap((row) =>
    Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
  );
}

// ── Credential status ─────────────────────────────────────────────────────────

/**
 * Check whether a Discord Bot Token is sealed for `ownerDid`.
 * Returns a boolean only — the token value is never exposed.
 */
export async function discordTokenSealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}
