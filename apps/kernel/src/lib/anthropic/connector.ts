/**
 * Anthropic connector backend library (#1621).
 *
 * Connects a human DID's Anthropic API Key (sealed in imajin-vault) to the
 * inference surface, gated by an active `auth.channel_links` row for the
 * anthropic connector app DID + the required scope.
 *
 * Token-paste mirror of the Gemini connector (#1432) — same security shape:
 * - Fail-closed on every gate: no active grant OR no sealed key ⇒ throw.
 * - Key is NEVER logged, NEVER returned to callers, NEVER echoed.
 * - Per-DID vault field isolation: `anthropic-api-key:${ownerDid}`.
 * - Cross-DID reads are structurally impossible: field name encodes owner DID.
 *
 * Optional metadata (baseUrl, modelId) stored in separate vault fields so a
 * per-DID gateway endpoint and model override can be sealed alongside the key.
 * The sealed `modelId` is how the owner chooses *which* Claude model runs —
 * sealing a key IS choosing your brain (#1621).
 */
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { sealAndStoreV2, loadAndUnseal, vaultFieldExists, vaultFieldStatus } from '@/src/lib/vault';
import { VaultDelegationError } from '@/src/lib/vault/errors';

/** Connector app DID — matches the scope-manifest for the anthropic connector. */
export const ANTHROPIC_CONNECTOR_DID = 'did:imajin:anthropic-connector';

/** Channel name — matches the scope-manifest `channel:` field. */
const ANTHROPIC_CHANNEL = 'anthropic';

// ── Vault field helpers ───────────────────────────────────────────────────────

/**
 * Per-DID vault field name for an Anthropic API key.
 *
 * Encoding ownerDid in the field name ensures per-DID isolation at the vault
 * layer: different DIDs cannot share or cross-read each other's keys.
 */
export function vaultField(ownerDid: string): string {
  return `anthropic-api-key:${ownerDid}`;
}

/** Optional per-DID vault field for an Anthropic base URL override (gateway/proxy). */
function baseUrlVaultField(ownerDid: string): string {
  return `anthropic-base-url:${ownerDid}`;
}

/** Optional per-DID vault field for the Anthropic model ID override. */
function modelIdVaultField(ownerDid: string): string {
  return `anthropic-model-id:${ownerDid}`;
}

/**
 * Seal and store an Anthropic API key (and optionally baseUrl / modelId) for
 * the given DID.
 *
 * The plaintext key is never logged or returned; the only observable output is
 * a successful vault write. Callers must validate the key is non-empty.
 */
export async function sealApiKey(
  ownerDid: string,
  apiKey: string,
  baseUrl?: string,
  modelId?: string,
): Promise<void> {
  await sealAndStoreV2(vaultField(ownerDid), apiKey);
  if (baseUrl) {
    await sealAndStoreV2(baseUrlVaultField(ownerDid), baseUrl);
  }
  if (modelId) {
    await sealAndStoreV2(modelIdVaultField(ownerDid), modelId);
  }
}

// ── Grant resolution ──────────────────────────────────────────────────────────

/**
 * Check whether an active `channel_links` row exists for this DID + scope.
 *
 * Returns `true` only when at least one ACTIVE row for the anthropic channel
 * and the anthropic connector app DID contains the requested scope.
 * Fail-closed: any DB error propagates as a thrown exception.
 */
export async function resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, ANTHROPIC_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, ANTHROPIC_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.some((row) => {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return scopes.includes(requiredScope);
  });
}

// ── Credential resolution ─────────────────────────────────────────────────────

export interface AnthropicCredentials {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
}

/**
 * Resolve sealed Anthropic credentials for a DID.
 *
 * Checks for an active `anthropic:infer` grant AND a sealed API key. Returns
 * the credentials when both gates pass, or `undefined` when no connection is
 * configured for the DID — so the brain resolver (#1621) can try the next
 * provider instead of failing the whole pipeline.
 *
 * Fail-closed: vault or DB errors propagate. Returns `undefined` only when no
 * active grant exists or no key has been sealed for this DID.
 *
 * The resolved key is returned only to the calling scope; it must not be
 * logged, stored in plaintext, or returned to external callers.
 */
export async function loadAnthropicCredentials(ownerDid: string): Promise<AnthropicCredentials | undefined> {
  const hasGrant = await resolveActiveGrant(ownerDid, 'anthropic:infer');
  if (!hasGrant) {
    return undefined;
  }

  const apiKey = await loadAndUnseal(vaultField(ownerDid));
  if (apiKey === undefined) {
    return undefined;
  }

  const [baseUrl, modelId] = await Promise.all([
    loadAndUnseal(baseUrlVaultField(ownerDid)),
    loadAndUnseal(modelIdVaultField(ownerDid)),
  ]);

  return {
    apiKey,
    ...(baseUrl !== undefined && { baseUrl }),
    ...(modelId !== undefined && { modelId }),
  };
}

// ── Gate helper (fail-closed, used only for strict enforcement) ───────────────

/**
 * Resolve the connector grant and unseal the API key. Fail-closed on both gates.
 *
 * This is the mandatory entry point for callers that require the grant to be
 * present (as opposed to `loadAnthropicCredentials`, which returns `undefined`
 * gracefully when no connection exists).
 *
 * The resolved key is returned only to the calling scope; it must not be
 * logged, stored in plaintext, or returned to external callers.
 *
 * Throws:
 *   - `anthropic_no_grant` — no active channel_links row for ownerDid + scope.
 *   - `anthropic_no_key`   — no sealed API key in the vault for ownerDid.
 *   - Any vault integrity error from loadAndUnseal.
 */
export async function requireGrantAndKey(ownerDid: string, scope: string): Promise<string> {
  const hasGrant = await resolveActiveGrant(ownerDid, scope);
  if (!hasGrant) {
    throw new Error(
      `anthropic_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `use the Anthropic connector to seal your API key and enable this scope`,
    );
  }

  let key: string | undefined;
  try {
    key = await loadAndUnseal(vaultField(ownerDid));
  } catch (err) {
    if (err instanceof VaultDelegationError) {
      throw new Error(
        `anthropic_credential_pending: Anthropic API key for DID ${ownerDid} is sealed but awaiting owner grant approval`,
      );
    }
    throw err;
  }
  if (key === undefined) {
    throw new Error(
      `anthropic_no_key: no Anthropic API key sealed for DID ${ownerDid} — ` +
      `use the Anthropic connector token route to store a key first`,
    );
  }

  return key;
}

// ── Status helpers ────────────────────────────────────────────────────────────

/** Check whether an Anthropic API key is sealed for ownerDid (no crypto, no value returned). */
export function anthropicKeySealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}

/**
 * Check whether an Anthropic API key is sealed but awaiting owner grant approval
 * (Tier 1, no active delegation grant yet). Distinct from `anthropicKeySealed` so
 * the scope-manifest surface can render "waiting for owner approval" instead of
 * "not connected" — `vaultFieldExists` reports `false` for this state
 * (see field-status.ts).
 */
export async function anthropicKeyPending(ownerDid: string): Promise<boolean> {
  return (await vaultFieldStatus(vaultField(ownerDid))) === 'pending-grant';
}
