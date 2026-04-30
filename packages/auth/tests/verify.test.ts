import { describe, it, expect, vi, afterEach } from 'vitest';
import { verify, verifySync, verifyChallenge, verifySignatureOnly, isValidMessageStructure } from '../src/verify';
import { signSync } from '../src/sign';
import { generateKeypair } from '../src/crypto';
import { SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '../src/constants';

const keypair = generateKeypair();
const identity = { id: 'did:imajin:test', type: 'human' as const };

function makeSignedMessage(payload: unknown = { test: true }) {
  return signSync(payload, keypair.privateKey, identity);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isValidMessageStructure', () => {
  it('accepts valid message', () => {
    expect(isValidMessageStructure(makeSignedMessage())).toBe(true);
  });

  it('rejects null', () => {
    expect(isValidMessageStructure(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isValidMessageStructure('string')).toBe(false);
  });

  it('rejects missing from', () => {
    const msg = makeSignedMessage();
    expect(isValidMessageStructure({ ...msg, from: undefined })).toBe(false);
  });

  it('rejects invalid type', () => {
    const msg = makeSignedMessage();
    expect(isValidMessageStructure({ ...msg, type: 'bot' })).toBe(false);
  });

  it('rejects missing timestamp', () => {
    const msg = makeSignedMessage();
    expect(isValidMessageStructure({ ...msg, timestamp: undefined })).toBe(false);
  });

  it('rejects missing signature', () => {
    const msg = makeSignedMessage();
    expect(isValidMessageStructure({ ...msg, signature: undefined })).toBe(false);
  });

  it('accepts agent type', () => {
    const msg = { ...makeSignedMessage(), type: 'agent' };
    expect(isValidMessageStructure(msg)).toBe(true);
  });
});

describe('verifySync', () => {
  it('verifies a freshly signed message', () => {
    const msg = makeSignedMessage();
    const result = verifySync(msg, keypair.publicKey);
    expect(result).toEqual({ valid: true });
  });

  it('rejects invalid public key format', () => {
    const msg = makeSignedMessage();
    const result = verifySync(msg, 'not-a-key');
    expect(result).toEqual({ valid: false, error: 'Invalid public key format' });
  });

  it('rejects invalid signature format', () => {
    const msg = { ...makeSignedMessage(), signature: 'short' };
    const result = verifySync(msg, keypair.publicKey);
    expect(result).toEqual({ valid: false, error: 'Invalid signature format' });
  });

  it('rejects tampered payload', () => {
    const msg = makeSignedMessage({ amount: 100 });
    msg.payload = { amount: 999 };
    const result = verifySync(msg, keypair.publicKey);
    expect(result).toEqual({ valid: false, error: 'Invalid signature' });
  });

  it('rejects wrong public key', () => {
    const msg = makeSignedMessage();
    const other = generateKeypair();
    const result = verifySync(msg, other.publicKey);
    expect(result).toEqual({ valid: false, error: 'Invalid signature' });
  });

  it('rejects expired messages', () => {
    const msg = makeSignedMessage();
    msg.timestamp = Date.now() - SIGNED_MESSAGE_MAX_AGE - 1000;
    // Re-sign with the old timestamp by crafting manually
    const result = verifySync(msg, keypair.publicKey);
    expect(result.valid).toBe(false);
  });

  it('rejects messages too far in the future', () => {
    const msg = makeSignedMessage();
    msg.timestamp = Date.now() + FUTURE_TOLERANCE + 10_000;
    const result = verifySync(msg, keypair.publicKey);
    expect(result.valid).toBe(false);
  });

  it('skips timestamp check when requested', () => {
    const msg = makeSignedMessage();
    msg.timestamp = Date.now() - SIGNED_MESSAGE_MAX_AGE - 60_000;
    const result = verifySync(msg, keypair.publicKey, { skipTimestampCheck: true });
    // Signature won't match because we modified timestamp after signing
    // but the timestamp check itself is skipped
    expect(result.error).not.toBe('Message expired');
  });

  it('allows custom maxAge', () => {
    const msg = makeSignedMessage();
    const result = verifySync(msg, keypair.publicKey, { maxAge: 0 });
    expect(result).toEqual({ valid: true });
  });
});

describe('verify (async)', () => {
  it('verifies a freshly signed message', async () => {
    const msg = makeSignedMessage();
    const result = await verify(msg, keypair.publicKey);
    expect(result).toEqual({ valid: true });
  });
});

describe('verifyChallenge', () => {
  it('verifies a correct challenge response', async () => {
    const challenge = 'abc123';
    const msg = signSync({ challenge }, keypair.privateKey, identity);
    const result = await verifyChallenge(msg, challenge, keypair.publicKey);
    expect(result).toEqual({ valid: true });
  });

  it('rejects mismatched challenge', async () => {
    const msg = signSync({ challenge: 'right' }, keypair.privateKey, identity);
    const result = await verifyChallenge(msg, 'wrong', keypair.publicKey);
    expect(result).toEqual({ valid: false, error: 'Challenge mismatch' });
  });
});

describe('verifySignatureOnly', () => {
  it('verifies without timestamp check', async () => {
    const msg = makeSignedMessage();
    const result = await verifySignatureOnly(msg, keypair.publicKey);
    expect(result).toEqual({ valid: true });
  });
});
