import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import {
  _resetKernelSigningKeyIssuedAtForTests,
  getKernelSigningKeyDocument,
} from '../kernel-signing-key';

const ORIGINAL_AUTH_PRIVATE_KEY = process.env.AUTH_PRIVATE_KEY;

describe('getKernelSigningKeyDocument (#2244)', () => {
  beforeEach(() => {
    _resetKernelSigningKeyIssuedAtForTests();
  });

  afterEach(() => {
    _resetKernelSigningKeyIssuedAtForTests();
    if (ORIGINAL_AUTH_PRIVATE_KEY === undefined) delete process.env.AUTH_PRIVATE_KEY;
    else process.env.AUTH_PRIVATE_KEY = ORIGINAL_AUTH_PRIVATE_KEY;
  });

  it('returns null when AUTH_PRIVATE_KEY is not configured', () => {
    delete process.env.AUTH_PRIVATE_KEY;
    expect(getKernelSigningKeyDocument()).toBeNull();
  });

  it('derives the public key matching AUTH_PRIVATE_KEY, alg Ed25519, and a stable kid', () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = privateKey;

    const doc = getKernelSigningKeyDocument();

    expect(doc).not.toBeNull();
    expect(doc?.publicKey).toBe(publicKey);
    expect(doc?.alg).toBe('Ed25519');
    expect(doc?.kid).toMatch(/^auth-[0-9a-f]{16}$/);
    expect(doc?.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never includes the private key anywhere in the document', () => {
    const { privateKey } = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = privateKey;

    const doc = getKernelSigningKeyDocument();

    expect(JSON.stringify(doc)).not.toContain(privateKey);
  });

  it('produces the same kid for the same key across calls, and a different kid for a different key', () => {
    const first = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = first.privateKey;
    const docA = getKernelSigningKeyDocument();
    const docB = getKernelSigningKeyDocument();
    expect(docA?.kid).toBe(docB?.kid);

    const second = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = second.privateKey;
    const docC = getKernelSigningKeyDocument();
    expect(docC?.kid).not.toBe(docA?.kid);
  });

  it('memoizes issuedAt across calls until explicitly reset', async () => {
    const { privateKey } = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = privateKey;

    const first = getKernelSigningKeyDocument();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = getKernelSigningKeyDocument();

    expect(second?.issuedAt).toBe(first?.issuedAt);
  });
});
