import { describe, it, expect, vi } from 'vitest';
import { IntegrityErrorCode } from '../src/errors.js';
import { VAULT_ENTRY_VERSION_V1, type VaultEntry } from '../src/models.js';
import { assertEntryIntegrity, verifyEntryIntegrity, type VaultIntegrityAdapters } from '../src/verification.js';

const createAdapters = (): VaultIntegrityAdapters => ({
    computeCid: vi.fn(async ({ encrypted, nonce }) => `cid:${encrypted}:${nonce}`),
    deriveKeyId: vi.fn((senderPubkey: string) => `kid:${senderPubkey}`),
    verifyDidKeyBinding: vi.fn((_did: string, _senderPubkey: string) => true),
    verifySignature: vi.fn((_payload, _signature: string, _senderPubkey: string) => true)
});

const createEntry = (overrides: Partial<VaultEntry> = {}): VaultEntry => ({
    version: VAULT_ENTRY_VERSION_V1,
    field: 'GH_TOKEN',
    cid: 'cid:enc-value:nonce-value',
    encrypted: 'enc-value',
    nonce: 'nonce-value',
    senderDid: 'did:key:zsender',
    senderPubkey: 'sender-pubkey',
    keyId: 'kid:sender-pubkey',
    signature: 'signature-value',
    timestamp: '2026-05-20T22:00:00.000Z',
    ...overrides
});

describe('vault-core verifyEntryIntegrity', () => {
    it('returns payload for a valid entry', async () => {
        const adapters = createAdapters();
        const entry = createEntry();

        const result = await verifyEntryIntegrity(entry, adapters);

        expect(result.ok).toBe(true);
    });

    it('returns CID_MISMATCH when CID check fails', async () => {
        const adapters = createAdapters();
        const entry = createEntry({
            cid: 'cid:unexpected'
        });

        const result = await verifyEntryIntegrity(entry, adapters);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe(IntegrityErrorCode.CID_MISMATCH);
        }
    });

    it('throws KEY_ID_MISMATCH from assertEntryIntegrity', async () => {
        const adapters = createAdapters();
        const entry = createEntry({
            keyId: 'kid:wrong'
        });

        await expect(assertEntryIntegrity(entry, adapters)).rejects.toMatchObject({
            code: IntegrityErrorCode.KEY_ID_MISMATCH
        });
    });

    it('returns DID_KEY_BINDING_INVALID when DID binding check fails', async () => {
        const adapters = createAdapters();
        vi.mocked(adapters.verifyDidKeyBinding).mockReturnValue(false);
        const entry = createEntry();

        const result = await verifyEntryIntegrity(entry, adapters);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe(IntegrityErrorCode.DID_KEY_BINDING_INVALID);
        }
    });

    it('returns SIGNATURE_INVALID when signature verification fails', async () => {
        const adapters = createAdapters();
        vi.mocked(adapters.verifySignature).mockReturnValue(false);
        const entry = createEntry();

        const result = await verifyEntryIntegrity(entry, adapters);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe(IntegrityErrorCode.SIGNATURE_INVALID);
        }
    });
});
