/**
 * Google Cloud connector backend library (#1317, Stage 1).
 *
 * Connects a human DID's GCP service-account key (sealed in imajin-vault) to
 * the GCP API surface, gated by an active `auth.channel_links` row for the gcp
 * connector app DID + the required scope.
 *
 * Token-paste, not OAuth: the owner pastes a service-account key JSON exactly
 * as they paste a Gemini or Anthropic API key, so all custody mechanics — the
 * per-DID vault field, the fail-closed grant gate, the pending-grant
 * distinction — come from `createConnectorTokenPaste` (#1621). Only GCP's
 * identity is declared here.
 *
 * Stage 1 is connector plumbing only. The MCP tools that spend these scopes are
 * Stage 2, and GCP is deliberately absent from the brain resolver: a service
 * account is a cloud credential, not an inference-only brain.
 */
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';

/** Connector app DID — matches the scope-manifest for the gcp connector. */
export const GCP_CONNECTOR_DID = 'did:imajin:gcp-connector';

/** Scope the owner grants to let their key be used for Vertex AI inference. */
export const GCP_VERTEX_SCOPE = 'gcp:vertex:invoke';

const gcp = createConnectorTokenPaste({
  id: 'gcp',
  displayName: 'Google Cloud',
  connectorDid: GCP_CONNECTOR_DID,
  channel: 'gcp',
});

/**
 * Per-DID vault field for the GCP service-account key.
 *
 * Encoding ownerDid in the field name keeps per-DID isolation at the vault
 * layer: different DIDs cannot share or cross-read each other's keys.
 */
export const vaultField = gcp.vaultField;

/** Seal a service-account key, plus an optional base URL and model id, for this DID. */
export const sealApiKey = gcp.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = gcp.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `gcp_*`. */
export const requireGrantAndKey = gcp.requireGrantAndKey;

/** Whether a GCP key is sealed for this DID (no crypto, no value returned). */
export const gcpKeySealed = gcp.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (Tier 1, #1603). */
export const gcpKeyPending = gcp.keyPending;

export type GcpCredentials = TokenPasteCredentials;

/**
 * Resolve sealed GCP credentials for a DID, or `undefined` when no connection
 * is configured — including one whose key is sealed but still awaiting the
 * owner agent's grant.
 *
 * Fail-closed: vault or DB errors propagate. The resolved key is returned only
 * to the calling scope; it must not be logged, stored in plaintext, or returned
 * to external callers.
 */
export function loadGcpCredentials(ownerDid: string): Promise<GcpCredentials | undefined> {
  return gcp.loadCredentials(ownerDid, GCP_VERTEX_SCOPE);
}
