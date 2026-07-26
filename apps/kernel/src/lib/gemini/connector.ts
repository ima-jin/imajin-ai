/**
 * Gemini connector backend library (#1432).
 *
 * Connects a human DID's Gemini API Key (sealed in imajin-vault) to the
 * Gemini inference surface via the OpenAI-compatible endpoint, gated by an
 * active `auth.channel_links` row for the gemini connector app DID + the
 * required scope.
 *
 * Mirrors the Discord connector's security shape exactly:
 * - Fail-closed on every gate: no active grant OR no sealed key ⇒ throw.
 * - Key is NEVER logged, NEVER returned to callers, NEVER echoed.
 * - Per-DID vault field isolation: `gemini-api-key:${ownerDid}`.
 * - Cross-DID reads are structurally impossible: field name encodes owner DID.
 *
 * Optional metadata (baseUrl, modelId) stored in separate vault fields so the
 * per-DID Gemini endpoint and model override can be sealed alongside the key.
 */
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { sealAndStore, loadAndUnseal, vaultFieldExists } from '@/src/lib/vault';

/** Connector app DID — matches the scope-manifest for the gemini connector. */
export const GEMINI_CONNECTOR_DID = 'did:imajin:gemini-connector';

/** Channel name — matches the scope-manifest fixture `channel:` field. */
const GEMINI_CHANNEL = 'gemini';

// ── Vault field helpers ───────────────────────────────────────────────────────

/**
 * Per-DID vault field name for a Gemini API key.
 *
 * Encoding ownerDid in the field name ensures per-DID isolation at the vault
 * layer: different DIDs cannot share or cross-read each other's keys.
 */
export function vaultField(ownerDid: string): string {
  return `gemini-api-key:${ownerDid}`;
}

/** Optional per-DID vault field for the Gemini base URL override. */
function baseUrlVaultField(ownerDid: string): string {
  return `gemini-base-url:${ownerDid}`;
}

/** Optional per-DID vault field for the Gemini model ID override. */
function modelIdVaultField(ownerDid: string): string {
  return `gemini-model-id:${ownerDid}`;
}

/**
 * Seal and store a Gemini API key (and optionally baseUrl / modelId) for the
 * given DID.
 *
 * The plaintext key is never logged or returned; the only observable output
 * is a successful vault write. Callers must validate the key is non-empty.
 */
export async function sealApiKey(
  ownerDid: string,
  apiKey: string,
  baseUrl?: string,
  modelId?: string,
): Promise<void> {
  await sealAndStore(vaultField(ownerDid), apiKey);
  if (baseUrl) {
    await sealAndStore(baseUrlVaultField(ownerDid), baseUrl);
  }
  if (modelId) {
    await sealAndStore(modelIdVaultField(ownerDid), modelId);
  }
}

// ── Grant resolution ──────────────────────────────────────────────────────────

/**
 * Check whether an active `channel_links` row exists for this DID + scope.
 *
 * Returns `true` only when at least one ACTIVE row for the gemini channel
 * and the gemini connector app DID contains the requested scope.
 * Fail-closed: any DB error propagates as a thrown exception.
 */
export async function resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, GEMINI_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, GEMINI_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.some((row) => {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return scopes.includes(requiredScope);
  });
}

// ── Credential resolution ─────────────────────────────────────────────────────

export interface GeminiCredentials {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
}

/**
 * Resolve sealed Gemini credentials for a DID.
 *
 * Checks for an active `gemini:infer` grant AND a sealed API key.
 * Returns the credentials (apiKey, optional baseUrl, optional modelId) when
 * both gates pass, or `undefined` when no connection is configured for the DID.
 *
 * Fail-closed: vault or DB errors propagate. Returns `undefined` only when
 * no active grant exists or no key has been sealed for this DID.
 *
 * The resolved key is returned only to the calling scope; it must not be
 * logged, stored in plaintext, or returned to external callers.
 */
export async function loadGeminiCredentials(ownerDid: string): Promise<GeminiCredentials | undefined> {
  const hasGrant = await resolveActiveGrant(ownerDid, 'gemini:infer');
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
 * present (as opposed to `loadGeminiCredentials`, which returns `undefined`
 * gracefully when no connection exists).
 *
 * The resolved key is returned only to the calling scope; it must not be
 * logged, stored in plaintext, or returned to external callers.
 *
 * Throws:
 *   - `gemini_no_grant` — no active channel_links row for ownerDid + scope.
 *   - `gemini_no_key`   — no sealed API key in the vault for ownerDid.
 *   - Any vault integrity error from loadAndUnseal.
 */
export async function requireGrantAndKey(ownerDid: string, scope: string): Promise<string> {
  const hasGrant = await resolveActiveGrant(ownerDid, scope);
  if (!hasGrant) {
    throw new Error(
      `gemini_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `use the Gemini connector to seal your API key and enable this scope`,
    );
  }

  const key = await loadAndUnseal(vaultField(ownerDid));
  if (key === undefined) {
    throw new Error(
      `gemini_no_key: no Gemini API key sealed for DID ${ownerDid} — ` +
      `use the Gemini connector token route to store a key first`,
    );
  }

  return key;
}

// ── Status helper ─────────────────────────────────────────────────────────────

/** Check whether a Gemini API key is sealed for ownerDid (no crypto, no value returned). */
export function geminiKeySealed(ownerDid: string): Promise<boolean> {
  return vaultFieldExists(vaultField(ownerDid));
}
