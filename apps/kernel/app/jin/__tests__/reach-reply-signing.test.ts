// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { reachReplyEvent } from '@/src/lib/auth/reach-reply-wire';
import { signReachReply } from '../reach-reply-signing';

const privateKey = '13'.repeat(32);
const publicKey = authCrypto.getPublicKey(privateKey);
const event = reachReplyEvent({
  reachId: 'reach_1', principalDid: 'did:imajin:principal',
  requesterDid: 'did:imajin:requester', transcriptHash: 'c'.repeat(64),
}, 'Reply 🌍', '2026-10-17T00:00:00.000Z');

afterEach(() => localStorage.clear());

describe('signReachReply', () => {
  it.each([privateKey, `302e020100300506032b657004220420${privateKey}`])('signs raw and PKCS8 keys with a valid Ed25519 signature', async key => {
    localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey: key, publicKey }));
    localStorage.setItem('imajin_did', event.issuer);
    const signature = await signReachReply(event);
    expect(signature).toMatchObject({ keyId: publicKey, alg: 'ed25519' });
    expect(authCrypto.verifySync(signature.sig, canonicalize(event), publicKey)).toBe(true);
  });

  it.each([
    null, 'not json', 'null', '1', '{}',
    JSON.stringify({ privateKey: 'not hex', publicKey }),
    JSON.stringify({ privateKey, publicKey: 'f'.repeat(64) }),
    JSON.stringify({ privateKey, publicKey: 'not hex' }),
  ])('rejects missing, malformed, and mismatched keys', async stored => {
    if (stored !== null) localStorage.setItem('imajin_keypair', stored);
    await expect(signReachReply(event)).rejects.toThrow(/browser signing key/);
  });

  it('does not confuse a cached DID alias with the server-authorized principal', async () => {
    localStorage.setItem('imajin_keypair', JSON.stringify({ privateKey, publicKey }));
    localStorage.setItem('imajin_did', 'did:imajin:cached-alias');
    const signature = await signReachReply(event);
    expect(authCrypto.verifySync(signature.sig, canonicalize(event), publicKey)).toBe(true);
  });
});
