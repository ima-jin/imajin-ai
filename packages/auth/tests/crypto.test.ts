import { describe, it, expect } from 'vitest';
import {
  bytesToHex,
  hexToBytes,
  stringToBytes,
  extractPrivateKeySeed,
  generatePrivateKey,
  getPublicKey,
  generateKeypair,
  signSync,
  verifySync,
  isValidPublicKey,
  isValidPrivateKey,
  isValidSignature,
  bytesToMultibase,
  multibaseToPubkey,
  hexToMultibase,
  multibaseToHex,
} from '../src/crypto';

describe('bytesToHex / hexToBytes', () => {
  it('round-trips bytes through hex', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    expect(hexToBytes(bytesToHex(original))).toEqual(original);
  });

  it('converts known bytes to hex', () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  it('converts known hex to bytes', () => {
    expect(hexToBytes('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('handles empty input', () => {
    expect(bytesToHex(new Uint8Array([]))).toBe('');
    expect(hexToBytes('')).toEqual(new Uint8Array([]));
  });

  it('pads single-digit hex values', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 2]))).toBe('000102');
  });

  it('throws on odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow('Invalid hex string');
  });
});

describe('stringToBytes', () => {
  it('encodes ASCII strings', () => {
    const bytes = stringToBytes('hello');
    expect(bytes).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  it('encodes UTF-8 strings', () => {
    const bytes = stringToBytes('今');
    expect(bytes.length).toBeGreaterThan(1);
  });
});

describe('extractPrivateKeySeed', () => {
  it('returns raw 32-byte hex as-is', () => {
    const raw = 'a'.repeat(64);
    expect(extractPrivateKeySeed(raw)).toBe(raw);
  });

  it('extracts seed from PKCS#8 DER hex', () => {
    const prefix = '302e020100300506032b657004220420';
    const seed = 'ab'.repeat(32);
    expect(extractPrivateKeySeed(prefix + seed)).toBe(seed);
  });

  it('handles uppercase hex', () => {
    const raw = 'A'.repeat(64);
    expect(extractPrivateKeySeed(raw)).toBe('a'.repeat(64));
  });

  it('trims whitespace', () => {
    const raw = 'a'.repeat(64);
    expect(extractPrivateKeySeed('  ' + raw + '  ')).toBe(raw);
  });

  it('throws on invalid length', () => {
    expect(() => extractPrivateKeySeed('abcd')).toThrow('Invalid Ed25519 private key');
  });

  it('throws on 96-char hex without PKCS#8 prefix', () => {
    expect(() => extractPrivateKeySeed('ff'.repeat(48))).toThrow('Invalid Ed25519 private key');
  });
});

describe('key generation', () => {
  it('generates a valid private key', () => {
    const key = generatePrivateKey();
    expect(key).toHaveLength(64);
    expect(isValidPrivateKey(key)).toBe(true);
  });

  it('derives a valid public key from a private key', () => {
    const privateKey = generatePrivateKey();
    const publicKey = getPublicKey(privateKey);
    expect(publicKey).toHaveLength(64);
    expect(isValidPublicKey(publicKey)).toBe(true);
  });

  it('derives the same public key deterministically', () => {
    const privateKey = generatePrivateKey();
    expect(getPublicKey(privateKey)).toBe(getPublicKey(privateKey));
  });

  it('generateKeypair returns matching pair', () => {
    const { privateKey, publicKey } = generateKeypair();
    expect(getPublicKey(privateKey)).toBe(publicKey);
  });

  it('generates unique keys each time', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.privateKey).not.toBe(b.privateKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe('sign / verify', () => {
  it('verifies a valid signature', () => {
    const { privateKey, publicKey } = generateKeypair();
    const message = 'hello world';
    const signature = signSync(message, privateKey);
    expect(verifySync(signature, message, publicKey)).toBe(true);
  });

  it('rejects a tampered message', () => {
    const { privateKey, publicKey } = generateKeypair();
    const signature = signSync('original', privateKey);
    expect(verifySync(signature, 'tampered', publicKey)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const signature = signSync('hello', alice.privateKey);
    expect(verifySync(signature, 'hello', bob.publicKey)).toBe(false);
  });

  it('signs Uint8Array messages', () => {
    const { privateKey, publicKey } = generateKeypair();
    const message = new Uint8Array([1, 2, 3]);
    const signature = signSync(message, privateKey);
    expect(verifySync(signature, message, publicKey)).toBe(true);
  });

  it('produces 128-char hex signatures', () => {
    const { privateKey } = generateKeypair();
    const signature = signSync('test', privateKey);
    expect(signature).toHaveLength(128);
    expect(isValidSignature(signature)).toBe(true);
  });

  it('returns false for garbage signatures', () => {
    const { publicKey } = generateKeypair();
    expect(verifySync('not-a-signature', 'msg', publicKey)).toBe(false);
  });

  it('accepts PKCS#8 private keys for signing', () => {
    const privateKey = generatePrivateKey();
    const publicKey = getPublicKey(privateKey);
    const pkcs8 = '302e020100300506032b657004220420' + privateKey;
    const signature = signSync('hello', pkcs8);
    expect(verifySync(signature, 'hello', publicKey)).toBe(true);
  });
});

describe('isValidPublicKey', () => {
  it('accepts valid 64-char hex', () => {
    expect(isValidPublicKey('ab'.repeat(32))).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isValidPublicKey('ab'.repeat(16))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidPublicKey('zz'.repeat(32))).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidPublicKey(123 as any)).toBe(false);
    expect(isValidPublicKey(null as any)).toBe(false);
  });
});

describe('isValidSignature', () => {
  it('accepts valid 128-char hex', () => {
    expect(isValidSignature('ab'.repeat(64))).toBe(true);
  });

  it('rejects wrong length', () => {
    expect(isValidSignature('ab'.repeat(32))).toBe(false);
  });
});

describe('multibase encoding', () => {
  it('round-trips public key through multibase', () => {
    const { publicKey } = generateKeypair();
    const multibase = hexToMultibase(publicKey);
    expect(multibaseToHex(multibase)).toBe(publicKey);
  });

  it('multibase starts with z6Mk', () => {
    const { publicKey } = generateKeypair();
    const multibase = hexToMultibase(publicKey);
    expect(multibase.startsWith('z6Mk')).toBe(true);
  });

  it('round-trips bytes through multibase', () => {
    const { publicKey } = generateKeypair();
    const pubkeyBytes = hexToBytes(publicKey);
    const multibase = bytesToMultibase(pubkeyBytes);
    const decoded = multibaseToPubkey(multibase);
    expect(decoded).toEqual(pubkeyBytes);
  });

  it('rejects non-z prefix', () => {
    expect(() => multibaseToPubkey('a6MkTest')).toThrow('must start with z');
  });

  it('rejects wrong key length', () => {
    expect(() => bytesToMultibase(new Uint8Array(16))).toThrow('must be 32 bytes');
  });
});
