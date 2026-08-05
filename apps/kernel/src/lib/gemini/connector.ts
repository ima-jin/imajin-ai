/**
 * Gemini connector backend library (#1432).
 *
 * Connects a human DID's Gemini API Key (sealed in imajin-vault) to the Gemini
 * inference surface via the OpenAI-compatible endpoint, gated by an active
 * `auth.channel_links` row for the gemini connector app DID + the required scope.
 *
 * The custody mechanics this connector originally defined — per-DID vault fields,
 * the fail-closed grant gate, the pending-grant distinction, optional sealed
 * baseUrl/modelId — were extracted into `createConnectorTokenPaste` in #1621 when
 * the Anthropic connector became the second instance of the same shape. Behaviour
 * is unchanged, including the `gemini_*` error prefixes callers match on.
 */
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';

/** Connector app DID — matches the scope-manifest for the gemini connector. */
export const GEMINI_CONNECTOR_DID = 'did:imajin:gemini-connector';

/** Scope the owner grants to let their key be used for inference. */
export const GEMINI_INFER_SCOPE = 'gemini:infer';

const gemini = createConnectorTokenPaste({
  id: 'gemini',
  displayName: 'Gemini',
  connectorDid: GEMINI_CONNECTOR_DID,
  channel: 'gemini',
});

/**
 * Per-DID vault field for the Gemini API key.
 *
 * Encoding ownerDid in the field name keeps per-DID isolation at the vault layer:
 * different DIDs cannot share or cross-read each other's keys.
 */
export const vaultField = gemini.vaultField;

/** Seal an API key, plus an optional base URL and model id, for this DID. */
export const sealApiKey = gemini.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = gemini.resolveActiveGrant;

/**
 * Fail-closed gate for callers that require the grant to be present, as opposed
 * to `loadGeminiCredentials` which returns `undefined` gracefully.
 *
 * Throws `gemini_no_grant`, `gemini_no_key`, or `gemini_credential_pending`.
 */
export const requireGrantAndKey = gemini.requireGrantAndKey;

/** Whether a Gemini API key is sealed for this DID (no crypto, no value returned). */
export const geminiKeySealed = gemini.keySealed;

/**
 * Whether a key is sealed but awaiting owner grant approval (Tier 1, #1603).
 *
 * Distinct from `geminiKeySealed`, which reports `false` for this state, so the
 * scope-manifest surface can render "waiting for owner approval" rather than
 * "not connected".
 */
export const geminiKeyPending = gemini.keyPending;

export type GeminiCredentials = TokenPasteCredentials;

/**
 * Resolve sealed Gemini credentials for a DID, or `undefined` when no connection
 * is configured.
 *
 * Fail-closed: vault or DB errors propagate. The resolved key is returned only to
 * the calling scope; it must not be logged, stored in plaintext, or returned to
 * external callers.
 */
export function loadGeminiCredentials(ownerDid: string): Promise<GeminiCredentials | undefined> {
  return gemini.loadCredentials(ownerDid, GEMINI_INFER_SCOPE);
}
