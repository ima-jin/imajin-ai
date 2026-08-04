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
  verifyEntryIntegrity,
  VAULT_ENTRY_VERSION_V1,
  VAULT_ENTRY_VERSION_V2,
  IntegrityErrorCode,
  VaultIntegrityError,
  type VaultEntry,
  type DelegationWrappedKey,
} from '@imajin/vault-core';
import { verifySync, crypto as authCrypto } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { and, eq, isNull, gt, or, type SQL } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, vaultDelegationGrants, vaultGrantRequests, vaultOwnerEnvelopes, type VaultDelegationGrant, type VaultOwnerEnvelope } from '@/src/db';
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

// Deliberately does NOT derive the signing identity here. `next build` imports
// this module with NODE_ENV=production while collecting page data, and a build
// machine has no AUTH_PRIVATE_KEY — deriving at import time turns the runtime
// key guard into a build failure. The identity is logged on first derivation
// instead (see getNodeSigningIdentity in ./sealing).
log.info({ vaultPath }, 'Vault service initialised');

/**
 * Resolve the `previousCid` a new entry for `field` must chain from.
 *
 * Reads the RAW latest entry (`peek`), not `get`, for two reasons:
 *   - `get` hides tombstones, so a re-seal after a disconnect would sign a
 *     payload with no `previousCid` while the store still chains from the
 *     tombstone — a signed/persisted mismatch that fails verification forever.
 *   - `get` asserts integrity, so an unverifiable entry would make it
 *     impossible to write a replacement over it.
 *
 * The peeked entry is never unsealed here; only its cid is read.
 */
async function resolvePreviousCid(field: string): Promise<string | undefined> {
  const latest = await vaultService.peek(field);
  return latest?.cid;
}

// ── Owner envelopes (#1521) ────────────────────────────────────────────────

/**
 * Persist the owner's recoverable copy of a field key.
 *
 * Without this the field key exists only inside the delegation grant (wrapped to
 * the node), which means revoking or expiring that grant would destroy the last
 * copy — making expiry a permanent lockout and porting impossible. The envelope
 * is what lets the owner re-issue a grant later, to this node or a different one,
 * with no cooperation from the node holding the current grant.
 *
 * Wrapped `nodeXPriv → ownerXPub`, so only the owner can open it. `senderXPub` is
 * recorded because ECDH needs the counterparty key at unwrap time.
 *
 * Upserted rather than inserted: `keyId` is derived from the node's signing key and
 * so is constant across re-seals. The envelope therefore always tracks the CURRENT
 * field key, and a re-seal deliberately crypto-erases the superseded one.
 *
 * The raw field key is never logged.
 */
async function writeOwnerEnvelope(params: {
  field: string;
  keyId: string;
  fieldKey: Buffer;
  ownerXPub: string;
}): Promise<void> {
  const senderXPub = getNodeXPublicKey();
  const wrapped = wrapFieldKey(params.fieldKey, params.ownerXPub, getNodeXPrivateKey());

  await db
    .insert(vaultOwnerEnvelopes)
    .values({
      id: generateId('vwe'),
      field: params.field,
      keyId: params.keyId,
      ownerXPub: params.ownerXPub,
      senderXPub,
      wrappedKey: wrapped.encryptedKey,
      wrappedNonce: wrapped.nonce,
    })
    .onConflictDoUpdate({
      target: [vaultOwnerEnvelopes.field, vaultOwnerEnvelopes.keyId],
      set: {
        ownerXPub: params.ownerXPub,
        senderXPub,
        wrappedKey: wrapped.encryptedKey,
        wrappedNonce: wrapped.nonce,
        createdAt: new Date(),
      },
    });
}

/**
 * Return true when the owner holds a recoverable copy of the field key for
 * (field, keyId).
 *
 * This is the precondition for erasing a grant's key material. Erase is
 * irreversible, so it must never run when this returns false.
 */
