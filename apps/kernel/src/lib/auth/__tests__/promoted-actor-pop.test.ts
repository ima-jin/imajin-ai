/**
 * End-to-end proof for #1735: once an authorized developer app is promoted
 * into an actor identity, the stored public_key must (a) match the key
 * encoded in its own DID, and (b) actually verify a proof-of-possession
 * signature made with the app's real private key — the exact check
 * `/auth/api/apps/token` performs. This exercises the REAL crypto module (no
 * mocks) so a regression back to the `agent_<appId>` sentinel fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { generateKeypair, crypto as authCrypto } from '@imajin/auth';
import { didFromPublicKey, publicKeyFromDid, verifySignature } from '../crypto';
import { buildAgentActorRow } from '../agent-actor';

describe('promoted actor public_key ↔ DID ↔ PoP signature (#1735)', () => {
  it('stores a public_key that decodes exactly from its own DID', () => {
    const { publicKey } = generateKeypair();
    const appDid = didFromPublicKey(publicKey);

    const row = buildAgentActorRow({
      appId: 'app_4MbCYrndTWiJjMPe',
      appDid,
      publicKey,
      ownerDid: 'did:imajin:agrifortress',
    });

    expect(row.publicKey).toBe(publicKey);
    expect(publicKeyFromDid(row.id)).toBe(publicKey);
  });

  it('lets the app mint a PoP token: signature verifies against the stored public_key', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const appDid = didFromPublicKey(publicKey);

    const row = buildAgentActorRow({
      appId: 'app_4MbCYrndTWiJjMPe',
      appDid,
      publicKey,
      ownerDid: 'did:imajin:agrifortress',
    });

    // Mirrors the /auth/api/apps/token challenge shape.
    const challenge = `${appDid}:att_test:nonce1234567890:2026-01-01T00:00:00.000Z`;
    const signature = authCrypto.signSync(challenge, privateKey);

    await expect(verifySignature(challenge, signature, row.publicKey)).resolves.toBe(true);
  });

  it('regression: a sentinel-style label would NEVER verify (the pre-#1735 bug)', async () => {
    const sentinel = 'agent_app_4MbCYrndTWiJjMPe';
    const challenge = 'did:imajin:whatever:att_test:nonce1234567890:2026-01-01T00:00:00.000Z';
    const bogusSignature = '00'.repeat(64);
    await expect(verifySignature(challenge, bogusSignature, sentinel)).resolves.toBe(false);
  });
});
