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
import { generateKeypair, emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { eq } from 'drizzle-orm';
import { db, vaultMintedKeys, type VaultMintedKey } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { sealAndGrantStaticSecret, revokeStaticSecretGrant } from './index';
import type { VaultAuthorization } from './authorization';

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

/**
 * Emit the `vault.key.minted` attestation + bus event for a freshly minted
 * key. Extracted (#2247) so both `POST /api/vault/mint` and the /jin vault
 * proposal execution bridge (`approvals-execution.ts` — a mint proposal
 * signed on the canvas rather than called directly over HTTP) produce
 * byte-identical attestation/event shapes instead of two hand-copied call
 * sites drifting apart. Fire-and-forget: never throws, matching every
 * other vault route's existing attestation/publish posture.
 */
export function emitMintedEvents(params: {
  minted: MintKeypairResult;
  purpose: string;
  requesterDid: string;
  mintedBy: string;
  composedBy?: string | null;
  /**
   * Present only when this mint was executed from an approved `vault:mint`
   * canvas proposal (#2247) — the countersigned-decision reference this
   * mechanical action was authorized by. `mintedBy`/`issuer_did` is
   * ALWAYS the node identity in that case (the signing-roles ruling: the
   * node executes and witnesses, never the operator); this is the audit
   * trail linking the mechanical action back to who authorized it.
   */
  authorizedBy?: VaultAuthorization;
}): void {
  const { minted, purpose, requesterDid, mintedBy, composedBy = null, authorizedBy } = params;

  emitAttestation({
    issuer_did: mintedBy,
    subject_did: minted.did,
    type: 'vault.key.minted',
    context_id: minted.mintId,
    context_type: 'vault.mint',
    payload: {
      mintId: minted.mintId,
      publicKey: minted.publicKey,
      purpose,
      requesterDid,
      composedBy,
      grantId: minted.grantId,
      ...(authorizedBy ? { authorizedBy } : {}),
    },
  }).catch((err: unknown) => log.error({ err: String(err), mintId: minted.mintId }, 'vault.key.minted attestation failed'));

  publish('vault.key.minted', {
    issuer: mintedBy,
    subject: minted.did,
    scope: 'vault',
    payload: {
      mintId: minted.mintId,
      did: minted.did,
      publicKey: minted.publicKey,
      field: minted.field,
      purpose,
      requestedBy: requesterDid,
      mintedBy,
      grantId: minted.grantId,
      ...(authorizedBy ? { authorizedBy } : {}),
      context_id: minted.mintId,
      context_type: 'vault.mint',
    },
  }).catch((err: unknown) => log.error({ err: String(err), mintId: minted.mintId }, 'Bus publish error for vault.key.minted'));
}

/**
 * Emit the `vault.key.revoked` attestation + bus event for a revoked
 * minted key. Extracted (#2247) alongside {@link emitMintedEvents} for the
 * same reason — shared by `POST /api/vault/mint/revoke` and the vault
 * proposal execution bridge.
 */
export function emitRevokedEvents(record: VaultMintedKey, revokedBy: string, authorizedBy?: VaultAuthorization): void {
  emitAttestation({
    issuer_did: revokedBy,
    subject_did: record.did,
    type: 'vault.key.revoked',
    context_id: record.id,
    context_type: 'vault.mint',
    payload: {
      mintId: record.id,
      publicKey: record.publicKey,
      revokedBy,
      ...(authorizedBy ? { authorizedBy } : {}),
    },
  }).catch((err: unknown) => log.error({ err: String(err), mintId: record.id }, 'vault.key.revoked attestation failed'));

  publish('vault.key.revoked', {
    issuer: revokedBy,
    subject: record.did,
    scope: 'vault',
    payload: {
      mintId: record.id,
      did: record.did,
      publicKey: record.publicKey,
      revokedBy,
      ...(authorizedBy ? { authorizedBy } : {}),
      context_id: record.id,
      context_type: 'vault.mint',
    },
  }).catch((err: unknown) => log.error({ err: String(err), mintId: record.id }, 'Bus publish error for vault.key.revoked'));
}

/**
 * Emit the `vault.key.withdrawn` attestation + bus event for revoke tier
 * 'withdraw' (#2247) — deactivates a minted key's delegation grant
 * WITHOUT tombstoning the `vault_minted_keys` record itself (distinct
 * from {@link emitRevokedEvents}'s full tombstone). Only call this when
 * something was actually deactivated (`revokeStaticSecretGrant` returned
 * `true`) — a withdraw against a field with no active grant is a no-op
 * and should not mint a record of an action that didn't happen.
 */
export function emitWithdrawnEvents(record: VaultMintedKey, withdrawnBy: string, authorizedBy?: VaultAuthorization): void {
  emitAttestation({
    issuer_did: withdrawnBy,
    subject_did: record.did,
    type: 'vault.key.withdrawn',
    context_id: record.id,
    context_type: 'vault.mint',
    payload: {
      mintId: record.id,
      publicKey: record.publicKey,
      withdrawnBy,
      ...(authorizedBy ? { authorizedBy } : {}),
    },
  }).catch((err: unknown) => log.error({ err: String(err), mintId: record.id }, 'vault.key.withdrawn attestation failed'));

  publish('vault.key.withdrawn', {
    issuer: withdrawnBy,
    subject: record.did,
    scope: 'vault',
    payload: {
      mintId: record.id,
      did: record.did,
      publicKey: record.publicKey,
      withdrawnBy,
      ...(authorizedBy ? { authorizedBy } : {}),
      context_id: record.id,
      context_type: 'vault.mint',
    },
  }).catch((err: unknown) => log.error({ err: String(err), mintId: record.id }, 'Bus publish error for vault.key.withdrawn'));
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
