/**
 * Vault key minting (#2242).
 *
 * Generates an Ed25519 keypair INSIDE the vault: the private key is sealed
 * exactly the same way every other vault secret is sealed, via the existing
 * v2 delegation-grant custody path (#1439/#2231's `sealAndGrantStaticSecret`).
 * `mintKeypair` returns only `{ did, publicKey }` — the private key is held
 * in a local variable just long enough to seal it, is never logged, and is
 * never part of any return value.
 *
 * The sealed private key is delivered to `requesterDid` (e.g. a service's
 * own pre-existing bootstrap identity) as a `oneTime`, `purpose`-bound
 * delegation grant, so it is fetchable through the EXISTING #2231 agent-fetch
 * route (`POST /api/vault/delegation/grants/{grantId}/fetch`) — no new fetch
 * surface is introduced here. `requesterDid` (who the key is minted FOR) is
 * distinct from `mintedBy` (the acting principal who called mint, resolved
 * via requireAuth/actingFor in the route layer) — the former is who receives
 * the material, the latter is who is accountable for having asked for it,
 * and both are recorded on the signed mint attestation.
 *
 * Revocation (`revokeMintedKey`) is a SOFT tombstone for v1: the
 * `vault_minted_keys` row is marked 'revoked' (surviving as the record that
 * a key existed and was withdrawn) and the delegation grant's wrapped key
 * material is erased via the existing `revokeStaticSecretGrant` primitive —
 * the same erase-on-revoke guarantee every other vault delegation grant
 * gets. It does NOT additionally tombstone the underlying vault field entry
 * itself (`deleteFromVault`) — that stronger, harder-destroy action is
 * deferred to a later revocation tier (see the #2242 PR description).
 */
import { generateKeypair } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { eq } from 'drizzle-orm';
import { db, vaultMintedKeys, type VaultMintedKey } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { sealAndGrantStaticSecret, revokeStaticSecretGrant } from './index';

const log = createLogger('kernel');

/**
 * did:imajin DID derived from an Ed25519 public key.
 *
 * Same formula as `getNodeSigningIdentity()` (./sealing.ts) and
 * `@imajin/auth`'s keypair provider's `createDID` — not re-exported from
 * there, so the formula is duplicated here rather than adding a new public
 * export for a single internal caller.
 */
function didFromPublicKey(publicKey: string): string {
  return `did:imajin:${publicKey.slice(0, 16)}`;
}

/** Vault field name holding a minted key's sealed Ed25519 private key. */
export function mintedKeyField(did: string): string {
  return `vault-minted-key:${did}`;
}

export interface MintKeypairParams {
  /** Free-form label naming what the minted key will be used for. */
  purpose: string;
  /**
   * The DID that should receive the one-time delegation grant for the
   * sealed private key — e.g. a service's own pre-existing bootstrap
   * identity. Distinct from `mintedBy`.
   */
  requesterDid: string;
  /** The acting principal who called mint (requireAuth/actingFor). */
  mintedBy: string;
  expiresAt?: Date | null;
}

export interface MintKeypairResult {
  mintId: string;
  did: string;
  publicKey: string;
  field: string;
  /** Null under Tier 1 — the grant is pending the external owner agent. */
  grantId: string | null;
  requestId: string | null;
}

/**
 * Generate a new Ed25519 keypair inside the vault and seal the private key
 * as a v2 delegation-grant entry, granted once to `requesterDid`.
 *
 * No plaintext (the private key) is logged at any point, and it is never
 * present in the returned value.
 */
export async function mintKeypair(params: MintKeypairParams): Promise<MintKeypairResult> {
  const { purpose, requesterDid, mintedBy, expiresAt = null } = params;
  const { privateKey, publicKey } = generateKeypair();
  const did = didFromPublicKey(publicKey);
  const field = mintedKeyField(did);

  const { grantId, requestId } = await sealAndGrantStaticSecret(field, privateKey, {
    principalDid: did,
    granteeDid: requesterDid,
    expiresAt,
    purpose,
    oneTime: true,
  });

  const mintId = generateId('vmk');
  await db.insert(vaultMintedKeys).values({
    id: mintId,
    did,
    publicKey,
    field,
    purpose,
    requestedBy: requesterDid,
    mintedBy,
    grantId,
    status: 'active',
  });

  log.info(
    { mintId, did, requesterDid, mintedBy, purpose, pendingGrant: grantId === null },
    'Vault: minted a new Ed25519 keypair',
  );

  return { mintId, did, publicKey, field, grantId, requestId };
}

export type RevokeMintedKeyOutcome =
  | { status: 'revoked'; record: VaultMintedKey }
  | { status: 'already_revoked'; record: VaultMintedKey }
  | { status: 'not_found' };

/**
 * Tombstone a minted key: mark the `vault_minted_keys` row 'revoked' and
 * erase the delegation grant's wrapped key material (soft tombstone — see
 * this module's docblock for what a harder-destroy tier would add on top).
 *
 * Idempotent: revoking an already-revoked key returns 'already_revoked'
 * rather than erroring, matching the registry-app revoke route's contract
 * (`apps/kernel/app/api/admin/registry/apps/[appId]/revoke/route.ts`).
 */
export async function revokeMintedKey(params: {
  did: string;
  revokedBy: string;
}): Promise<RevokeMintedKeyOutcome> {
  const rows = await db
    .select()
    .from(vaultMintedKeys)
    .where(eq(vaultMintedKeys.did, params.did))
    .limit(1);
  const record = rows[0];
  if (!record) {
    return { status: 'not_found' };
  }
  if (record.status === 'revoked') {
    return { status: 'already_revoked', record };
  }

  // Erases the wrapped key material — the same guarantee every other vault
  // delegation grant revocation gets. Does NOT tombstone the vault entry
  // itself; see this module's docblock.
  await revokeStaticSecretGrant(record.field, record.requestedBy);

  const [updated] = await db
    .update(vaultMintedKeys)
    .set({ status: 'revoked', revokedAt: new Date(), revokedBy: params.revokedBy })
    .where(eq(vaultMintedKeys.id, record.id))
    .returning();

  log.info(
    { mintId: record.id, did: record.did, revokedBy: params.revokedBy },
    'Vault: minted key revoked',
  );

  return { status: 'revoked', record: updated };
}
