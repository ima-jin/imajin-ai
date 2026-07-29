import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  FileVaultRepository,
  VaultEntryService,
  InMemoryFieldLock,
  createDefaultAdapters,
  sealSecret,
  unsealSecret,
  computeVaultCid,
  deriveKeyId,
  signVaultPayload,
  assertEntryIntegrity,
  prepareRotationEntry,
  unwrapFieldKey,
  wrapFieldKey,
  VAULT_ENTRY_VERSION_V1,
  VAULT_ENTRY_VERSION_V2,
  IntegrityErrorCode,
  VaultIntegrityError,
  type VaultEntry,
  type DelegationWrappedKey,
} from '@imajin/vault-core';
import { verifySync, crypto as authCrypto } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { and, eq, isNull, gt, or } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants, vaultGrantRequests, type VaultDelegationGrant } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getSealKey, getNodeSigningIdentity, getNodeXPrivateKey, getNodeXPublicKey, getOwnerXPrivateKey, getOwnerXPublicKey, isVaultTier1, getExternalOwnerXPublicKey, getExternalOwnerEdPublicKey } from './sealing';
import { VaultDelegationError } from './errors';

const log = createLogger('kernel');

const vaultPath = process.env.VAULT_PATH ?? path.join(os.homedir(), '.imajin', 'vault.json');

const repository = new FileVaultRepository({ vaultPath });
const lock = new InMemoryFieldLock();
export const vaultAdapters = createDefaultAdapters();

export const vaultService = new VaultEntryService(repository, {
  lock,
  adapters: vaultAdapters,
});

log.info({ vaultPath }, 'Vault service initialised');

/**
 * Seal a plaintext secret and store it as a signed vault entry.
 *
 * Encrypts with the node's AES-256-GCM seal key, signs with AUTH_PRIVATE_KEY,
 * asserts full entry integrity, and persists. Callable in-process from any
 * tool handler — no HTTP self-call required.
 *
 * No plaintext is logged at any point.
 */
export async function sealAndStore(field: string, plaintext: string): Promise<VaultEntry> {
  const sealKey = getSealKey();
  const identity = getNodeSigningIdentity();

  const blob = sealSecret(plaintext, sealKey);
  const cid = await computeVaultCid(blob);
  const keyId = deriveKeyId(identity.senderPubkey);
  const timestamp = new Date().toISOString();

  const existingEntry = await vaultService.get(field);
  const previousCid = existingEntry?.cid;

  const payload = {
    version: VAULT_ENTRY_VERSION_V1 as typeof VAULT_ENTRY_VERSION_V1,
    field,
    cid,
    encrypted: blob.encrypted,
    nonce: blob.nonce,
    senderDid: identity.senderDid,
    senderPubkey: identity.senderPubkey,
    keyId,
    timestamp,
    ...(previousCid === undefined ? {} : { previousCid }),
  };

  const signature = signVaultPayload(payload, identity.privateKeyHex);
  const entry: VaultEntry = { ...payload, signature };

  await assertEntryIntegrity(entry, vaultAdapters);
  return vaultService.set(entry);
}

/**
 * Seal a plaintext secret as a v2 delegation-grant entry and store it.
 *
 * Unlike sealAndStore (v1), the plaintext is encrypted with a random per-field
 * AES-256-GCM key (not the node-derived seal key). That field key is then
 * ECDH-wrapped by the owner agent and stored as a vault_delegation_grants row.
 *
 * ## Tier 0 (default): the node acts as its own owner agent.
 * The field key is wrapped to the node's X25519 pubkey using the owner's X25519
 * private key (both derived from AUTH_PRIVATE_KEY). Returns `{ entry, grantId }`.
 *
 * ## Tier 1 (VAULT_OWNER_X_PUB + VAULT_OWNER_ED_PUB set): external owner agent.
 * The field key is wrapped from nodeXPriv → ownerXPub (for secure delivery) and
 * stored in vault_grant_requests. A vault.grant.requested event is emitted so
 * the external owner agent (imajin-cli vault serve) can recover the key, create
 * the canonical delegation grant, and POST it to /api/vault/delegation/grant.
 * Returns `{ entry, grantId: null, requestId }`.
 *
 * No plaintext is logged at any point.
 */
