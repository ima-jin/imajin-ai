/**
 * OpenRouter connector backend library (#2188).
 *
 * Connects a human DID's OpenRouter API key (sealed in imajin-vault) to the
 * inference surface, gated by an active `auth.channel_links` row for the
 * openrouter connector app DID + `openrouter:infer`.
 *
 * Same shape Gemini (#1432), Anthropic (#1621), xAI (#1924), OpenAI (#1927),
 * Moonshot (#1930), and Z.ai (#1931) already share: all custody mechanics —
 * per-DID vault fields, the fail-closed grant gate, the pending-grant
 * distinction, the model-picker read that skips the scope check (#1773) —
 * live in `createConnectorTokenPaste`. Only OpenRouter's identity is
 * declared here, which is the whole point of the factory: adding a provider
 * must not be an opportunity to re-litigate custody.
 *
 * OpenRouter is itself a router, not a single model — one sealed key gives
 * passthrough reach into every model OpenRouter fronts (including
 * `typesafe/jev-1.13`, the #2187 Jev spike's target model), forwarded
 * through untouched (see `openai-compatible-adapter.ts`). OpenRouter has no
 * OAuth, so this uses the same static-secret/token-paste factory every other
 * brain connector uses.
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

/** Connector app DID — matches the scope-manifest for the openrouter connector. */
export const OPENROUTER_CONNECTOR_DID = CONNECTOR_DIDS.openrouter;

/** Channel label in `auth.channel_links`. */
export const OPENROUTER_CHANNEL = CONNECTOR_CHANNELS.openrouter;

/** Scope the owner grants to let their key be used for inference. */
export const OPENROUTER_INFER_SCOPE = 'openrouter:infer';

/**
 * OpenRouter's public API base, which is OpenAI-compatible.
 *
 * Exported because both the brain connector entry (`defaultBaseUrl`) and the
 * model-picker route need it, and two copies of a provider endpoint is how
 * one of them ends up pointing at a retired host.
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const openrouter = createConnectorTokenPaste({
  id: 'openrouter',
  displayName: 'OpenRouter',
  connectorDid: OPENROUTER_CONNECTOR_DID,
  channel: OPENROUTER_CHANNEL,
});

/** Per-DID vault field for the OpenRouter API key: `openrouter-api-key:{ownerDid}`. */
export const vaultField = openrouter.vaultField;

/** Seal an API key, plus an optional base URL and model id, for this DID. */
export const sealApiKey = openrouter.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = openrouter.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `openrouter_*`. */
export const requireGrantAndKey = openrouter.requireGrantAndKey;

/** Whether an OpenRouter API key is sealed AND readable for this DID (#1724). */
export const openrouterKeySealed = openrouter.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const openrouterKeyPending = openrouter.keyPending;

/**
 * Revoke the sealed OpenRouter API key's delegation grant for this DID,
 * cutting off access immediately without deleting the sealed key (#1720).
 */
export const revokeApiKey = openrouter.revokeApiKey;

/**
 * Update just the sealed model id for this DID, without touching the API key
 * (#1769) — how `PUT /openrouter/api/models` commits the owner's model
 * choice (e.g. `typesafe/jev-1.13`, forwarded to OpenRouter untouched).
 */
export const setModelId = openrouter.setModelId;

export type OpenrouterCredentials = TokenPasteCredentials;

/**
 * Resolve sealed OpenRouter credentials for a DID, or `undefined` when this
 * DID has no OpenRouter connection.
 *
 * Returns `undefined` rather than throwing so the brain resolver (#1621) can
 * try the next provider instead of failing the whole pipeline. The resolved
 * key is for the immediate call only: never log it or return it to a caller.
 */
export function loadOpenrouterCredentials(ownerDid: string): Promise<OpenrouterCredentials | undefined> {
  return openrouter.loadCredentials(ownerDid, OPENROUTER_INFER_SCOPE);
}

/**
 * Resolve the sealed OpenRouter key (+ optional baseUrl/modelId) for a DID
 * WITHOUT requiring an active `openrouter:infer` grant (#1773).
 *
 * For the model picker only. Listing which models the owner's own key can
 * reach — and choosing one — is the owner configuring their own card before
 * the "grant scopes" step exists, not spending the credential on anyone's
 * behalf. Anything that actually generates content still goes through
 * {@link loadOpenrouterCredentials}, which keeps the grant check. Vault
 * custody is NOT skipped: a key pending a Tier 1 grant still reads as
 * `undefined`.
 */
export function loadOpenrouterSealedCredentials(ownerDid: string): Promise<OpenrouterCredentials | undefined> {
  return openrouter.loadSealedCredentials(ownerDid);
}
