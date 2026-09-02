/**
 * Moonshot AI (Kimi) connector backend library (#1930).
 *
 * Connects a human DID's Moonshot API key (sealed in imajin-vault) to the
 * inference surface, gated by an active `auth.channel_links` row for the
 * moonshot connector app DID + `moonshot:infer`.
 *
 * Fifth instance of the shape Gemini (#1432), Anthropic (#1621), xAI (#1924),
 * and OpenAI (#1927) already share: all custody mechanics — per-DID vault
 * fields, the fail-closed grant gate, the pending-grant distinction, the
 * model-picker read that skips the scope check (#1773) — live in
 * `createConnectorTokenPaste`. Only Moonshot's identity is declared here,
 * which is the whole point of the factory: adding a provider must not be an
 * opportunity to re-litigate custody.
 *
 * The sealed key never leaves the kernel: it is resolved server-side for the
 * duration of one call and there is no route, and no exported function here,
 * that returns it to a caller (#1922 anti-goal, load-bearing).
 */
import { CONNECTOR_DIDS, CONNECTOR_CHANNELS } from '@imajin/auth/scope-vocabulary';
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';

/** Connector app DID — matches the scope-manifest for the moonshot connector. */
export const MOONSHOT_CONNECTOR_DID = CONNECTOR_DIDS.moonshot;

/** Channel label in `auth.channel_links`. */
export const MOONSHOT_CHANNEL = CONNECTOR_CHANNELS.moonshot;

/** Scope the owner grants to let their key be used for inference. */
export const MOONSHOT_INFER_SCOPE = 'moonshot:infer';

/**
 * Moonshot's public API base, which is OpenAI-compatible.
 *
 * Exported because both the brain connector entry (`defaultBaseUrl`) and the
 * model-picker route need it, and two copies of a provider endpoint is how
 * one of them ends up pointing at a retired host.
 */
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1';

const moonshot = createConnectorTokenPaste({
  id: 'moonshot',
  displayName: 'Moonshot AI',
  connectorDid: MOONSHOT_CONNECTOR_DID,
  channel: MOONSHOT_CHANNEL,
});

/** Per-DID vault field for the Moonshot API key: `moonshot-api-key:{ownerDid}`. */
export const vaultField = moonshot.vaultField;

/** Seal an API key, plus an optional base URL and model id, for this DID. */
export const sealApiKey = moonshot.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = moonshot.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `moonshot_*`. */
export const requireGrantAndKey = moonshot.requireGrantAndKey;

/** Whether a Moonshot API key is sealed AND readable for this DID (#1724). */
export const moonshotKeySealed = moonshot.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const moonshotKeyPending = moonshot.keyPending;

/**
 * Revoke the sealed Moonshot API key's delegation grant for this DID, cutting
 * off access immediately without deleting the sealed key (#1720).
 */
export const revokeApiKey = moonshot.revokeApiKey;

/**
 * Update just the sealed model id for this DID, without touching the API key
 * (#1769) — how `PUT /moonshot/api/models` commits the owner's model choice.
 */
export const setModelId = moonshot.setModelId;

export type MoonshotCredentials = TokenPasteCredentials;

/**
 * Resolve sealed Moonshot credentials for a DID, or `undefined` when this DID
 * has no Moonshot connection.
 *
 * Returns `undefined` rather than throwing so the brain resolver (#1621) can
 * try the next provider instead of failing the whole pipeline. The resolved
 * key is for the immediate call only: never log it or return it to a caller.
 */
export function loadMoonshotCredentials(ownerDid: string): Promise<MoonshotCredentials | undefined> {
  return moonshot.loadCredentials(ownerDid, MOONSHOT_INFER_SCOPE);
}

/**
 * Resolve the sealed Moonshot key (+ optional baseUrl/modelId) for a DID
 * WITHOUT requiring an active `moonshot:infer` grant (#1773).
 *
 * For the model picker only. Listing which models the owner's own key can
 * reach — and choosing one — is the owner configuring their own card before
 * the "grant scopes" step exists, not spending the credential on anyone's
 * behalf. Anything that actually generates content still goes through
 * {@link loadMoonshotCredentials}, which keeps the grant check. Vault custody
 * is NOT skipped: a key pending a Tier 1 grant still reads as `undefined`.
 */
export function loadMoonshotSealedCredentials(ownerDid: string): Promise<MoonshotCredentials | undefined> {
  return moonshot.loadSealedCredentials(ownerDid);
}