export async function sealAndStoreV2(
  field: string,
  plaintext: string,
  options: { expiresAt?: Date | null } = {},
): Promise<{ entry: VaultEntry; grantId: string | null; requestId: string | null }> {
  const identity = getNodeSigningIdentity();
  const fieldKey = randomBytes(32);

  const blob = sealSecret(plaintext, fieldKey);
  const cid = await computeVaultCid(blob);
  const keyId = deriveKeyId(identity.senderPubkey);
  const timestamp = new Date().toISOString();

  const existingEntry = await vaultService.get(field);
  const previousCid = existingEntry?.cid;

  const payload = {
    version: VAULT_ENTRY_VERSION_V2 as typeof VAULT_ENTRY_VERSION_V2,
    field,
    cid,
    encrypted: blob.encrypted,
    nonce: blob.nonce,
    senderDid: identity.senderDid,
    senderPubkey: identity.senderPubkey,
    keyId,
    timestamp,
    custodyScheme: 'delegation-grant' as const,
    ...(previousCid === undefined ? {} : { previousCid }),
  };

  const signature = signVaultPayload(payload, identity.privateKeyHex);
  const entry: VaultEntry = { ...payload, signature };

  await assertEntryIntegrity(entry, vaultAdapters);
  await vaultService.set(entry);

  const expiresAt = options.expiresAt ?? null;

  // ── Tier 1: external owner agent ────────────────────────────────────────────────
  if (isVaultTier1()) {
    const ownerXPub = getExternalOwnerXPublicKey();
    const nodeXPub = getNodeXPublicKey();

    // Wrap the field key from nodeXPriv → ownerXPub so only the owner agent can
    // recover it (unwrapFieldKey(wrapped, nodeXPub, ownerXPriv)).
    const wrappedForOwner = wrapFieldKey(fieldKey, ownerXPub, getNodeXPrivateKey());
    const requestId = randomUUID();
    const requestRowId = generateId('vgr');

    await db.insert(vaultGrantRequests).values({
      id: requestRowId,
      field,
      keyId,
      requestId,
      nodeXPub,
      ownerXPub,
      wrappedFieldKey: wrappedForOwner.encryptedKey,
      wrappedFieldKeyNonce: wrappedForOwner.nonce,
      status: 'pending',
      expiresAt,
    });

    // Fire-and-forget: emit the request event so the owner agent is notified.
    publish('vault.grant.requested', {
      issuer: identity.senderDid,
      subject: identity.senderDid,
      scope: 'vault',
      payload: {
        field,
        nodeXPub,
        nodeDid: identity.senderDid,
        keyId,
        requestId,
        wrappedFieldKey: wrappedForOwner.encryptedKey,
        wrappedFieldKeyNonce: wrappedForOwner.nonce,
        ownerXPub,
        expiresAt: expiresAt?.toISOString() ?? null,
        context_id: requestId,
        context_type: 'vault',
      },
    }).catch((err: unknown) => {
      log.error({ err: String(err), field, requestId }, 'Bus publish error for vault.grant.requested');
    });

    log.info({ field, requestId }, 'Vault Tier 1: grant request created, waiting for owner agent');
    return { entry, grantId: null, requestId };
  }

  // ── Tier 0: node acts as its own owner agent ───────────────────────────────

  // Wrap the field key: owner (this node in Tier 0) wraps to the node's X25519 pubkey.
  const wrapped = wrapFieldKey(fieldKey, getNodeXPublicKey(), getOwnerXPrivateKey());

  const grantRaw = {
    subject: identity.senderDid,
    grantedTo: identity.senderDid,  // self-grant in Tier 0
    field,
    ownerXPub: getOwnerXPublicKey(),
    wrappedKey: wrapped.encryptedKey,
    wrappedNonce: wrapped.nonce,
    keyId,
    expiresAt,
  };

  const ownerSignature = authCrypto.signSync(
    canonicalizeGrantPayload(grantRaw),
    identity.privateKeyHex,
  );

  // Supersede any existing active delegation grant for this (field, node) pair.
  // This handles re-sealing: the old ciphertext+grant become orphaned together.
  if (existingEntry?.custodyScheme === 'delegation-grant') {
    await db
      .update(vaultDelegationGrants)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(vaultDelegationGrants.subject, identity.senderDid),
          eq(vaultDelegationGrants.grantedTo, identity.senderDid),
          eq(vaultDelegationGrants.field, field),
          eq(vaultDelegationGrants.status, 'active'),
        ),
      );
  }

  const grantId = generateId('vdg');
  await db.insert(vaultDelegationGrants).values({
    id: grantId,
    ...grantRaw,
    ownerSignature,
    status: 'active',
  });

  return { entry, grantId, requestId: null };
}

/**
 * Write a signed tombstone (deleted: true) for a vault field, removing it
 * from all future reads while preserving the audit chain.
 *
 * Safe to call on a field that does not exist — returns undefined without error.
 * No plaintext is logged at any point.
 */
