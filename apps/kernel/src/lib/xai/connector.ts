/**
 * xAI (Grok) connector backend library (#1924).
 *
 * Connects a human DID's xAI API key (sealed in imajin-vault) to the inference
 * surface, gated by an active `auth.channel_links` row for the xai connector
 * app DID + `xai:infer`.
 *
 * Third instance of the shape Gemini (#1432) and Anthropic (#1621) already
 * share: all custody mechanics — per-DID vault fields, the fail-closed grant
 * gate, the pending-grant distinction, the model-picker read that skips the
 * scope check (#1773) — live in `createConnectorTokenPaste`. Only xAI's
 * identity is declared here, which is the whole point of the factory: adding a
 * provider must not be an opportunity to re-litigate custody.
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

/** Connector app DID — matches the scope-manifest for the xai connector. */
export const XAI_CONNECTOR_DID = CONNECTOR_DIDS.xai;

/** Channel label in `auth.channel_links`. */
export const XAI_CHANNEL = CONNECTOR_CHANNELS.xai;

/** Scope the owner grants to let their key be used for inference. */
export const XAI_INFER_SCOPE = 'xai:infer';

/**
 * xAI's public API base, which is OpenAI-compatible.
 *
 * Exported because both the brain connector entry (`defaultBaseUrl`) and the
 * model-picker route need it, and two copies of a provider endpoint is how one
 * of them ends up pointing at a retired host.
 */
export const XAI_BASE_URL = 'https://api.x.ai/v1';

const xai = createConnectorTokenPaste({
  id: 'xai',
  displayName: 'xAI',
  connectorDid: XAI_CONNECTOR_DID,
  channel: XAI_CHANNEL,
});

/** Per-DID vault field for the xAI API key: `xai-api-key:{ownerDid}`. */
export const vaultField = xai.vaultField;

/** Seal an API key, plus an optional base URL and model id, for this DID. */
export const sealApiKey = xai.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = xai.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `xai_*`. */
export const requireGrantAndKey = xai.requireGrantAndKey;

/** Whether an xAI API key is sealed AND readable for this DID (#1724). */
export const xaiKeySealed = xai.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const xaiKeyPending = xai.keyPending;

/**
 * Revoke the sealed xAI API key's delegation grant for this DID, cutting off
 * access immediately without deleting the sealed key (#1720).
 */
export const revokeApiKey = xai.revokeApiKey;

/**
 * Update just the sealed model id for this DID, without touching the API key
 * (#1769) — how `PUT /xai/api/models` commits the owner's model choice.
 */
export const setModelId = xai.setModelId;

export type XaiCredentials = TokenPasteCredentials;

/**
 * Resolve sealed xAI credentials for a DID, or `undefined` when this DID has
 * no xAI connection.
 *
 * Returns `undefined` rather than throwing so the brain resolver (#1621) can
 * try the next provider instead of failing the whole pipeline. The resolved
 * key is for the immediate call only: never log it or return it to a caller.
 */
export function loadXaiCredentials(ownerDid: string): Promise<XaiCredentials | undefined> {
  return xai.loadCredentials(ownerDid, XAI_INFER_SCOPE);
}

/**
 * Resolve the sealed xAI key (+ optional baseUrl/modelId) for a DID WITHOUT
 * requiring an active `xai:infer` grant (#1773).
 *
 * For the model picker only. Listing which models the owner's own key can
 * reach — and choosing one — is the owner configuring their own card before
 * the "grant scopes" step exists, not spending the credential on anyone's
 * behalf. Anything that actually generates content still goes through
 * {@link loadXaiCredentials}, which keeps the grant check. Vault custody is
 * NOT skipped: a key pending a Tier 1 grant still reads as `undefined`.
 */
export function loadXaiSealedCredentials(ownerDid: string): Promise<XaiCredentials | undefined> {
  return xai.loadSealedCredentials(ownerDid);
}
