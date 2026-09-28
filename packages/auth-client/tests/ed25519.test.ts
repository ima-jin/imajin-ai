/**
 * Tests for `@ima-jin/auth-client`'s bootstrap Ed25519 primitives (#2411).
 */
import { describe, it, expect } from 'vitest';
import { generateBootstrapKeypair, signBootstrapPayload, canonicalizeBootstrapFetchPayload } from '../src/ed25519';

describe('generateBootstrapKeypair', () => {
  it('generates a fresh 64-hex-char keypair each call', () => {
    const a = generateBootstrapKeypair();
    const b = generateBootstrapKeypair();

    expect(a.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe('signBootstrapPayload', () => {
  it('produces a verifiable 128-hex-char signature', async () => {
    const { publicKey, privateKey } = generateBootstrapKeypair();
    const message = canonicalizeBootstrapFetchPayload({ appDid: 'did:imajin:app', nonce: 'n1', timestamp: 1000 });

    const signature = signBootstrapPayload(message, privateKey);

    expect(signature).toMatch(/^[0-9a-f]{128}$/);

    const ed25519 = await import('@noble/ed25519');
    const valid = ed25519.verify(
      Uint8Array.from(Buffer.from(signature, 'hex')),
      Uint8Array.from(Buffer.from(message, 'utf8')),
      Uint8Array.from(Buffer.from(publicKey, 'hex')),
    );
    expect(valid).toBe(true);
  });

  it('produces a DIFFERENT signature for a different message', () => {
    const { privateKey } = generateBootstrapKeypair();
    const messageA = canonicalizeBootstrapFetchPayload({ appDid: 'did:imajin:app', nonce: 'n1', timestamp: 1000 });
    const messageB = canonicalizeBootstrapFetchPayload({ appDid: 'did:imajin:app', nonce: 'n2', timestamp: 1000 });

    expect(signBootstrapPayload(messageA, privateKey)).not.toBe(signBootstrapPayload(messageB, privateKey));
  });
});

describe('canonicalizeBootstrapFetchPayload', () => {
  it('produces a deterministic, sorted-key JSON string', () => {
    const canonical = canonicalizeBootstrapFetchPayload({ appDid: 'did:imajin:app', nonce: 'abc', timestamp: 1234 });

    expect(canonical).toBe('{"appDid":"did:imajin:app","nonce":"abc","timestamp":1234}');
  });
});
