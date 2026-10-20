import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { crypto } from '@imajin/auth';
import { verifyDocumentFile } from '../verify-document';
import { buildDocumentSigningPayload } from '../document-signing-payload';

const org = 'did:imajin:org';
const counterparty = 'did:imajin:buyer';
const bytes = new TextEncoder().encode('The exact agreement.\n');
const hash = createHash('sha256').update(bytes).digest('hex');
let privateKey: string;

function proof() {
  return { issuerDid: org, documentHash: hash, totalSigners: 2, revokedAt: null as Date | null };
}
function signatures() {
  return [org, counterparty].map((signerDid) => ({
    signerDid,
    status: 'signed',
    jws: crypto.signSync(buildDocumentSigningPayload(signerDid, hash), privateKey),
  }));
}
const keys = new Map([[org, crypto.generateKeypair().publicKey], [counterparty, crypto.generateKeypair().publicKey]]);

beforeEach(() => {
  privateKey = crypto.generatePrivateKey();
  vi.stubEnv('AUTH_PRIVATE_KEY', privateKey);
});
afterEach(() => vi.unstubAllEnvs());

describe('agreement file verification', () => {
  it('verifies identical bytes and both valid node-witness signatures', async () => {
    expect(await verifyDocumentFile(bytes, proof(), signatures(), keys)).toEqual({
      valid: true, hashMatches: true, signaturesValid: true, revoked: false,
    });
  });

  it('fails plainly for a one-byte modification while preserving signature evidence', async () => {
    const changed = bytes.slice();
    changed[0] ^= 1;
    expect(await verifyDocumentFile(changed, proof(), signatures(), keys)).toEqual({
      valid: false, hashMatches: false, signaturesValid: true, revoked: false,
    });
  });

  it('fails when a signature signed a different hash', async () => {
    const sigs = signatures();
    sigs[1].jws = crypto.signSync(buildDocumentSigningPayload(counterparty, 'another-hash'), privateKey);
    expect((await verifyDocumentFile(bytes, proof(), sigs, keys)).signaturesValid).toBe(false);
  });

  it('fails for a signature produced for somebody else', async () => {
    const sigs = signatures();
    sigs[1].jws = sigs[0].jws;
    expect((await verifyDocumentFile(bytes, proof(), sigs, keys)).valid).toBe(false);
  });

  it('fails when a signature is corrupted', async () => {
    const sigs = signatures();
    sigs[1].jws = 'invalid-signature';
    expect((await verifyDocumentFile(bytes, proof(), sigs, keys)).valid).toBe(false);
  });

  it.each(['pending', 'declined'])('fails when a signer is %s', async (status) => {
    const sigs = signatures();
    sigs[1].status = status;
    expect((await verifyDocumentFile(bytes, proof(), sigs, keys)).valid).toBe(false);
  });

  it('does not accept duplicate, missing or unexpected signer counts', async () => {
    const sigs = signatures();
    for (const rows of [[sigs[0], sigs[0]], [sigs[0]], [...sigs, sigs[1]]]) {
      expect((await verifyDocumentFile(bytes, proof(), rows, keys)).valid).toBe(false);
    }
  });

  it('requires the author among the signatures', async () => {
    expect((await verifyDocumentFile(bytes, { ...proof(), issuerDid: 'did:imajin:other' }, signatures(), keys)).valid).toBe(false);
  });

  it('fails with absent public key, token or document hash', async () => {
    expect((await verifyDocumentFile(bytes, proof(), signatures(), new Map())).valid).toBe(false);
    expect((await verifyDocumentFile(bytes, proof(), [{ ...signatures()[0], jws: null }, signatures()[1]], keys)).valid).toBe(false);
    expect((await verifyDocumentFile(bytes, { ...proof(), documentHash: null }, signatures(), keys)).valid).toBe(false);
  });

  it('retains proof but reports a revoked agreement as invalid', async () => {
    expect(await verifyDocumentFile(bytes, { ...proof(), revokedAt: new Date() }, signatures(), keys)).toEqual({
      valid: false, hashMatches: true, signaturesValid: true, revoked: true,
    });
  });

  it('fails closed if node witness key is unavailable', async () => {
    const sigs = signatures();
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await verifyDocumentFile(bytes, proof(), sigs, keys)).valid).toBe(false);
  });
});