async function hasOwnerEnvelope(field: string, keyId: string): Promise<boolean> {
  const rows = await db
    .select({ id: vaultOwnerEnvelopes.id })
    .from(vaultOwnerEnvelopes)
    .where(and(eq(vaultOwnerEnvelopes.field, field), eq(vaultOwnerEnvelopes.keyId, keyId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Values that blank a grant's wrapped key material.
 *
 * Marking a grant `revoked` only stops `fetchActiveGrant` from returning it — the
 * wrapped key stays in the row, so anyone with `nodeXPriv` and database access can
 * still recover the field key from a revoked grant. Revocation constrained the code
 * path, not an attacker, and expiry inherited the same weakness.
 *
 * Blanking the material is what gives revocation and expiry real effect.
 */
const ERASED_KEY_MATERIAL = { wrappedKey: '', wrappedNonce: '' } as const;

/**
 * Erase key material for grants leaving `active`, but only where an owner envelope
 * exists for that (field, keyId).
 *
 * Grants with no envelope are left intact and logged: for those the wrapped key is
 * still the only copy of the field key, so erasing it would destroy the secret.
 * Those are pre-#1521 grants and stop appearing once every field is re-sealed.
 *
 * What the guard does and does not promise, stated exactly, because `keyId` is
 * derived from the node's signing key and so does not distinguish generations of a
 * field:
 *   - **Revoke / expire** — the erased grant covers the field's current entry, and
 *     the envelope holds that same current field key. The owner can still re-issue,
 *     so nothing is lost. This is the case the guard exists for.
 *   - **Supersede on re-seal** — the envelope has already been upserted to the NEW
 *     field key, so erasing the superseded grant destroys the last copy of the OLD
 *     one, and history reads of superseded generations become permanently
 *     unavailable.
 *
 * That last behaviour is intended, not a limitation to work around. The vault holds
 * rotating credentials: a superseded generation should be unreadable, because the
 * alternative is a decryptable archive of every secret the field has ever held —
 * more to steal, for no operational benefit. History belongs in signed events, not
 * in the secret store.
 */
async function eraseGrantKeyMaterial(
  grants: Array<Pick<VaultDelegationGrant, 'id' | 'field' | 'keyId'>>,
): Promise<string[]> {
  const erased: string[] = [];

  for (const grant of grants) {
    if (!(await hasOwnerEnvelope(grant.field, grant.keyId))) {
      log.warn(
        { grantId: grant.id, field: grant.field },
        'Vault: skipping key-material erase — no owner envelope, wrapped key is the only copy',
      );
      continue;
    }

    await db
      .update(vaultDelegationGrants)
      .set(ERASED_KEY_MATERIAL)
      .where(eq(vaultDelegationGrants.id, grant.id));
    erased.push(grant.id);
  }

  return erased;
}

/**
 * Supersede the active grants matched by `where` and erase their key material.
 *
 * Callers run this immediately after writing a new envelope for the field, so the
 * erase deliberately destroys the superseded generation's key while leaving the
 * current one recoverable. See {@link eraseGrantKeyMaterial} for the exact
 * guarantee.
 */
async function supersedeGrants(where: SQL | undefined): Promise<void> {
  const superseded = await db
    .update(vaultDelegationGrants)
    .set({ status: 'superseded' })
    .where(where)
    .returning({
      id: vaultDelegationGrants.id,
      field: vaultDelegationGrants.field,
      keyId: vaultDelegationGrants.keyId,
    });

  await eraseGrantKeyMaterial(superseded);
}

/**
 * Erase key material for a set of grants that have already been moved out of
 * `active` by the caller. Exported for the revoke route and the expiry sweep.
 */
export async function eraseInactiveGrantKeyMaterial(
  grants: Array<Pick<VaultDelegationGrant, 'id' | 'field' | 'keyId'>>,
): Promise<string[]> {
  return eraseGrantKeyMaterial(grants);
}

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

  const previousCid = await resolvePreviousCid(field);

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

  // Raw latest entry (tombstones included) — both for chaining previousCid and
  // for deciding whether a prior delegation grant needs superseding.
  const existingEntry = await vaultService.peek(field);
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

  // `undefined` means "use the configured default"; an explicit `null` means the
  // caller genuinely wants a non-expiring grant and must not be overridden.
  const expiresAt = options.expiresAt === undefined
    ? defaultGrantExpiry()
    : options.expiresAt;

  // ── Tier 1: external owner agent ────────────────────────────────────────────────
  if (isVaultTier1()) {
    const ownerXPub = getExternalOwnerXPublicKey();
    const nodeXPub = getNodeXPublicKey();

    // Durable owner copy, written before the request. The request row carries the
    // same wrap, but it is a queue entry with its own lifecycle — the envelope is
    // what survives fulfilment, expiry, and any pruning of that queue.
    await writeOwnerEnvelope({ field, keyId, fieldKey, ownerXPub });

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
      // A self-grant: this node is both the granting and receiving party. Written
      // explicitly (#1603) rather than left NULL so the owner agent never has to
      // infer the custody shape.
      subject: identity.senderDid,
      grantedTo: identity.senderDid,
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
        grantSubject: identity.senderDid,
        grantedTo: identity.senderDid,
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

  const nodeXPub = getNodeXPublicKey();

  // Durable owner copy. In Tier 0 the owner is this node, so the envelope adds no
  // custody separation — but it keeps the invariant uniform, which is what lets
  // erase-on-revoke apply to every v2 entry regardless of tier, and what makes a
  // later promotion to Tier 1 a re-grant rather than a re-seal.
  await writeOwnerEnvelope({ field, keyId, fieldKey, ownerXPub: getOwnerXPublicKey() });

  // Wrap the field key: owner (this node in Tier 0) wraps to the node's X25519 pubkey.
  const wrapped = wrapFieldKey(fieldKey, nodeXPub, getOwnerXPrivateKey());

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
    await supersedeGrants(
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
    // Self-describing: the recipient pubkey ECDH needs, and the verifier this
    // grant's signature must check against (the node itself, for a self-grant).
    recipientXPub: nodeXPub,
    ownerEdPub: identity.senderPubkey,
  });

  return { entry, grantId, requestId: null };
}

/**
 * Write a signed tombstone (deleted: true) for a vault field, removing it
 * from all future reads while preserving the audit chain.
 *
 * Safe to call on a field that does not exist — returns undefined without error.
 * Also safe to call on an already-tombstoned or UNVERIFIABLE field: this is the
 * recovery path connector disconnect relies on, so it must never depend on the
 * existing entry being readable. It peeks the raw latest entry and only reads
 * its cid — the corrupt entry is never unsealed, and the fresh tombstone is
 * signed by the current node identity.
 *
 * No plaintext is logged at any point.
 */
export async function deleteFromVault(field: string): Promise<VaultEntry | undefined> {
  const existingEntry = await vaultService.peek(field);
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
 * Dispatches on the EXISTING entry's custodyScheme (#1546):
 *   'delegation-grant' (v2) — delegates entirely to sealAndStoreV2, which
 *     already generates a fresh per-field AES key, chains previousCid, writes
 *     the owner envelope, and supersedes + crypto-erases the prior active
 *     grant. Rotation is "re-seal, keep the chain" for v2 fields; it must run
 *     through the exact same custody machinery a fresh v2 seal does, or the
 *     two paths silently drift apart.
 *   'node-sealed' / absent (v1) — unchanged: re-seals with the node's static
 *     derived key via prepareRotationEntry.
 *
 * Before this dispatch existed, EVERY rotation — regardless of the existing
 * entry's version — hardcoded v1 via prepareRotationEntry. That silently
 * downgraded a v2 field's custody on its very next rotation: the v1 read path
 * kept working (via the node's static seal key), so nothing broke visibly,
 * but the field silently exited delegation-grant custody and the old
 * vault_delegation_grants row was left dangling, active, and unusable.
 *
 * Throws if the field does not exist yet — use sealAndStore for initial writes.
 * No plaintext is logged at any point.
 */
export async function rotateAndStore(field: string, plaintext: string): Promise<VaultEntry> {
  const existingEntry = await vaultService.get(field);
  if (!existingEntry) {
    throw new Error(`vault rotateAndStore: field '${field}' not found — use sealAndStore for initial writes`);
  }

  if (existingEntry.custodyScheme === 'delegation-grant') {
    const { entry } = await sealAndStoreV2(field, plaintext);
    return entry;
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
 * Return true when the vault field holds a usable, verifiable secret.
 *
 * Never unseals — safe for status checks where the plaintext is not needed.
 * Returns false when the field is absent, tombstoned via
 * {@link deleteFromVault}, or fails integrity verification.
 *
 * Treating an unverifiable entry as `false` is the fail-closed reading of
 * "is a usable credential sealed here?". Throwing instead would take down the
 * connector status endpoint that renders the Disconnect button, making a single
 * bad entry unrecoverable through the UI. The integrity failure is logged so
 * the underlying problem stays visible rather than being silently swallowed.
 */
export async function vaultFieldExists(field: string): Promise<boolean> {
  const entry = await vaultService.peek(field);
  if (!entry || entry.deleted === true) {
    return false;
  }

  const verified = await verifyEntryIntegrity(entry, vaultAdapters);
  if (!verified.ok) {
    log.warn(
      { field, code: verified.error.code },
      'Vault field failed integrity verification — reporting as not sealed',
    );
    return false;
  }
  return true;
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
    return _applyDelegationGrant(entry, grant, getNodeXPrivateKey(), resolveGrantVerifier(entry, grant));
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

// ── Static-secret vault primitives (#1439) ───────────────────────────────────

/**
 * Seal a plaintext secret as a v2 delegation-grant entry and store it,
 * minting a grant where `subject = principalDid` and `grantedTo = granteeDid`
 * (Option-B custody — principal owns the key, app DID is the grantee).
 *
 * This is the generic lower-level primitive behind the static-secret connector
 * factory. Callers are responsible for choosing the vault field name (typically
 * `${secretPrefix}:${principalDid}`).
 *
 * ## Tier 0 (default): the node acts as its own owner agent.
 * A random per-field AES-256-GCM key is generated, the plaintext is encrypted,
 * and the field key is ECDH-wrapped to the node's X25519 pubkey using the owner's
 * X25519 private key. The grant is signed by the node's Ed25519 signing identity
 * and is active immediately. Returns `{ entry, grantId, requestId: null }`.
 *
 * ## Tier 1 (VAULT_OWNER_X_PUB + VAULT_OWNER_ED_PUB set): external owner agent.
 * The node cannot mint the grant — `ownerXPriv` is not on this machine. It seals
 * the entry, writes the owner envelope, and queues a `vault_grant_requests` row
 * carrying the custody pair, then emits `vault.grant.requested`. The field is
 * readable only once the owner agent answers, so callers must treat
 * `grantId: null` as "sealed, awaiting owner approval" rather than as failure —
 * see {@link vaultFieldStatusForGrantee}. Returns `{ entry, grantId: null, requestId }`.
 *
 * In BOTH tiers the field key is wrapped to the **node's** X25519 key, never to
 * anything derived from `granteeDid`. `grantedTo` authorizes; the node decrypts on
 * the grantee's behalf at call time (see {@link loadAndUnsealByGrantee}).
 *
 * Supersedes any existing active grant for the (principalDid, granteeDid, field)
 * tuple before inserting the new row (rotation semantics).
 *
 * No plaintext is logged at any point.
 */
export async function sealAndGrantStaticSecret(
  field: string,
  plaintext: string,
  options: { principalDid: string; granteeDid: string; expiresAt?: Date | null },
): Promise<{ entry: VaultEntry; grantId: string | null; requestId: string | null }> {
  const { principalDid, granteeDid, expiresAt = null } = options;
  const identity = getNodeSigningIdentity();
  const fieldKey = randomBytes(32);

  const blob = sealSecret(plaintext, fieldKey);
  const cid = await computeVaultCid(blob);
  const keyId = deriveKeyId(identity.senderPubkey);
  const timestamp = new Date().toISOString();

  const previousCid = await resolvePreviousCid(field);

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

  const nodeXPub = getNodeXPublicKey();

  // ── Tier 1: hand the field key to the external owner agent ─────────────────
  if (isVaultTier1()) {
    const ownerXPub = getExternalOwnerXPublicKey();

    // Durable owner copy first: it is what a later renewal or port is issued
    // from, and it must exist before anything can be superseded and erased.
    await writeOwnerEnvelope({ field, keyId, fieldKey, ownerXPub });

    // Deliberately NOT superseding the prior grant here. In Tier 1 the
    // replacement does not exist yet, so revoking the working grant now would
    // black out the field for the entire round-trip to the owner agent. The
    // grant endpoint supersedes at the moment it installs the new one.
    const wrappedForOwner = wrapFieldKey(fieldKey, ownerXPub, getNodeXPrivateKey());
    const requestId = randomUUID();

    await db.insert(vaultGrantRequests).values({
      id: generateId('vgr'),
      field,
      keyId,
      requestId,
      nodeXPub,
      ownerXPub,
      wrappedFieldKey: wrappedForOwner.encryptedKey,
      wrappedFieldKeyNonce: wrappedForOwner.nonce,
      status: 'pending',
      expiresAt,
      // The custody pair the owner must sign (#1603). Without these the owner
      // agent would default to a node self-grant, which the grantee could never
      // use.
      subject: principalDid,
      grantedTo: granteeDid,
    });

    publish('vault.grant.requested', {
      issuer: identity.senderDid,
      subject: principalDid,
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
        grantSubject: principalDid,
        grantedTo: granteeDid,
        context_id: requestId,
        context_type: 'vault',
      },
    }).catch((err: unknown) => {
      log.error(
        { err: String(err), field, requestId },
        'Bus publish error for vault.grant.requested',
      );
    });

    log.info(
      { field, requestId, granteeDid },
      'Vault Tier 1: static-secret grant request created, waiting for owner agent',
    );
    return { entry, grantId: null, requestId };
  }

  // ── Tier 0: the node is its own owner agent ────────────────────────────────

  // Durable owner copy before anything is superseded, so the erase below can never
  // remove the last recoverable copy of the current field key.
  await writeOwnerEnvelope({ field, keyId, fieldKey, ownerXPub: getOwnerXPublicKey() });

  // Supersede any existing active grant for this (principalDid, granteeDid, field) tuple.
  await supersedeGrants(
    and(
      eq(vaultDelegationGrants.subject, principalDid),
      eq(vaultDelegationGrants.grantedTo, granteeDid),
      eq(vaultDelegationGrants.field, field),
      eq(vaultDelegationGrants.status, 'active'),
    ),
  );

  // Wrap the field key to the node's X25519 pubkey using the owner X25519 private key.
  const wrapped = wrapFieldKey(fieldKey, nodeXPub, getOwnerXPrivateKey());

  const grantRaw = {
    subject: principalDid,
    grantedTo: granteeDid,
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

  const grantId = generateId('vdg');
  await db.insert(vaultDelegationGrants).values({
    id: grantId,
    ...grantRaw,
    ownerSignature,
    status: 'active',
    // The key material is wrapped to the node, which unseals on the grantee's
    // behalf, so the ECDH counterparty is the node pubkey. The signature is the
    // node's own (Tier 0 only — this path throws under Tier 1).
    recipientXPub: nodeXPub,
    ownerEdPub: identity.senderPubkey,
  });

  return { entry, grantId, requestId: null };
}

/**
 * Load a delegation-grant sealed vault entry and unseal it, resolving the
 * active grant by granteeDid rather than nodeDid.
 *
 * Used by the static-secret framework (#1439): the app DID (granteeDid) acts
 * as the grantee and the engine unseals on its behalf.
 *
 * Returns undefined when:
 *   - The vault field does not exist or has been deleted.
 *   - No active, non-expired delegation grant exists for (field, granteeDid).
 *
 * Throws VaultDelegationError when the grant's owner signature is invalid.
 * Throws VaultIntegrityError on any integrity or isolation violation.
 * No plaintext is logged at any point.
 */
export async function loadAndUnsealByGrantee(
  field: string,
  granteeDid: string,
): Promise<string | undefined> {
  const entry = await vaultService.get(field);
  if (!entry || entry.deleted) {
    return undefined;
  }

  const grant = await fetchActiveGrant(field, granteeDid);
  if (!grant) {
    return undefined;
  }

  return _applyDelegationGrant(entry, grant, getNodeXPrivateKey(), resolveGrantVerifier(entry, grant));
}

/**
 * Revoke the active delegation grant for (field, granteeDid).
 *
 * Sets status = 'revoked' and revokedAt = now on the active row.
 * Returns true when a grant was deactivated; false when no active grant existed.
 *
 * Does NOT delete the vault entry — the sealed ciphertext remains, but future
 * calls to loadAndUnsealByGrantee will return undefined (fail-closed).
 */
export async function revokeStaticSecretGrant(
  field: string,
  granteeDid: string,
): Promise<boolean> {
  const updated = await db
    .update(vaultDelegationGrants)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(vaultDelegationGrants.grantedTo, granteeDid),
        eq(vaultDelegationGrants.field, field),
        eq(vaultDelegationGrants.status, 'active'),
      ),
    )
    .returning({
      id: vaultDelegationGrants.id,
      field: vaultDelegationGrants.field,
      keyId: vaultDelegationGrants.keyId,
    });

  // Status alone would leave the wrapped key readable to anyone with nodeXPriv and
  // database access, so revocation would not actually withdraw anything.
  await eraseGrantKeyMaterial(updated);

  return updated.length > 0;
}

// ── Renewal (#1535) ──────────────────────────────────────────────────────

/**
 * Default lifetime applied to a grant when the caller does not specify one.
 *
 * Read from `VAULT_GRANT_TTL_DAYS`; **unset means grants do not expire**, which is
 * the current default on purpose.
 *
 * Expiry now destroys key material, so an expired grant locks the node out of the
 * field until someone re-issues. Until the owner agent renews automatically
 * (#1536), switching this on would mean every v2 secret becomes unreadable one TTL
 * after it is written, with nothing to recover it. Turn it on once renewal runs.
 */
export function defaultGrantExpiry(now: Date = new Date()): Date | null {
  const raw = process.env.VAULT_GRANT_TTL_DAYS;
  if (!raw) {
    return null;
  }

  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    log.warn(
      { value: raw },
      'Vault: ignoring invalid VAULT_GRANT_TTL_DAYS — grants will not expire',
    );
    return null;
  }

  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The Ed25519 key that a NEWLY issued grant's `ownerSignature` must verify
 * against — the external owner in Tier 1, this node in Tier 0.
 *
 * {@link resolveGrantVerifier} answers the same question for a grant that already
 * exists (and may carry a pin). This answers it for one being created, which is
 * what the grant endpoint needs before it has a row to consult.
 */
export function expectedGrantVerifier(entry: VaultEntry): string {
  return isVaultTier1() ? getExternalOwnerEdPublicKey() : entry.senderPubkey;
}

/** The owner envelope for (field, keyId), or undefined when none exists. */
export async function getOwnerEnvelope(
  field: string,
  keyId: string,
): Promise<VaultOwnerEnvelope | undefined> {
  const rows = await db
    .select()
    .from(vaultOwnerEnvelopes)
    .where(and(eq(vaultOwnerEnvelopes.field, field), eq(vaultOwnerEnvelopes.keyId, keyId)))
    .limit(1);
  return rows[0];
}

export interface RenewableGrant {
  field: string;
  keyId: string;
  /** 'missing' when no active grant exists at all; 'expiring' when one lapses soon. */
  reason: 'missing' | 'expiring';
  expiresAt: string | null;
  /** Envelope material — the owner opens this with ownerXPriv to recover the field key. */
  ownerXPub: string;
  senderXPub: string;
  wrappedKey: string;
  wrappedNonce: string;
  /**
   * Who the renewed grant must be issued to (#1603).
   *
   * The node's own DID for a self-grant, or a connector app DID for a
   * static-secret credential. Before this field existed the owner agent assumed
   * the node, so a static-secret grant would silently be renewed to the wrong
   * grantee — installing a grant nothing reads while the real one stays lapsed.
   */
  grantedTo: string;
}

/**
 * List the fields whose delegation grant needs issuing or re-issuing, together
 * with the envelope the owner needs to mint a replacement.
 *
 * Envelopes are the enumeration source rather than the vault file: one exists for
 * every v2 entry, and reading them avoids asserting integrity over every entry
 * just to build a worklist.
 *
 * Returning the envelope is safe. It is the field key wrapped to `ownerXPub`, so
 * only the holder of `ownerXPriv` can open it — the same reasoning that lets
 * `GET /api/vault/grants/pending` return `wrappedFieldKey`.
 *
 * ## Grantees (#1603)
 * A field is no longer necessarily granted to the node. The worklist is therefore
 * built per (field, grantee): the node itself, plus any other grantee that has
 * ever held a grant on that field — which is how a static-secret credential
 * (#1439) granted to a connector app DID becomes renewable at all. Scanning only
 * for `grantedTo = nodeDid` reported those fields as permanently fine while their
 * real grant lapsed, turning expiry into a silent lockout.
 */
export async function listRenewableGrants(options: {
  nodeDid: string;
  /** Treat a grant as needing renewal this far ahead of its expiry. */
  withinMs?: number;
  now?: Date;
}): Promise<RenewableGrant[]> {
  const now = options.now ?? new Date();
  const horizon = new Date(now.getTime() + (options.withinMs ?? 0));

  const envelopes = await db.select().from(vaultOwnerEnvelopes);
  const renewable: RenewableGrant[] = [];

  for (const envelope of envelopes) {
    // Every grantee this field has been granted to, in any state. A revoked or
    // superseded row still names a grantee whose access is meant to be renewable;
    // the node is always included so a never-granted field is still reported.
    const granteeRows = await db
      .selectDistinct({ grantedTo: vaultDelegationGrants.grantedTo })
      .from(vaultDelegationGrants)
      .where(eq(vaultDelegationGrants.field, envelope.field));

    const grantees = new Set<string>([options.nodeDid]);
    for (const row of granteeRows) {
      grantees.add(row.grantedTo);
    }

    for (const grantedTo of grantees) {
      const rows = await db
        .select({
          expiresAt: vaultDelegationGrants.expiresAt,
        })
        .from(vaultDelegationGrants)
        .where(
          and(
            eq(vaultDelegationGrants.grantedTo, grantedTo),
            eq(vaultDelegationGrants.field, envelope.field),
            eq(vaultDelegationGrants.keyId, envelope.keyId),
            eq(vaultDelegationGrants.status, 'active'),
          ),
        )
        .limit(1);

      const active = rows[0];
      const common = {
        field: envelope.field,
        keyId: envelope.keyId,
        ownerXPub: envelope.ownerXPub,
        senderXPub: envelope.senderXPub,
        wrappedKey: envelope.wrappedKey,
        wrappedNonce: envelope.wrappedNonce,
        grantedTo,
      };

      if (!active) {
        // Revoked, expired-and-swept, or never granted. Either way the grantee
        // cannot read this field until the owner issues a grant.
        renewable.push({ ...common, reason: 'missing', expiresAt: null });
        continue;
      }

      if (active.expiresAt !== null && active.expiresAt <= horizon) {
        renewable.push({
          ...common,
          reason: 'expiring',
          expiresAt: active.expiresAt.toISOString(),
        });
      }
    }
  }

  return renewable;
}

// ── Delegation helpers ───────────────────────────────────────────────────

/**
 * Decide which Ed25519 public key a grant's `ownerSignature` must verify against.
 *
 * Grants written from #1521 onward pin their expected verifier in `ownerEdPub`.
 * That pin is what stops Tier 1 being a one-way door: the verifier previously came
 * from a process-wide flag, so unsetting the Tier 1 env made every Tier-1-sealed
 * entry fail verification, and Tier-0 and Tier-1 grants could not coexist.
 *
 * A pin is only honoured when it matches a key we already trust — the node's own
 * key (self-grant) or the configured external owner key. Otherwise a tampered row
 * could nominate an attacker-controlled verifier and self-authorise.
 *
 * Rows predating the column fall back to the original process-wide rule.
 */
function resolveGrantVerifier(
  entry: VaultEntry,
  grant: Pick<VaultDelegationGrant, 'ownerEdPub' | 'field'>,
): string {
  const legacyVerifier = isVaultTier1() ? getExternalOwnerEdPublicKey() : entry.senderPubkey;

  const pinned = grant.ownerEdPub;
  if (!pinned) {
    return legacyVerifier;
  }

  const trusted = new Set<string>([entry.senderPubkey]);
  if (isVaultTier1()) {
    trusted.add(getExternalOwnerEdPublicKey());
  }

  if (!trusted.has(pinned)) {
    throw new VaultDelegationError(
      `vault: grant for field '${grant.field}' pins an untrusted owner key — refusing to verify against it`,
      { field: grant.field, nodeDid: entry.senderDid },
    );
  }

  return pinned;
}

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

// ── Batch v1→v2 custody migration (#1537) ───────────────────────────
// Trailing, deliberately isolated: migrate-custody.ts owns this export. Do not
// add other logic below this line — see the #1537 child-agent boundary notes.
export * from './migrate-custody';

// ── #1521 — field status (connector v2 custody adoption) ──────────────────────
// Trailing re-export only; see ./field-status.ts for the implementation.
export {
  vaultFieldStatus,
  vaultFieldStatusForGrantee,
  type VaultFieldStatus,
} from './field-status';
