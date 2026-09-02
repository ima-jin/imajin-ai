/**
 * Z.ai (Zhipu AI, GLM-4.x family) connector backend library (#1931).
 *
 * Connects a human DID's Z.ai API key (sealed in imajin-vault) to the
 * inference surface, gated by an active `auth.channel_links` row for the
 * zai connector app DID + `zai:infer`.
 *
 * Sixth instance of the shape Gemini (#1432), Anthropic (#1621), xAI (#1924),
 * OpenAI (#1927), and Moonshot (#1930) already share: all custody mechanics —
 * per-DID vault fields, the fail-closed grant gate, the pending-grant
 * distinction, the model-picker read that skips the scope check (#1773) —
 * live in `createConnectorTokenPaste`. Only Z.ai's identity is declared here,
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

/** Connector app DID — matches the scope-manifest for the zai connector. */
export const ZAI_CONNECTOR_DID = CONNECTOR_DIDS.zai;

/** Channel label in `auth.channel_links`. */
export const ZAI_CHANNEL = CONNECTOR_CHANNELS.zai;

/** Scope the owner grants to let their key be used for inference. */
export const ZAI_INFER_SCOPE = 'zai:infer';

/**
 * Z.ai's public API base, which is OpenAI-compatible.
 *
 * Verified against Z.ai's own developer docs (https://docs.z.ai/api-reference/introduction,
 * checked 2026-09-02): the international endpoint is `https://api.z.ai/api/paas/v4`.
 * Z.ai/Zhipu operates a SEPARATE mainland-China platform at
 * `https://open.bigmodel.cn/api/paas/v4` with its own billing and API keys —
 * the two hosts are not interchangeable, and a key from one 401s on the
 * other. This connector targets the international `api.z.ai` host only.
 *
 * Exported because both the brain connector entry (`defaultBaseUrl`) and the
 * model-picker route need it, and two copies of a provider endpoint is how
 * one of them ends up pointing at a retired host.
 */
export const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

const zai = createConnectorTokenPaste({
  id: 'zai',
  displayName: 'Z.ai',
  connectorDid: ZAI_CONNECTOR_DID,
  channel: ZAI_CHANNEL,
});

/** Per-DID vault field for the Z.ai API key: `zai-api-key:{ownerDid}`. */
export const vaultField = zai.vaultField;

/** Seal an API key, plus an optional base URL and model id, for this DID. */
export const sealApiKey = zai.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = zai.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `zai_*`. */
export const requireGrantAndKey = zai.requireGrantAndKey;

/** Whether a Z.ai API key is sealed AND readable for this DID (#1724). */
export const zaiKeySealed = zai.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const zaiKeyPending = zai.keyPending;

/**
 * Revoke the sealed Z.ai API key's delegation grant for this DID, cutting off
 * access immediately without deleting the sealed key (#1720).
 */
export const revokeApiKey = zai.revokeApiKey;

/**
 * Update just the sealed model id for this DID, without touching the API key
 * (#1769) — how `PUT /zai/api/models` commits the owner's model choice.
 */
export const setModelId = zai.setModelId;

export type ZaiCredentials = TokenPasteCredentials;

/**
 * Resolve sealed Z.ai credentials for a DID, or `undefined` when this DID has
 * no Z.ai connection.
 *
 * Returns `undefined` rather than throwing so the brain resolver (#1621) can
 * try the next provider instead of failing the whole pipeline. The resolved
 * key is for the immediate call only: never log it or return it to a caller.
 */
export function loadZaiCredentials(ownerDid: string): Promise<ZaiCredentials | undefined> {
  return zai.loadCredentials(ownerDid, ZAI_INFER_SCOPE);
}

/**
 * Resolve the sealed Z.ai key (+ optional baseUrl/modelId) for a DID WITHOUT
 * requiring an active `zai:infer` grant (#1773).
 *
 * For the model picker only. Listing which models the owner's own key can
 * reach — and choosing one — is the owner configuring their own card before
 * the "grant scopes" step exists, not spending the credential on anyone's
 * behalf. Anything that actually generates content still goes through
 * {@link loadZaiCredentials}, which keeps the grant check. Vault custody is
 * NOT skipped: a key pending a Tier 1 grant still reads as `undefined`.
 */
export function loadZaiSealedCredentials(ownerDid: string): Promise<ZaiCredentials | undefined> {
  return zai.loadSealedCredentials(ownerDid);
}
