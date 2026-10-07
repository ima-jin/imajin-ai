/**
 * #2693: the exact signed bytes, and the read-side assessment of a stored
 * decision — including the back-compat rule that a decision signed before
 * #2693 (no `mode` in the signed payload) is "letter not countersigned",
 * never "invalid".
 */
import { describe, it, expect } from 'vitest';
import { crypto as authCrypto, canonicalize } from '@imajin/auth';
import {
  LETTER_NOT_COUNTERSIGNED_LABEL,
  assessDecidedModeCountersignature,
  countersignedMessage,
} from '../operator-countersign-fields';

const HASH = 'a'.repeat(64);
const DECIDED_AT = '2026-10-07T12:00:00.000Z';
const BASE = { contentHash: HASH, decision: 'approve' as const, decidedAt: DECIDED_AT };

const keys = authCrypto.generateKeypair();

/** A stored `operator.approval.decided` payload as `decideOperatorApproval` writes it. */
function storedPayload(signedFields: Record<string, unknown>, payloadOverrides: Record<string, unknown> = {}) {
  const sig = authCrypto.signSync(canonicalize(signedFields), keys.privateKey);
  return {
    proposalId: 'opap_1',
    source: 'decision',
    kind: 'decision:card',
    decision: 'approve',
    decidedBy: 'did:imajin:operator',
    decidedAt: DECIDED_AT,
    contentHash: `sha256:${HASH}`,
    operatorSignature: { keyId: keys.publicKey, alg: 'ed25519', sig },
    ...payloadOverrides,
  };
}

describe('countersignedMessage', () => {
  it('without a mode is byte-identical to the pre-#2693 three-field canonical form', () => {
    expect(countersignedMessage(BASE)).toBe(canonicalize(BASE));
    expect(countersignedMessage(BASE)).not.toContain('mode');
    expect(countersignedMessage({ ...BASE, mode: undefined })).toBe(canonicalize(BASE));
  });

  it('with a mode adds exactly that one key, sorted after decision', () => {
    expect(countersignedMessage({ ...BASE, mode: 'b' })).toBe(canonicalize({ ...BASE, mode: 'b' }));
    expect(countersignedMessage({ ...BASE, mode: 'b' })).toMatch(/"decision":"approve","mode":"b"\}$/);
  });
});

describe('assessDecidedModeCountersignature', () => {
  it.each(['b', 'allow-once', 'deny', 'single', '5m', '24h'])('countersigned: the signature covers mode %s', (mode) => {
    expect(assessDecidedModeCountersignature(storedPayload({ ...BASE, mode }, { mode }))).toBe('countersigned');
  });

  it('not-countersigned: a pre-#2693 decision — signed without the letter, though the payload carries one', () => {
    const payload = storedPayload(BASE, { mode: 'b' });
    expect(assessDecidedModeCountersignature(payload)).toBe('not-countersigned');
    // The Record lane's wording for this state — NOT an invalid decision.
    expect(LETTER_NOT_COUNTERSIGNED_LABEL).toBe('letter not countersigned');
  });

  it('not-applicable: a decision with no mode whose signature covers the original three fields (legacy shape still verifies)', () => {
    expect(assessDecidedModeCountersignature(storedPayload(BASE))).toBe('not-applicable');
  });

  it('invalid: the payload mode was altered after the operator signed a different letter', () => {
    expect(assessDecidedModeCountersignature(storedPayload({ ...BASE, mode: 'a' }, { mode: 'b' }))).toBe('invalid');
  });

  it('invalid: the decision was altered after signing', () => {
    expect(assessDecidedModeCountersignature(storedPayload({ ...BASE, mode: 'a' }, { mode: 'a', decision: 'reject' }))).toBe('invalid');
  });

  it('invalid: a mode-less payload whose signature does not verify', () => {
    const payload = storedPayload(BASE);
    payload.operatorSignature.sig = 'f'.repeat(128);
    expect(assessDecidedModeCountersignature(payload)).toBe('invalid');
  });

  it('invalid: a signature from a different key than the payload names', () => {
    const other = authCrypto.generateKeypair();
    const payload = storedPayload({ ...BASE, mode: 'a' }, { mode: 'a' });
    payload.operatorSignature.keyId = other.publicKey;
    expect(assessDecidedModeCountersignature(payload)).toBe('invalid');
  });

  it('not-applicable: no operator signature at all', () => {
    const unsigned = Object.fromEntries(
      Object.entries(storedPayload(BASE, { mode: 'b' })).filter(([key]) => key !== 'operatorSignature'),
    );
    expect(assessDecidedModeCountersignature(unsigned)).toBe('not-applicable');
  });

  it.each([null, undefined, 'x', 3, {}, { operatorSignature: { keyId: 'k', sig: 's' } }])(
    'not-applicable (never throws) for an unassessable payload: %j',
    (payload) => {
      expect(assessDecidedModeCountersignature(payload)).toBe('not-applicable');
    },
  );

  it('tolerates malformed key/signature material without throwing', () => {
    const payload = storedPayload({ ...BASE, mode: 'a' }, { mode: 'a' });
    payload.operatorSignature.keyId = 'zz';
    expect(assessDecidedModeCountersignature(payload)).toBe('invalid');
  });
});
