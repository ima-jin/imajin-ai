import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import {
  _resetKernelSigningKeyIssuedAtForTests,
  getKernelSigningKeyDocument,
} from '../kernel-signing-key';

const ENV_KEYS = [
  'AUTH_PRIVATE_KEY',
  'AUTH_PREVIOUS_PUBLIC_KEY',
  'AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM',
  'AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL',
] as const;

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('getKernelSigningKeyDocument (#2244)', () => {
  beforeEach(() => {
    _resetKernelSigningKeyIssuedAtForTests();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    _resetKernelSigningKeyIssuedAtForTests();
    restoreEnv();
  });

  it('returns null when AUTH_PRIVATE_KEY is not configured', () => {
    expect(getKernelSigningKeyDocument()).toBeNull();
  });

  it('derives the current key entry matching AUTH_PRIVATE_KEY, alg Ed25519, and a stable kid', () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = privateKey;

    const doc = getKernelSigningKeyDocument();

    expect(doc).not.toBeNull();
    expect(doc?.keys).toHaveLength(1);
    const current = doc?.keys[0];
    expect(current?.publicKey).toBe(publicKey);
    expect(current?.algorithm).toBe('Ed25519');
    expect(current?.kid).toMatch(/^auth-[0-9a-f]{16}$/);
    expect(current?.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(current?.validUntil).toBeUndefined();
    expect(doc?.current).toBe(current?.kid);
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
    expect(docA?.current).toBe(docB?.current);

    const second = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = second.privateKey;
    const docC = getKernelSigningKeyDocument();
    expect(docC?.current).not.toBe(docA?.current);
  });

  it('memoizes validFrom (the current key) across calls until explicitly reset', async () => {
    const { privateKey } = authCrypto.generateKeypair();
    process.env.AUTH_PRIVATE_KEY = privateKey;

    const first = getKernelSigningKeyDocument();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = getKernelSigningKeyDocument();

    expect(second?.keys[0].validFrom).toBe(first?.keys[0].validFrom);
  });

  describe('rotation grace window (previous key)', () => {
    beforeEach(() => {
      process.env.AUTH_PRIVATE_KEY = authCrypto.generateKeypair().privateKey;
    });

    it('includes a previous key entry when AUTH_PREVIOUS_PUBLIC_KEY + VALID_UNTIL are both set and unexpired', () => {
      const previous = authCrypto.generateKeypair();
      process.env.AUTH_PREVIOUS_PUBLIC_KEY = previous.publicKey;
      process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL = new Date(Date.now() + 60_000).toISOString();

      const doc = getKernelSigningKeyDocument();

      expect(doc?.keys).toHaveLength(2);
      const previousEntry = doc?.keys.find((k) => k.publicKey === previous.publicKey);
      expect(previousEntry).toBeDefined();
      expect(previousEntry?.algorithm).toBe('Ed25519');
      expect(previousEntry?.validUntil).toBeTruthy();
      expect(previousEntry?.kid).not.toBe(doc?.current);
    });

    it('honors an explicit AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM, defaulting to the epoch otherwise', () => {
      const previous = authCrypto.generateKeypair();
      process.env.AUTH_PREVIOUS_PUBLIC_KEY = previous.publicKey;
      process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL = new Date(Date.now() + 60_000).toISOString();

      const withoutValidFrom = getKernelSigningKeyDocument();
      const previousEntryDefault = withoutValidFrom?.keys.find((k) => k.publicKey === previous.publicKey);
      expect(previousEntryDefault?.validFrom).toBe(new Date(0).toISOString());

      process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM = '2020-01-01T00:00:00.000Z';
      const withValidFrom = getKernelSigningKeyDocument();
      const previousEntryExplicit = withValidFrom?.keys.find((k) => k.publicKey === previous.publicKey);
      expect(previousEntryExplicit?.validFrom).toBe('2020-01-01T00:00:00.000Z');
    });

    it('omits the previous key when AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL is missing', () => {
      process.env.AUTH_PREVIOUS_PUBLIC_KEY = authCrypto.generateKeypair().publicKey;

      const doc = getKernelSigningKeyDocument();

      expect(doc?.keys).toHaveLength(1);
    });

    it('omits the previous key when AUTH_PREVIOUS_PUBLIC_KEY is missing', () => {
      process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL = new Date(Date.now() + 60_000).toISOString();

      const doc = getKernelSigningKeyDocument();

      expect(doc?.keys).toHaveLength(1);
    });

    it('omits the previous key once its grace window has expired', () => {
      process.env.AUTH_PREVIOUS_PUBLIC_KEY = authCrypto.generateKeypair().publicKey;
      process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL = new Date(Date.now() - 1_000).toISOString();

      const doc = getKernelSigningKeyDocument();

      expect(doc?.keys).toHaveLength(1);
    });

    it('omits the previous key when it is not a validly-shaped public key', () => {
      process.env.AUTH_PREVIOUS_PUBLIC_KEY = 'not-a-valid-hex-key';
      process.env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL = new Date(Date.now() + 60_000).toISOString();

      const doc = getKernelSigningKeyDocument();

      expect(doc?.keys).toHaveLength(1);
    });
  });
});
