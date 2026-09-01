/**
 * OpenAI connector backend library (#1927).
 *
 * Connects a human DID's OpenAI API key (sealed in imajin-vault) to the
 * inference surface, gated by an active `auth.channel_links` row for the
 * openai connector app DID + `openai:infer`.
 *
 * Fourth instance of the shape Gemini (#1432), Anthropic (#1621), and xAI
 * (#1924) already share: all custody mechanics — per-DID vault fields, the
 * fail-closed grant gate, the pending-grant distinction, the model-picker
 * read that skips the scope check (#1773) — live in
 * `createConnectorTokenPaste`. Only OpenAI's identity is declared here, which
 * is the whole point of the factory: adding a provider must not be an
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

/** Connector app DID — matches the scope-manifest for the openai connector. */
export const OPENAI_CONNECTOR_DID = CONNECTOR_DIDS.openai;

/** Channel label in `auth.channel_links`. */
export const OPENAI_CHANNEL = CONNECTOR_CHANNELS.openai;

/** Scope the owner grants to let their key be used for inference. */
export const OPENAI_INFER_SCOPE = 'openai:infer';

/**
 * OpenAI's public API base.
 *
 * Exported because both the brain connector entry (`defaultBaseUrl`) and the
 * model-picker route need it, and two copies of a provider endpoint is how
 * one of them ends up pointing at a retired host.
 */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const openai = createConnectorTokenPaste({
  id: 'openai',
  displayName: 'OpenAI',
  connectorDid: OPENAI_CONNECTOR_DID,
  channel: OPENAI_CHANNEL,
});

/** Per-DID vault field for the OpenAI API key: `openai-api-key:{ownerDid}`. */
export const vaultField = openai.vaultField;

/** Seal an API key, plus an optional base URL and model id, for this DID. */
export const sealApiKey = openai.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = openai.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `openai_*`. */
export const requireGrantAndKey = openai.requireGrantAndKey;

/** Whether an OpenAI API key is sealed AND readable for this DID (#1724). */
export const openaiKeySealed = openai.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const openaiKeyPending = openai.keyPending;

/**
 * Revoke the sealed OpenAI API key's delegation grant for this DID, cutting
 * off access immediately without deleting the sealed key (#1720).
 */
export const revokeApiKey = openai.revokeApiKey;

/**
 * Update just the sealed model id for this DID, without touching the API key
 * (#1769) — how `PUT /openai/api/models` commits the owner's model choice.
 */
export const setModelId = openai.setModelId;

export type OpenAICredentials = TokenPasteCredentials;

/**
 * Resolve sealed OpenAI credentials for a DID, or `undefined` when this DID
 * has no OpenAI connection.
 *
 * Returns `undefined` rather than throwing so the brain resolver (#1621) can
 * try the next provider instead of failing the whole pipeline. The resolved
 * key is for the immediate call only: never log it or return it to a caller.
 */
export function loadOpenaiCredentials(ownerDid: string): Promise<OpenAICredentials | undefined> {
  return openai.loadCredentials(ownerDid, OPENAI_INFER_SCOPE);
}

/**
 * Resolve the sealed OpenAI key (+ optional baseUrl/modelId) for a DID
 * WITHOUT requiring an active `openai:infer` grant (#1773).
 *
 * For the model picker only. Listing which models the owner's own key can
 * reach — and choosing one — is the owner configuring their own card before
 * the "grant scopes" step exists, not spending the credential on anyone's
 * behalf. Anything that actually generates content still goes through
 * {@link loadOpenaiCredentials}, which keeps the grant check. Vault custody
 * is NOT skipped: a key pending a Tier 1 grant still reads as `undefined`.
 */
export function loadOpenaiSealedCredentials(ownerDid: string): Promise<OpenAICredentials | undefined> {
  return openai.loadSealedCredentials(ownerDid);
}
