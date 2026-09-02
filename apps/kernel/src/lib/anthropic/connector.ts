/**
 * Anthropic connector backend library (#1621).
 *
 * Connects a human DID's Anthropic API Key (sealed in imajin-vault) to the
 * inference surface, gated by an active `auth.channel_links` row for the
 * anthropic connector app DID + the required scope.
 *
 * All custody mechanics — per-DID vault fields, the fail-closed grant gate, the
 * pending-grant distinction — live in `createConnectorTokenPaste`, shared with
 * the Gemini connector (#1432). Only Anthropic's identity is declared here.
 */
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';

/** Connector app DID — matches the scope-manifest for the anthropic connector. */
export const ANTHROPIC_CONNECTOR_DID = 'did:imajin:anthropic-connector';

/** Scope the owner grants to let their key be used for inference. */
export const ANTHROPIC_INFER_SCOPE = 'anthropic:infer';

/**
 * Anthropic's public API base.
 *
 * Exported so the model-picker route (#1953) has one source for the
 * endpoint, matching the OpenAI/xAI precedent — two copies of a provider
 * endpoint is how one of them ends up pointing at a retired host. NOT used
 * as a `defaultBaseUrl` in `brain.ts`: the Anthropic provider adapter speaks
 * Anthropic's own wire format, not the OpenAI-compatible surface Gemini/xAI
 * repoint, so the completions path resolves its own default via
 * `@imajin/llm`'s `getModel('anthropic', ...)` instead.
 */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

const anthropic = createConnectorTokenPaste({
  id: 'anthropic',
  displayName: 'Anthropic',
  connectorDid: ANTHROPIC_CONNECTOR_DID,
  channel: 'anthropic',
});

/** Per-DID vault field for the Anthropic API key. */
export const vaultField = anthropic.vaultField;

/** Seal an API key, plus an optional base URL and model id, for this DID. */
export const sealApiKey = anthropic.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = anthropic.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `anthropic_*`. */
export const requireGrantAndKey = anthropic.requireGrantAndKey;

/** Whether an Anthropic API key is sealed for this DID. */
export const anthropicKeySealed = anthropic.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const anthropicKeyPending = anthropic.keyPending;

/**
 * Revoke the sealed Anthropic API key's delegation grant for this DID, cutting
 * off access immediately without deleting the sealed key (#1720).
 */
export const revokeApiKey = anthropic.revokeApiKey;

/**
 * Update just the sealed model id for this DID, without touching the API key
 * (#1953, following the #1769 precedent) — how `PUT /anthropic/api/models`
 * commits the owner's model choice.
 */
export const setModelId = anthropic.setModelId;

export type AnthropicCredentials = TokenPasteCredentials;

/**
 * Resolve sealed Anthropic credentials for a DID, or `undefined` when this DID
 * has no Anthropic connection.
 *
 * Returns `undefined` rather than throwing so the brain resolver (#1621) can try
 * the next provider instead of failing the whole pipeline. The resolved key is
 * for the immediate call only: never log it or return it to a caller.
 */
export function loadAnthropicCredentials(ownerDid: string): Promise<AnthropicCredentials | undefined> {
  return anthropic.loadCredentials(ownerDid, ANTHROPIC_INFER_SCOPE);
}

/**
 * Resolve the sealed Anthropic key (+ optional baseUrl/modelId) for a DID
 * WITHOUT requiring an active `anthropic:infer` grant (#1773).
 *
 * For the model picker only, mirroring the Gemini/xAI/OpenAI precedent:
 * listing which models the owner's own key can reach — and choosing one — is
 * the owner configuring their own card before the "grant scopes" step even
 * exists yet, not spending the credential on anyone's behalf. Anything that
 * actually generates content still goes through `loadAnthropicCredentials`,
 * which keeps the grant check. Vault custody is NOT skipped: a key still
 * pending a Tier 1 grant still reads as `undefined`.
 */
export function loadAnthropicSealedCredentials(ownerDid: string): Promise<AnthropicCredentials | undefined> {
  return anthropic.loadSealedCredentials(ownerDid);
}