export async function deleteFromVault(field: string): Promise<VaultEntry | undefined> {
  const existingEntry = await vaultService.get(field);
  if (!existingEntry) {
    return undefined;
  }

  const sealKey = getSealKey();
  const identity = getNodeSigningIdentity();

  // Seal a fresh tombstone payload so the CID is unique (not a re-hash of the
  // existing blob). The plaintext 'DELETED' is semantically meaningless but
  // gives each tombstone a distinct CID for the chain.
  const blob = sealSecret('DELETED', sealKey);
  const cid = await computeVaultCid(blob);
  const keyId = deriveKeyId(identity.senderPubkey);
  const timestamp = new Date().toISOString();

  const payload = {
    version: VAULT_ENTRY_VERSION_V1 as typeof VAULT_ENTRY_VERSION_V1,
    field,
    cid,
    encrypted: blob.encrypted,
    nonce: blob.nonce,
    senderDid: identity.senderDid,
    senderPubkey: identity.senderPubkey,
    keyId,
    timestamp,
    previousCid: existingEntry.cid,
    deleted: true as const,
  };

  const signature = signVaultPayload(payload, identity.privateKeyHex);
  const entry: VaultEntry = { ...payload, signature };
  return vaultService.set(entry);
}

/**
 * Re-seal a new plaintext value for an existing vault field, chaining the
 * previousCid for a tamper-evident history.
 *
 * Throws if the field does not exist yet — use sealAndStore for initial writes.
 * No plaintext is logged at any point.
 */
export async function rotateAndStore(field: string, plaintext: string): Promise<VaultEntry> {
  const existingEntry = await vaultService.get(field);
  if (!existingEntry) {
    throw new Error(`vault rotateAndStore: field '${field}' not found — use sealAndStore for initial writes`);
  }

  const sealKey = getSealKey();
  const identity = getNodeSigningIdentity();

  const blob = sealSecret(plaintext, sealKey);
  const entry = await prepareRotationEntry(
    existingEntry,
    blob,
    identity.senderPubkey,
    identity.privateKeyHex
  );

  await assertEntryIntegrity(entry, vaultAdapters);
  return vaultService.set(entry);
}

/**
 * Return true when the vault field exists and has not been deleted (tombstoned).
 *
 * Reads only the vault metadata (no crypto operations) — safe to use for
 * status checks where the plaintext value is not needed. Returns false when
 * the field is absent or has been tombstoned via {@link deleteFromVault}.
 */
export async function vaultFieldExists(field: string): Promise<boolean> {
  const entry = await vaultService.get(field);
  return entry !== undefined && entry !== null && entry.deleted !== true;
}

/**
 * Load a vault field and unseal it to plaintext.
 *
 * Dispatches on custodyScheme:
 *   'delegation-grant' (v2) — looks up an active vault_delegation_grants row,
 *     verifies the owner's signature, unwraps the per-field AES key using this
 *     node's X25519 private key, and decrypts.
 *   'node-sealed' / absent (v1) — uses the node's derived AES seal key directly
 *     (existing behaviour, unchanged).
 *
 * Returns undefined if the field does not exist or has been deleted.
 * Throws VaultDelegationError when a delegation grant is required but absent/expired.
 * Throws VaultIntegrityError on any integrity or isolation violation.
 * No plaintext is logged at any point.
 */
export async function loadAndUnseal(field: string): Promise<string | undefined> {
  const entry = await vaultService.get(field);
  if (!entry) {
    return undefined;
  }

  if (entry.custodyScheme === 'delegation-grant') {
    const identity = getNodeSigningIdentity();
    const grant = await fetchActiveGrant(field, identity.senderDid);
    if (!grant) {
      throw new VaultDelegationError(
        `vault loadAndUnseal: no active delegation grant for field '${field}' — node ${identity.senderDid}`,
        { field, nodeDid: identity.senderDid },
      );
    }
    // In Tier 1 the grant is signed by the external owner (VAULT_OWNER_ED_PUB), which differs
    // from the node's own Ed key stored in entry.senderPubkey. In Tier 0 owner == node so
    // entry.senderPubkey is the correct verifier. Resolving the right key here is what makes
    // headless unseal work in Tier 1.
    const ownerEdPub = isVaultTier1() ? getExternalOwnerEdPublicKey() : entry.senderPubkey;
    return _applyDelegationGrant(entry, grant, getNodeXPrivateKey(), ownerEdPub);
  }

  // v1 node-sealed path — unchanged.
  const identity = getNodeSigningIdentity();
  if (entry.senderDid !== identity.senderDid) {
    throw new VaultIntegrityError(
      IntegrityErrorCode.DID_KEY_BINDING_INVALID,
      `vault loadAndUnseal: entry for '${field}' belongs to a different node identity — cross-node read rejected`,
      { entryField: field, details: { entrySenderDid: entry.senderDid, nodeDid: identity.senderDid } }
    );
  }

  await assertEntryIntegrity(entry, vaultAdapters);
  const sealKey = getSealKey();
  return unsealSecret(entry, sealKey);
}

// ── Delegation helpers ────────────────────────────────────────────────────────

/**
 * Fetch the most-recently-created active delegation grant for (field, nodeDid).
 * Returns null if no active, non-expired grant exists.
 */
