import { describe, it, expect } from 'vitest';
import { computeVaultCid, verifyVaultCid } from '../src/cid.js';

describe('computeVaultCid', () => {
    it('returns a string CID', async () => {
        const cid = await computeVaultCid({ encrypted: 'hello', nonce: 'world' });
        expect(typeof cid).toBe('string');
        expect(cid.length).toBeGreaterThan(0);
    });

    it('produces the same CID for identical blobs', async () => {
        const blob = { encrypted: 'a', nonce: 'b' };
        const cid1 = await computeVaultCid(blob);
        const cid2 = await computeVaultCid(blob);
        expect(cid1).toBe(cid2);
    });

    it('produces different CIDs for different blobs', async () => {
        const cid1 = await computeVaultCid({ encrypted: 'a', nonce: 'b' });
        const cid2 = await computeVaultCid({ encrypted: 'a', nonce: 'c' });
        expect(cid1).not.toBe(cid2);
    });
});

describe('verifyVaultCid', () => {
    it('returns true for a matching CID', async () => {
        const blob = { encrypted: 'test', nonce: 'nonce' };
        const cid = await computeVaultCid(blob);
        expect(await verifyVaultCid(blob, cid)).toBe(true);
    });

    it('returns false for a mismatched CID', async () => {
        const blob = { encrypted: 'test', nonce: 'nonce' };
        expect(await verifyVaultCid(blob, 'wrong-cid')).toBe(false);
    });
});
