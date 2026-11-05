import { describe, expect, it } from 'vitest';
import { createJwt, createNewEd25519Keypair, signPayloadEd25519 } from '@metalabel/dfos-protocol/crypto';
import { verifyAuthToken } from '../legacy-auth-token';

const pair = createNewEd25519Keypair();
const now = Math.floor(Date.now() / 1000);
const did = 'did:dfos:peer';

async function token(claims = {}, kid: string | undefined = `${did}#key`, signingPair = pair) {
  return createJwt({
    header: { alg: 'EdDSA', typ: 'JWT', ...(kid ? { kid } : {}) },
    payload: { iss: did, sub: did, aud: 'relay', iat: now - 1, exp: now + 60, ...claims },
    sign: async (message) => signPayloadEd25519(message, signingPair.privateKey),
  });
}

describe('legacy #2132 auth-token compatibility', () => {
  it('accepts an authentic audience-bound token', async () => {
    const proof = await token();
    expect(verifyAuthToken({ token: proof, publicKey: pair.publicKey, audience: 'relay', currentTime: now }).iss).toBe(did);
  });

  it.each([
    { aud: 'other' }, { exp: now }, { iat: now + 1 }, { iat: -1 }, { sub: undefined },
    { iss: 'did:dfos:other' }, { exp: '9999999999' },
  ])('rejects invalid legacy claims %j', async (claims) => {
    const proof = await token(claims);
    expect(() => verifyAuthToken({ token: proof, publicKey: pair.publicKey, audience: 'relay', currentTime: now })).toThrow();
  });

  it.each(['key-only', 'did:dfos:other#key', ''])('rejects a missing or mismatched DID URL %s', async (kid) => {
    const proof = await token({}, kid);
    expect(() => verifyAuthToken({ token: proof, publicKey: pair.publicKey, audience: 'relay' })).toThrow();
  });

  it('rejects a signature from a different key', async () => {
    const proof = await token({}, `${did}#key`, createNewEd25519Keypair());
    expect(() => verifyAuthToken({ token: proof, publicKey: pair.publicKey, audience: 'relay' })).toThrow();
  });
});
