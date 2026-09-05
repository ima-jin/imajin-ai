import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';

vi.mock('../node-identity', () => ({
  getNodeDid: vi.fn(async () => 'did:imajin:testnode'),
}));

import { mintCorpusAccessClaim, corpusAccessClaimHeader } from '../corpus-access-claim';

const ORIGINAL_AUTH_PRIVATE_KEY = process.env.AUTH_PRIVATE_KEY;
const KEYPAIR = authCrypto.generateKeypair();

function decode(claimAndSig: string) {
  const separatorIndex = claimAndSig.lastIndexOf('.');
  const encodedClaim = claimAndSig.slice(0, separatorIndex);
  const signature = claimAndSig.slice(separatorIndex + 1);
  return { encodedClaim, signature, claim: JSON.parse(Buffer.from(encodedClaim, 'base64url').toString('utf8')) };
}

beforeEach(() => {
  process.env.AUTH_PRIVATE_KEY = KEYPAIR.privateKey;
});

afterEach(() => {
  if (ORIGINAL_AUTH_PRIVATE_KEY === undefined) delete process.env.AUTH_PRIVATE_KEY;
  else process.env.AUTH_PRIVATE_KEY = ORIGINAL_AUTH_PRIVATE_KEY;
});

describe('mintCorpusAccessClaim', () => {
  it('mints a claim whose sub (did), scope, and audience match the request', async () => {
    const token = await mintCorpusAccessClaim('did:imajin:alice', 'corpus:read');
    const { claim } = decode(token);

    expect(claim).toMatchObject({
      did: 'did:imajin:alice',
      scope: 'corpus:read',
      aud: 'corpus',
      alg: 'Ed25519',
      issuerDid: 'did:imajin:testnode',
    });
    expect(typeof claim.nonce).toBe('string');
    expect(claim.nonce.length).toBeGreaterThan(0);
  });

  it('signs over the encoded claim such that it verifies against the derived public key', async () => {
    const token = await mintCorpusAccessClaim('did:imajin:alice', 'corpus:write');
    const { encodedClaim, signature } = decode(token);

    expect(authCrypto.verifySync(signature, encodedClaim, KEYPAIR.publicKey)).toBe(true);
  });

  it('mints a short-lived claim (expiresAt shortly after issuedAt, well under 5 minutes)', async () => {
    const token = await mintCorpusAccessClaim('did:imajin:alice', 'corpus:read');
    const { claim } = decode(token);

    const ttl = claim.expiresAt - claim.issuedAt;
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
  });

  it('throws when AUTH_PRIVATE_KEY is not configured', async () => {
    delete process.env.AUTH_PRIVATE_KEY;
    await expect(mintCorpusAccessClaim('did:imajin:alice', 'corpus:read')).rejects.toThrow(/AUTH_PRIVATE_KEY/);
  });
});

describe('corpusAccessClaimHeader', () => {
  it('prefixes the claim with the Imajin-Claim scheme', async () => {
    const header = await corpusAccessClaimHeader('did:imajin:alice', 'corpus:read');
    expect(header.startsWith('Imajin-Claim ')).toBe(true);

    const { claim } = decode(header.slice('Imajin-Claim '.length));
    expect(claim.did).toBe('did:imajin:alice');
  });
});
