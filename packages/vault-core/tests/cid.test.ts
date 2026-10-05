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

describe('vault CID helpers keep their Promise contract', () => {
    it('computeVaultCid rejects (rather than throwing synchronously) for a missing blob', async () => {
        const bad = undefined as unknown as { encrypted: string; nonce: string };
        let pending: Promise<string> | undefined;
        expect(() => { pending = computeVaultCid(bad); }).not.toThrow();
        await expect(pending).rejects.toThrow();
    });

    it('verifyVaultCid rejects (rather than throwing synchronously) for a missing blob', async () => {
        const bad = undefined as unknown as { encrypted: string; nonce: string };
        let pending: Promise<boolean> | undefined;
        expect(() => { pending = verifyVaultCid(bad, 'cid'); }).not.toThrow();
        await expect(pending).rejects.toThrow();
    });
});
