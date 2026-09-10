/**
 * Tests for operator countersignature verification (#2082): shape
 * validation of the wire payload, and cryptographic verification against
 * the operator DID's currently registered key (unknown key, mismatched
 * key, revoked/rotated key, invalid signature, and the happy path).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { crypto as authCrypto, canonicalize } from '@imajin/auth';
import { OPERATOR_DID } from './operator-approvals-test-helpers';

const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn() }));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) })),
  },
  identities: { id: 'id', publicKey: 'public_key', scope: 'scope', tier: 'tier' },
}));

import { parseOperatorSignature, verifyOperatorCountersignature } from '../operator-countersign';

const FIELDS = { contentHash: 'a'.repeat(64), decision: 'approve' as const, decidedAt: '2026-09-10T18:00:00.000Z' };

function signFields(privateKeyHex: string, fields = FIELDS): string {
  return authCrypto.signSync(canonicalize(fields), privateKeyHex);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseOperatorSignature', () => {
  it('accepts undefined (no signature supplied)', () => {
    expect(parseOperatorSignature(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('accepts a well-shaped signature and lowercases keyId/sig', () => {
    const raw = { keyId: 'A'.repeat(64), alg: 'ed25519', sig: 'B'.repeat(128) };
    const result = parseOperatorSignature(raw);
    expect(result).toEqual({ ok: true, value: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) } });
  });

  it.each([
    { label: 'not an object', raw: 'nope' },
    { label: 'null', raw: null },
    { label: 'keyId too short', raw: { keyId: 'ab', alg: 'ed25519', sig: 'b'.repeat(128) } },
    { label: 'keyId not hex', raw: { keyId: 'z'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(128) } },
    { label: 'wrong alg', raw: { keyId: 'a'.repeat(64), alg: 'secp256k1', sig: 'b'.repeat(128) } },
    { label: 'sig wrong length', raw: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'b'.repeat(64) } },
    { label: 'sig not hex', raw: { keyId: 'a'.repeat(64), alg: 'ed25519', sig: 'z'.repeat(128) } },
  ])('rejects $label', ({ raw }) => {
    const result = parseOperatorSignature(raw);
    expect(result.ok).toBe(false);
  });
});

describe('verifyOperatorCountersignature', () => {
  it('accepts a valid signature from the operator DID\'s current registered key (happy path)', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: OPERATOR_DID, publicKey, type: 'actor', tier: 'established' }]);

    const sig = signFields(privateKey);
    const result = await verifyOperatorCountersignature(OPERATOR_DID, FIELDS, {
      keyId: publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result).toEqual({ ok: true });
  });

  it('rejects when the operator DID has no resolvable public key (unknown identity)', async () => {
    mockLimit.mockResolvedValueOnce([]);

    const result = await verifyOperatorCountersignature(OPERATOR_DID, FIELDS, {
      keyId: 'a'.repeat(64),
      alg: 'ed25519',
      sig: 'b'.repeat(128),
    });

    expect(result.ok).toBe(false);
  });

  it('rejects when keyId does not match the current registered key (unknown/mismatched key)', async () => {
    const { publicKey } = authCrypto.generateKeypair();
    const attacker = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: OPERATOR_DID, publicKey, type: 'actor', tier: 'established' }]);

    const sig = signFields(attacker.privateKey);
    const result = await verifyOperatorCountersignature(OPERATOR_DID, FIELDS, {
      keyId: attacker.publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/current registered key/);
  });

  it('rejects a signature from a since-rotated (revoked) key', async () => {
    const oldKey = authCrypto.generateKeypair();
    const newKey = authCrypto.generateKeypair();
    // Operator rotated keys — identities.publicKey now reflects the NEW key.
    mockLimit.mockResolvedValueOnce([{ id: OPERATOR_DID, publicKey: newKey.publicKey, type: 'actor', tier: 'established' }]);

    const sig = signFields(oldKey.privateKey);
    const result = await verifyOperatorCountersignature(OPERATOR_DID, FIELDS, {
      keyId: oldKey.publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result.ok).toBe(false);
  });

  it('rejects an invalid signature even when keyId matches the current key', async () => {
    const { publicKey } = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: OPERATOR_DID, publicKey, type: 'actor', tier: 'established' }]);

    const result = await verifyOperatorCountersignature(OPERATOR_DID, FIELDS, {
      keyId: publicKey,
      alg: 'ed25519',
      sig: 'f'.repeat(128),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('Invalid operator signature');
  });

  it('rejects a signature over different fields than the ones supplied (binding)', async () => {
    const { privateKey, publicKey } = authCrypto.generateKeypair();
    mockLimit.mockResolvedValueOnce([{ id: OPERATOR_DID, publicKey, type: 'actor', tier: 'established' }]);

    // Signed over a 'reject' decision, but verification is asked to check 'approve'.
    const sig = signFields(privateKey, { ...FIELDS, decision: 'reject' });
    const result = await verifyOperatorCountersignature(OPERATOR_DID, FIELDS, {
      keyId: publicKey,
      alg: 'ed25519',
      sig,
    });

    expect(result.ok).toBe(false);
  });
});