async function fetchActiveGrant(
  field: string,
  nodeDid: string,
): Promise<VaultDelegationGrant | null> {
  const rows = await db
    .select()
    .from(vaultDelegationGrants)
    .where(
      and(
        eq(vaultDelegationGrants.grantedTo, nodeDid),
        eq(vaultDelegationGrants.field, field),
        eq(vaultDelegationGrants.status, 'active'),
        or(
          isNull(vaultDelegationGrants.expiresAt),
          gt(vaultDelegationGrants.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Canonical form of a delegation grant's signable fields.
 *
 * Keys are sorted alphabetically and serialised as JSON so the canonical string
 * is deterministic regardless of insertion order. The grant-creation path must
 * use the same function when producing ownerSignature.
 */
export function canonicalizeGrantPayload(grant: {
  subject: string;
  grantedTo: string;
  field: string;
  ownerXPub: string;
  wrappedKey: string;
  wrappedNonce: string;
  keyId: string;
  expiresAt: Date | null;
}): string {
  return JSON.stringify({
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    field: grant.field,
    grantedTo: grant.grantedTo,
    keyId: grant.keyId,
    ownerXPub: grant.ownerXPub,
    subject: grant.subject,
    wrappedKey: grant.wrappedKey,
    wrappedNonce: grant.wrappedNonce,
  });
}

/**
 * Apply a delegation grant to a vault entry and return plaintext.
 *
 * Exported as a named internal function (_prefix) so tests can exercise the
 * full crypto path without requiring a live database.
 *
 * Steps:
 *   1. Verify the owner's Ed25519 signature over the canonical grant payload,
 *      using the explicitly-supplied ownerEdPub:
 *        Tier 0 — entry.senderPubkey (node is the owner; both keys are the same)
 *        Tier 1 — VAULT_OWNER_ED_PUB (external owner's key ≠ entry.senderPubkey)
 *      canonicalizeGrantPayload covers wrappedKey, wrappedNonce, and keyId, so a
 *      valid signature cryptographically binds the wrapped key to the intended grant.
 *   1b. Verify grant.keyId matches entry.keyId (defense-in-depth: prevents a valid
 *      grant for one key rotation being misapplied to a different entry).
 *   2. Assert full vault entry integrity (CID, keyId, DID-binding, signature).
 *   3. Unwrap the per-field AES key from the grant using nodeXPriv.
 *   4. AES-256-GCM decrypt the entry ciphertext with the recovered field key.
 *
 * Throws VaultDelegationError if the grant signature is invalid or keyId mismatch.
 * Throws VaultIntegrityError if the vault entry fails integrity checks.
 */
export async function _applyDelegationGrant(
  entry: VaultEntry,
  grant: Pick<VaultDelegationGrant,
    'subject' | 'grantedTo' | 'field' | 'ownerXPub' |
    'wrappedKey' | 'wrappedNonce' | 'keyId' | 'ownerSignature' | 'expiresAt'
  >,
  nodeXPriv: string,
  ownerEdPub: string,
): Promise<string> {
  // 1. Verify owner signature over the canonical grant payload.
  //    ownerEdPub is provided by the caller — in Tier 0 it equals entry.senderPubkey
  //    (owner == node), in Tier 1 it is VAULT_OWNER_ED_PUB (external owner's key).
  const canonical = canonicalizeGrantPayload(grant);
  const sigValid = verifySync(grant.ownerSignature, canonical, ownerEdPub);
  if (!sigValid) {
    throw new VaultDelegationError(
      `vault _applyDelegationGrant: owner signature on grant for field '${grant.field}' is invalid`,
      { field: grant.field, nodeDid: grant.grantedTo },
    );
  }

  // 1b. Guard against a valid-signed grant being applied to the wrong vault entry.
  //     The grant's keyId is covered by the owner signature above, so this check
  //     ensures the grant was specifically issued for this entry's key rotation.
  if (grant.keyId !== entry.keyId) {
    throw new VaultDelegationError(
      `vault _applyDelegationGrant: grant keyId '${grant.keyId}' does not match entry keyId '${entry.keyId}' for field '${grant.field}'`,
      { field: grant.field, nodeDid: grant.grantedTo },
    );
  }

  // 2. Assert vault entry integrity (CID, keyId, DID-binding, entry signature).
  await assertEntryIntegrity(entry, vaultAdapters);

  // 3. Unwrap the per-field AES key.
  const wrapped: DelegationWrappedKey = {
    encryptedKey: grant.wrappedKey,
    nonce: grant.wrappedNonce,
  };
  const fieldKey = unwrapFieldKey(wrapped, grant.ownerXPub, nodeXPriv);

  // 4. Decrypt the ciphertext.
  return unsealSecret(entry, fieldKey);
}
