import { describe, it, expect } from 'vitest';
import { generateKeypair, sign, bytesToHex, hexToBytes } from '../browser-keys';
import { verifySignature } from '../crypto';

describe('generateKeypair', () => {
  it('produces a 32-byte hex private key and a 32-byte hex public key', async () => {
    const keypair = await generateKeypair();
    expect(keypair.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keypair.publicKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates distinct keypairs across calls', async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe('sign', () => {
  it('produces a signature verifiable by the server-side verifySignature against the matching public key', async () => {
    const keypair = await generateKeypair();
    const signature = await sign('a-challenge-string', keypair.privateKey);

    await expect(verifySignature('a-challenge-string', signature, keypair.publicKey)).resolves.toBe(true);
  });

  it('rejects verification against a different public key', async () => {
    const keypair = await generateKeypair();
    const other = await generateKeypair();
    const signature = await sign('a-challenge-string', keypair.privateKey);

    await expect(verifySignature('a-challenge-string', signature, other.publicKey)).resolves.toBe(false);
  });

  it('rejects verification of a tampered message', async () => {
    const keypair = await generateKeypair();
    const signature = await sign('original-message', keypair.privateKey);

    await expect(verifySignature('tampered-message', signature, keypair.publicKey)).resolves.toBe(false);
  });
});

describe('bytesToHex / hexToBytes', () => {
  it('round-trips bytes through hex', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255, 128]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('encodes as lowercase, zero-padded hex', () => {
    expect(bytesToHex(new Uint8Array([0, 255, 10]))).toBe('00ff0a');
  });

  it('decodes an empty string to an empty byte array', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });
});
