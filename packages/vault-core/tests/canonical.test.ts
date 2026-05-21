import { describe, it, expect } from 'vitest';
import { canonicalizePayload } from '../src/canonical.js';
import { VAULT_ENTRY_VERSION_V1, type VaultSignedPayload } from '../src/models.js';

const basePayload: VaultSignedPayload = {
    version: VAULT_ENTRY_VERSION_V1,
    field: 'test',
    cid: 'cid-1',
    encrypted: 'enc',
    nonce: 'nonce',
    senderDid: 'did:imajin:abc',
    senderPubkey: 'pubkey',
    keyId: 'kid',
    timestamp: '2026-05-20T22:00:00.000Z'
};

describe('canonicalizePayload', () => {
    it('produces deterministic output for identical payloads', () => {
        const a = canonicalizePayload(basePayload);
        const b = canonicalizePayload(basePayload);
        expect(a).toBe(b);
    });

    it('orders keys alphabetically regardless of object key order', () => {
        const reordered: VaultSignedPayload = {
            timestamp: '2026-05-20T22:00:00.000Z',
            keyId: 'kid',
            senderPubkey: 'pubkey',
            senderDid: 'did:imajin:abc',
            nonce: 'nonce',
            encrypted: 'enc',
            cid: 'cid-1',
            field: 'test',
            version: VAULT_ENTRY_VERSION_V1
        };
        expect(canonicalizePayload(reordered)).toBe(canonicalizePayload(basePayload));
    });

    it('includes optional fields when present', () => {
        const withOptional: VaultSignedPayload = {
            ...basePayload,
            previousCid: 'cid-0',
            deleted: true
        };
        const result = canonicalizePayload(withOptional);
        expect(result).toContain('previousCid');
        expect(result).toContain('deleted');
    });

    it('excludes undefined optional fields from canonical form', () => {
        const withoutOptional: VaultSignedPayload = {
            ...basePayload,
            previousCid: undefined
        };
        const result = canonicalizePayload(withoutOptional);
        expect(result).not.toContain('previousCid');
    });
});
