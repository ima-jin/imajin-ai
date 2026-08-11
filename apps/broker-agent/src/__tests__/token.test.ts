/**
 * Regression test for mintAppToken's proof-of-possession signature (#1800).
 *
 * The kernel's POST /auth/api/apps/token/service verifies the PoP signature
 * with the raw Ed25519 primitive (`ed.verifyAsync(signature, message,
 * publicKey)` over `${appDid}:${nonce}:${timestamp}`). mintAppToken must
 * produce a signature that verifies against that exact message with the
 * matching raw primitive — not a `SignedMessage` envelope, which carries the
 * challenge as `payload` inside a canonicalized JSON blob instead.
 */
import { describe, it, expect } from 'vitest';
import { generateKeypair, crypto } from '@imajin/auth';
import { mintAppToken } from '../token';

const APP_DID = 'did:imajin:broker-agent';

describe('mintAppToken (#1800)', () => {
  it('signs the raw challenge string with the primitive the kernel verifies against', async () => {
    const keypair = generateKeypair();
    let capturedBody: Record<string, unknown> | null = null;

    const originalFetch = global.fetch;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ token: 'signed.jwt', expiresIn: 600, scopes: ['supply:read'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    try {
      await mintAppToken('https://kernel.test', APP_DID, keypair.privateKey);
    } finally {
      global.fetch = originalFetch;
    }

    expect(capturedBody).not.toBeNull();
    const { appDid, nonce, timestamp, signature } = capturedBody as {
      appDid: string;
      nonce: string;
      timestamp: string;
      signature: string;
    };

    expect(appDid).toBe(APP_DID);
    expect(typeof signature).toBe('string'); // not a SignedMessage envelope object

    const challenge = `${appDid}:${nonce}:${timestamp}`;
    const valid = await crypto.verify(signature, challenge, keypair.publicKey);
    expect(valid).toBe(true);
  });
});
