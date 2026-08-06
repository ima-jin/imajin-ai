/**
 * Warp Cloud Agent connector backend library (#1428).
 *
 * Seals a per-DID **Warp Agent key** so each `{username}-jin` dispatches Warp
 * cloud agents under its *own* credential. The sealed key is the individuation:
 * a run fired with this key is attributed to the key's Warp service account, not
 * to a human, so agent-to-agent dispatch is individuated by construction rather
 * than by convention.
 *
 * Custody is the v2 delegation-grant path (#1242 / #1246), reached through the
 * static-secret factory (#1439) rather than open-coded here:
 *   - vault field `warp-agent-key:{principalDid}` holds a v2 entry with
 *     `custodyScheme: 'delegation-grant'` and a random per-field AES key.
 *   - that field key is ECDH-wrapped and held as an owner-signed, scoped,
 *     revocable row in `vault_delegation_grants`, with
 *     `subject = principalDid` and `grantedTo = did:imajin:warp-connector`.
 *   - **revoke kills dispatch, no key rotation.** Revoking the grant erases the
 *     wrapped key material, so `requireAgentKey` fails closed immediately while
 *     the ciphertext is left untouched. That is the property that makes this the
 *     right custody class for a credential which can spawn cloud agents.
 *
 * Authority-gating (#1218) is the factory's `channel_links` check: an active
 * `warp` channel row for the caller's DID carrying `warp:dispatch`. No active
 * row ⇒ no dispatch, even with a key sealed.
 *
 * The key is NEVER logged, NEVER returned to a caller, NEVER echoed.
 */
import { CONNECTOR_DIDS, CONNECTOR_CHANNELS } from '@imajin/auth/scope-vocabulary';
import { createConnectorStaticSecret } from '@/src/lib/kernel/connector-static-secret';

/** Connector app DID — the grantee of every per-DID Warp key delegation grant. */
export const WARP_CONNECTOR_DID = CONNECTOR_DIDS.warp;

/** Channel name in `auth.channel_links`. */
export const WARP_CHANNEL = CONNECTOR_CHANNELS.warp;

/**
 * The scope that gates the dispatch wire — everything that touches the sealed
 * Agent key.
 *
 * Reading a run's state is deliberately gated by the same scope as firing one:
 * a run is only visible to the credential that dispatched it, so there is no
 * read surface to grant independently of dispatch.
 */
export const WARP_DISPATCH_SCOPE = 'warp:dispatch';

/**
 * The read-only scope that gates the node's self-description surface (#1636).
 *
 * Deliberately separate from {@link WARP_DISPATCH_SCOPE}: dispatch consumes a
 * sealed credential and spawns billable work, whereas this grants nothing but
 * reads of the OpenAPI specs, the scope vocabulary, and the caller's own
 * connector status. An agent should be able to learn what the system exposes
 * without being handed the ability to spend money, and revoking one must not
 * revoke the other.
 *
 * There is no write counterpart on purpose — writes go through git/PR.
 */
export const WARP_DISCOVERY_SCOPE = 'discovery:read';

/** Vault field prefix — the full field is `warp-agent-key:{principalDid}`. */
export const WARP_SECRET_PREFIX = 'warp-agent-key';

export const warpConnector = createConnectorStaticSecret({
  name: 'warp',
  secretPrefix: WARP_SECRET_PREFIX,
  connectorDid: WARP_CONNECTOR_DID,
  channel: WARP_CHANNEL,
});

/** Vault field holding this DID's sealed Warp Agent key. */
export const warpKeyField = warpConnector.secretField;

/**
 * Seal a Warp Agent key for `principalDid` and mint the delegation grant.
 *
 * Re-sealing supersedes the previous grant and crypto-erases the superseded
 * field key (rotate semantics). The plaintext is never returned.
 */
export const sealWarpAgentKey = warpConnector.sealAndGrant;

/**
 * Fail-closed gate: resolve the caller's `warp:dispatch` authority, then unwrap
 * their sealed Warp Agent key.
 *
 * The returned key must stay inside the calling scope — it is a Bearer
 * credential for `POST /agent/run` and nothing else.
 *
 * Throws `warp_no_grant` when no active `warp:dispatch` channel row exists, and
 * `warp_no_secret` when no key is sealed or the delegation grant has been
 * revoked or expired.
 */
export function requireAgentKey(principalDid: string): Promise<string> {
  return warpConnector.requireSecret(principalDid, WARP_DISPATCH_SCOPE);
}

/**
 * Fail-closed gate for the read-only discovery surface (#1636).
 *
 * The token-scope check in `handleMcpRpc` is the coarse OAuth gate; this is the
 * sovereignty gate, and it is the same one dispatch passes through — an active
 * `warp` channel_links row carrying the scope, written by the projection reactor
 * when the owner publishes their Warp scope-manifest. Removing the toggle revokes
 * the row and closes the surface on the next call.
 *
 * Unlike {@link requireAgentKey} there is no credential to unwrap, so this
 * returns nothing: it either passes or throws `warp_no_grant`.
 */
export async function requireDiscoveryGrant(principalDid: string): Promise<void> {
  const hasGrant = await warpConnector.resolveActiveGrant(principalDid, WARP_DISCOVERY_SCOPE);
  if (!hasGrant) {
    throw new Error(
      `warp_no_grant: DID ${principalDid} has no active '${WARP_DISCOVERY_SCOPE}' grant — ` +
      `enable it on the Warp connector card to read API specs, the scope vocabulary, ` +
      `and your connector status`,
    );
  }
}

/** Revoke the delegation grant, killing dispatch for this DID immediately. */
export const revokeWarpAgentKeyGrant = warpConnector.revokeGrant;

/** Whether a Warp Agent key is sealed for this DID (no crypto, no value read). */
export const warpKeySealed = warpConnector.secretSealed;

/**
 * Whether a Warp Agent key is sealed but still awaiting the owner agent's grant
 * (Tier 1, #1603).
 *
 * Distinct from {@link warpKeySealed}, which reports `false` here because the key
 * cannot be read yet. Dispatch fails closed in this state, so the connector needs
 * to render "waiting for owner approval" rather than "not connected" — otherwise
 * the operator's next move is to re-paste a key that is already sealed correctly.
 */
export const warpKeyPending = warpConnector.secretPending;
