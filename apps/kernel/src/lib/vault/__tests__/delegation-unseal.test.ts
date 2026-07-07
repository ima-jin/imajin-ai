/**
 * Tests for the vault v2 delegation-grant unseal path (#1242).
 *
 * The _applyDelegationGrant helper encapsulates the full crypto path —
 * signature verification, entry integrity, field key unwrap, AES decrypt —
 * without requiring a live database.  All test scenarios are exercised here;
 * the DB-calling loadAndUnseal wrapper is covered by integration tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// Mock kernel-level modules so index.ts loads cleanly in the test environment.
// _applyDelegationGrant and canonicalizeGrantPayload do not use the DB or ID
// generator; the live loadAndUnseal / sealAndStoreV2 wrappers are covered by
// integration tests.
vi.mock('@/src/db', () => ({ db: {}, vaultDelegationGrants: {} }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));
import {
    FileVaultRepository,
    VaultEntryService,
    InMemoryFieldLock,
    createDefaultAdapters,
    sealSecret,
    computeVaultCid,
    deriveKeyId,
    signVaultPayload,
    assertEntryIntegrity,
    wrapFieldKey,
    deriveXKeypairFromEd25519,
    VAULT_ENTRY_VERSION_V2,
    type VaultEntryV2,
} from '@imajin/vault-core';
import { crypto as authCrypto } from '@imajin/auth';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _applyDelegationGrant, canonicalizeGrantPayload } from '../index.js';
import { VaultDelegationError } from '../errors.js';

// ── Key / keypair helpers ────────────────────────────────────────────────────

function makeOwnerKeypair(): {
    edPriv: string;         // Ed25519 private key (hex)
    edPub: string;          // Ed25519 public key (hex)
    xPriv: string;          // X25519 private key (hex)
    xPub: string;           // X25519 public key (hex)
    did: string;            // did:imajin:…
} {
    const edPriv = randomBytes(32).toString('hex');
    const edPub = authCrypto.getPublicKey(edPriv);
    const did = `did:imajin:${edPub.slice(0, 16)}`;
    const { privateKey: xPriv, publicKey: xPub } = deriveXKeypairFromEd25519(
        edPriv,
        'vault-owner-x25519-v1',
    );
    return { edPriv, edPub, did, xPriv, xPub };
}

function makeNodeKeypair(): {
    xPriv: string;
    xPub: string;
    did: string;
} {
    const edPriv = randomBytes(32).toString('hex');
    const edPub = authCrypto.getPublicKey(edPriv);
    const did = `did:imajin:${edPub.slice(0, 16)}`;
    const { privateKey: xPriv, publicKey: xPub } = deriveXKeypairFromEd25519(
        edPriv,
        'vault-node-x25519-v1',
    );
    return { xPriv, xPub, did };
}

// ── VaultEntryV2 builder ────────────────────────────────────────────────────

const adapters = createDefaultAdapters();

async function buildV2Entry(params: {
    field: string;
    plaintext: string;
    fieldKey: Buffer;
    owner: ReturnType<typeof makeOwnerKeypair>;
}): Promise<VaultEntryV2> {
    const { field, plaintext, fieldKey, owner } = params;

    const blob = sealSecret(plaintext, fieldKey);
    const cid = await computeVaultCid(blob);
    const keyId = deriveKeyId(owner.edPub);
    const timestamp = new Date().toISOString();

    const payload = {
        version: VAULT_ENTRY_VERSION_V2 as typeof VAULT_ENTRY_VERSION_V2,
        field,
        cid,
        encrypted: blob.encrypted,
        nonce: blob.nonce,
        senderDid: owner.did,
        senderPubkey: owner.edPub,
        keyId,
        timestamp,
        custodyScheme: 'delegation-grant' as const,
    };

    const signature = signVaultPayload(payload, owner.edPriv);
    const entry: VaultEntryV2 = { ...payload, signature };
    await assertEntryIntegrity(entry, adapters);
    return entry;
}

// ── Grant builder ────────────────────────────────────────────────────────────

function buildGrant(params: {
    owner: ReturnType<typeof makeOwnerKeypair>;
    nodeDid: string;
    nodeXPub: string;
    field: string;
    keyId: string;
    fieldKey: Buffer;
    expiresAt?: Date | null;
}) {
    const { owner, nodeDid, nodeXPub, field, keyId, fieldKey, expiresAt = null } = params;

    const wrapped = wrapFieldKey(fieldKey, nodeXPub, owner.xPriv);

    const raw = {
        subject: owner.did,
        grantedTo: nodeDid,
        field,
        ownerXPub: owner.xPub,
        wrappedKey: wrapped.encryptedKey,
        wrappedNonce: wrapped.nonce,
        keyId,
        expiresAt,
    };

    const ownerSignature = authCrypto.signSync(canonicalizeGrantPayload(raw), owner.edPriv);
    return { ...raw, ownerSignature };
}

// ── Persistence helper (for store-and-retrieve tests) ───────────────────────

function makeTempService() {
    const vaultPath = join(tmpdir(), `vault-v2-test-${Date.now()}-${randomBytes(4).toString('hex')}.json`);
    const repo = new FileVaultRepository({ vaultPath });
    const lock = new InMemoryFieldLock();
    return new VaultEntryService(repo, { lock, adapters });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('_applyDelegationGrant', () => {
    it('decrypts plaintext when entry and grant are valid', async () => {
        const owner = makeOwnerKeypair();
        const node = makeNodeKeypair();
        const fieldKey = randomBytes(32);
        const plaintext = 'super-secret-api-key';
        const field = 'API_KEY';

        const entry = await buildV2Entry({ field, plaintext, fieldKey, owner });
        const keyId = deriveKeyId(owner.edPub);
        const grant = buildGrant({ owner, nodeDid: node.did, nodeXPub: node.xPub, field, keyId, fieldKey });

        const result = await _applyDelegationGrant(entry, grant, node.xPriv);
        expect(result).toBe(plaintext);
    });

    it('decrypts correctly for an entry stored via VaultEntryService', async () => {
        const owner = makeOwnerKeypair();
        const node = makeNodeKeypair();
        const fieldKey = randomBytes(32);
        const plaintext = 'stored-secret';
        const field = 'STORED';

        const entry = await buildV2Entry({ field, plaintext, fieldKey, owner });
        const service = makeTempService();
        await service.set(entry);

        const loaded = await service.get(field);
        expect(loaded).not.toBeUndefined();

        const keyId = deriveKeyId(owner.edPub);
        const grant = buildGrant({ owner, nodeDid: node.did, nodeXPub: node.xPub, field, keyId, fieldKey });

        const result = await _applyDelegationGrant(loaded!, grant, node.xPriv);
        expect(result).toBe(plaintext);
    });

    it('throws VaultDelegationError when grant signature is invalid', async () => {
        const owner = makeOwnerKeypair();
        const node = makeNodeKeypair();
        const fieldKey = randomBytes(32);
        const field = 'TOKEN';

        const entry = await buildV2Entry({ field, plaintext: 'secret', fieldKey, owner });
        const keyId = deriveKeyId(owner.edPub);
        const grant = buildGrant({ owner, nodeDid: node.did, nodeXPub: node.xPub, field, keyId, fieldKey });

        const tampered = { ...grant, ownerSignature: 'a'.repeat(128) };

        await expect(
            _applyDelegationGrant(entry, tampered, node.xPriv),
        ).rejects.toBeInstanceOf(VaultDelegationError);
    });

    it('throws when node uses the wrong X25519 private key', async () => {
        const owner = makeOwnerKeypair();
        const node = makeNodeKeypair();
        const wrongNode = makeNodeKeypair();
        const fieldKey = randomBytes(32);
        const field = 'TOKEN';

        const entry = await buildV2Entry({ field, plaintext: 'secret', fieldKey, owner });
        const keyId = deriveKeyId(owner.edPub);
        // Grant was issued to `node`, but we try to unseal with `wrongNode.xPriv`
        const grant = buildGrant({ owner, nodeDid: node.did, nodeXPub: node.xPub, field, keyId, fieldKey });

        await expect(
            _applyDelegationGrant(entry, grant, wrongNode.xPriv),
        ).rejects.toThrow();
    });

    it('throws VaultIntegrityError when the vault entry is tampered', async () => {
        const owner = makeOwnerKeypair();
        const node = makeNodeKeypair();
        const fieldKey = randomBytes(32);
        const field = 'TOKEN';

        const entry = await buildV2Entry({ field, plaintext: 'secret', fieldKey, owner });
        const keyId = deriveKeyId(owner.edPub);
        const grant = buildGrant({ owner, nodeDid: node.did, nodeXPub: node.xPub, field, keyId, fieldKey });

        // Tamper with the entry CID
        const tampered = { ...entry, cid: 'cid:tampered' };

        await expect(
            _applyDelegationGrant(tampered, grant, node.xPriv),
        ).rejects.toThrow();
    });

    it('rejects a grant whose ownerSignature was signed by a different key', async () => {
        const owner = makeOwnerKeypair();
        const attacker = makeOwnerKeypair();
        const node = makeNodeKeypair();
        const fieldKey = randomBytes(32);
        const field = 'TOKEN';

        const entry = await buildV2Entry({ field, plaintext: 'secret', fieldKey, owner });
        const keyId = deriveKeyId(owner.edPub);
        const grant = buildGrant({ owner, nodeDid: node.did, nodeXPub: node.xPub, field, keyId, fieldKey });

        // Replace the signature with one from a different key (attacker cannot forge)
        const forgedSig = authCrypto.signSync(canonicalizeGrantPayload(grant), attacker.edPriv);
        const forgedGrant = { ...grant, ownerSignature: forgedSig };

        // entry.senderPubkey is owner's pubkey — forged sig from attacker fails
        await expect(
            _applyDelegationGrant(entry, forgedGrant, node.xPriv),
        ).rejects.toBeInstanceOf(VaultDelegationError);
    });
});

// ── canonicalizeGrantPayload ───────────────────────────────────────────────────

describe('canonicalizeGrantPayload', () => {
    const base = {
        subject: 'did:imajin:abc',
        grantedTo: 'did:imajin:def',
        field: 'GH_TOKEN',
        ownerXPub: 'a'.repeat(64),
        wrappedKey: 'AAAA',
        wrappedNonce: 'BBBB',
        keyId: 'kid:abc',
        expiresAt: null,
    };

    it('produces deterministic JSON with alphabetically sorted keys', () => {
        const a = canonicalizeGrantPayload(base);
        const b = canonicalizeGrantPayload({ ...base });
        expect(a).toBe(b);
    });

    it('serialises expiresAt as ISO string when present', () => {
        const d = new Date('2030-01-01T00:00:00.000Z');
        const result = canonicalizeGrantPayload({ ...base, expiresAt: d });
        expect(result).toContain('"expiresAt":"2030-01-01T00:00:00.000Z"');
    });

    it('serialises null expiresAt as null', () => {
        const result = canonicalizeGrantPayload({ ...base, expiresAt: null });
        expect(result).toContain('"expiresAt":null');
    });

    it('produces different strings when any field changes', () => {
        const original = canonicalizeGrantPayload(base);
        expect(canonicalizeGrantPayload({ ...base, field: 'OTHER' })).not.toBe(original);
        expect(canonicalizeGrantPayload({ ...base, wrappedKey: 'CCCC' })).not.toBe(original);
        expect(canonicalizeGrantPayload({ ...base, grantedTo: 'did:imajin:zzz' })).not.toBe(original);
    });
});
