import path from 'node:path';
import os from 'node:os';
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
  VAULT_ENTRY_VERSION_V1,
  IntegrityErrorCode,
  VaultIntegrityError,
  type VaultEntry,
  type DelegationWrappedKey,
} from '@imajin/vault-core';
import { verifySync } from '@imajin/auth';
import { and, eq, isNull, gt, or } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants, type VaultDelegationGrant } from '@/src/db';
import { getSealKey, getNodeSigningIdentity, getNodeXPrivateKey } from './sealing';
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
    return _applyDelegationGrant(entry, grant, getNodeXPrivateKey());
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
 *      using entry.senderPubkey (the owner's Ed25519 pubkey).
 *   2. Assert full vault entry integrity (CID, keyId, DID-binding, signature).
 *   3. Unwrap the per-field AES key from the grant using nodeXPriv.
 *   4. AES-256-GCM decrypt the entry ciphertext with the recovered field key.
 *
 * Throws VaultDelegationError if the grant signature is invalid.
 * Throws VaultIntegrityError if the vault entry fails integrity checks.
 */
export async function _applyDelegationGrant(
  entry: VaultEntry,
  grant: Pick<VaultDelegationGrant,
    'subject' | 'grantedTo' | 'field' | 'ownerXPub' |
    'wrappedKey' | 'wrappedNonce' | 'keyId' | 'ownerSignature' | 'expiresAt'
  >,
  nodeXPriv: string,
): Promise<string> {
  // 1. Verify owner signature over the canonical grant payload.
  const canonical = canonicalizeGrantPayload(grant);
  const sigValid = verifySync(grant.ownerSignature, canonical, entry.senderPubkey);
  if (!sigValid) {
    throw new VaultDelegationError(
      `vault _applyDelegationGrant: owner signature on grant for field '${grant.field}' is invalid`,
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
