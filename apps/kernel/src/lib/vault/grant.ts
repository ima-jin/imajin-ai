/**
 * Grant an ADDITIONAL consumer access to an already-minted key (#2247).
 *
 * `mintKeypair` (#2242) already seals + grants atomically: the private key
 * is sealed once and a single one-time delegation grant is issued to
 * `requesterDid`. The vault key cards feature on `/jin` needs a standalone
 * "Grant" proposal for the case where a SECOND consumer needs access to the
 * SAME already-minted key — e.g. re-issuing a fresh, unconsumed grant after
 * the original one-time grant was fetched, or authorizing a different
 * service to read the same key.
 *
 * This is achievable WITHOUT re-sealing (which would rotate the ciphertext
 * and invalidate every existing grant) because of how the delegation-grant
 * wrap actually works: the field's AES key is wrapped to the NODE's own
 * X25519 public key (`recipientXPub`), never to anything derived from
 * `grantedTo` — `sealAndGrantStaticSecret`'s own docs are explicit about
 * this ("the node decrypts on the grantee's behalf at call time"). `grantedTo`
 * is an authorization LABEL matched at fetch time
 * (`fetchGrantSecret`/`loadAndUnsealByGrantee`), not a distinct cryptographic
 * recipient. So a fresh `vault_delegation_grants` row for a NEW `grantedTo`
 * can safely reuse the EXACT SAME `wrappedKey`/`wrappedNonce`/`ownerXPub`/
 * `keyId` an existing row already carries, re-signed by the node's own
 * identity (Tier 0) exactly the way `sealAndGrantStaticSecret`'s Tier 0
 * path signs a fresh grant.
 *
 * Tier 1 (external owner agent) is NOT supported here: the node does not
 * hold `ownerXPriv` in that mode, so it cannot produce a valid
 * `ownerSignature` for a new grant row. Tier 1 support would need the
 * external owner agent to countersign, which is out of scope for #2247 —
 * see the PR description's open questions.
 */
import { eq, desc } from 'drizzle-orm';
import { crypto as authCrypto } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants, vaultMintedKeys } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeSigningIdentity, isVaultTier1 } from './sealing';
import { canonicalizeGrantPayload } from './index';
import type { VaultAuthorization } from './authorization';

const log = createLogger('kernel');

export interface GrantExistingMintedKeyParams {
  /** The minted key's DID (the `vault_minted_keys.did` this grant is for). */
  did: string;
  /** The new consumer DID that should be able to fetch the sealed key. */
  grantedTo: string;
  /** Free-form label naming what the grantee intends to use the secret for. */
  purpose?: string | null;
  /** Single-use grant — the agent-fetch route consumes it on first read. */
  oneTime?: boolean;
  expiresAt?: Date | null;
  /** The acting principal who proposed/signed this grant. */
  grantedBy: string;
}

export type GrantExistingMintedKeyResult =
  | { status: 'ok'; grantId: string }
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'no_reusable_grant' }
  | { status: 'tier1_unsupported' };

/**
 * Reuse an existing active grant's wrapped key material to authorize a NEW
 * `grantedTo` DID for the same minted key's field, without re-sealing.
 */
export async function grantExistingMintedKey(
  params: GrantExistingMintedKeyParams,
): Promise<GrantExistingMintedKeyResult> {
  if (isVaultTier1()) {
    return { status: 'tier1_unsupported' };
  }

  const { did, grantedTo, purpose = null, oneTime = false, expiresAt = null } = params;

  const [mintedKey] = await db
    .select()
    .from(vaultMintedKeys)
    .where(eq(vaultMintedKeys.did, did))
    .limit(1);
  if (!mintedKey) {
    return { status: 'not_found' };
  }
  if (mintedKey.status === 'revoked') {
    return { status: 'revoked' };
  }

  // Any row for this field with intact key material works as the reuse
  // source — revoke/supersede blanks wrappedKey/wrappedNonce (see
  // ERASED_KEY_MATERIAL in ./index.ts), so an erased row is naturally
  // skipped by the non-empty check below.
  const candidates = await db
    .select()
    .from(vaultDelegationGrants)
    .where(eq(vaultDelegationGrants.field, mintedKey.field))
    .orderBy(desc(vaultDelegationGrants.createdAt));

  const source = candidates.find((row) => row.wrappedKey.length > 0 && row.wrappedNonce.length > 0);
  if (!source) {
    return { status: 'no_reusable_grant' };
  }

  const identity = getNodeSigningIdentity();
  const grantRaw = {
    subject: did,
    grantedTo,
    field: mintedKey.field,
    ownerXPub: source.ownerXPub,
    wrappedKey: source.wrappedKey,
    wrappedNonce: source.wrappedNonce,
    keyId: source.keyId,
    expiresAt,
  };
  const ownerSignature = authCrypto.signSync(canonicalizeGrantPayload(grantRaw), identity.privateKeyHex);

  const grantId = generateId('vdg');
  await db.insert(vaultDelegationGrants).values({
    id: grantId,
    ...grantRaw,
    ownerSignature,
    status: 'active',
    recipientXPub: source.recipientXPub,
    ownerEdPub: source.ownerEdPub ?? identity.senderPubkey,
    purpose,
    oneTime,
  });

  log.info(
    { did, field: mintedKey.field, grantId, grantedTo, grantedBy: params.grantedBy },
    'Vault: granted an additional consumer access to an existing minted key',
  );

  return { status: 'ok', grantId };
}

/**
 * Emit the `vault.grant.fulfilled` bus event for a successful
 * {@link grantExistingMintedKey} call. Extracted (#2247) alongside
 * `emitMintedEvents`/`emitRevokedEvents` in `./mint.ts` — the same "shared
 * component, not a copy" posture for the proposal execution bridge.
 *
 * No signed attestation here, matching the pre-existing
 * `POST /api/vault/delegation/grant` route's own precedent — grant
 * issuance is audited via bus event only; `'vault.grant.fulfilled'` is not
 * a registered `AttestationType` (see `packages/auth/src/types/
 * attestation.ts`), unlike `vault.key.minted`/`vault.key.revoked`.
 */
export function emitGrantEvents(params: {
  grantId: string;
  did: string;
  field: string;
  grantedTo: string;
  grantedBy: string;
  /** Present only when executed from an approved `vault:grant` canvas proposal (#2247). */
  authorizedBy?: VaultAuthorization;
}): void {
  const { grantId, did, field, grantedTo, grantedBy, authorizedBy } = params;

  publish('vault.grant.fulfilled', {
    issuer: grantedBy,
    subject: did,
    scope: 'vault',
    payload: {
      grantId,
      requestId: null,
      field,
      subject: did,
      grantedTo,
      ...(authorizedBy ? { authorizedBy } : {}),
      context_id: field,
      context_type: 'vault',
    },
  }).catch((err: unknown) => log.error({ err: String(err), grantId }, 'Bus publish error for vault.grant.fulfilled'));
}

/** Narrow re-export for tests that need the raw grant row shape. */
export type { VaultDelegationGrant } from '@/src/db';
