import { describe, it, expect } from 'vitest';
import {
  isKnockPublicKey,
  isKnockRequestedCapabilities,
  isKnockSelfDescription,
  isKnockExternalDid,
  KNOCK_SELF_DESCRIPTION_MAX_LENGTH,
  KNOCK_MAX_REQUESTED_CAPABILITIES,
  KNOCK_STATUSES,
  EXTERNAL_DID_VERIFICATION_STATES,
} from '../src/knock';

const VALID_PUBLIC_KEY = 'a'.repeat(64);

describe('isKnockPublicKey', () => {
  it('accepts a 64-char hex string', () => {
    expect(isKnockPublicKey(VALID_PUBLIC_KEY)).toBe(true);
    expect(isKnockPublicKey('A'.repeat(64))).toBe(true);
  });

  it('rejects the wrong length, non-hex characters, and non-strings', () => {
    expect(isKnockPublicKey('a'.repeat(63))).toBe(false);
    expect(isKnockPublicKey('a'.repeat(65))).toBe(false);
    expect(isKnockPublicKey('z'.repeat(64))).toBe(false);
    expect(isKnockPublicKey(123)).toBe(false);
    expect(isKnockPublicKey(null)).toBe(false);
    expect(isKnockPublicKey(undefined)).toBe(false);
  });
});

describe('isKnockRequestedCapabilities — advisory preview, grammar-checked only', () => {
  it('accepts a well-formed domain:verb array', () => {
    expect(isKnockRequestedCapabilities(['intros:propose', 'messages:write'])).toBe(true);
  });

  it('accepts an empty array', () => {
    expect(isKnockRequestedCapabilities([])).toBe(true);
  });

  it('accepts capability names that are not (yet) in the closed grant registry — advisory only, not enforced', () => {
    expect(isKnockRequestedCapabilities(['not-a-real-scope:verb'])).toBe(true);
  });

  it('rejects malformed entries and non-arrays', () => {
    expect(isKnockRequestedCapabilities(['bad scope'])).toBe(false);
    expect(isKnockRequestedCapabilities([42])).toBe(false);
    expect(isKnockRequestedCapabilities('intros:propose')).toBe(false);
    expect(isKnockRequestedCapabilities(null)).toBe(false);
  });

  it('rejects more than the maximum number of entries', () => {
    const tooMany = Array.from({ length: KNOCK_MAX_REQUESTED_CAPABILITIES + 1 }, (_, i) => `domain${i}:verb`);
    expect(isKnockRequestedCapabilities(tooMany)).toBe(false);
  });
});

describe('isKnockSelfDescription', () => {
  it('accepts a non-empty string within the length limit', () => {
    expect(isKnockSelfDescription('A matchmaking agent for professional intros.')).toBe(true);
  });

  it('rejects empty, whitespace-only, oversized, or non-string input', () => {
    expect(isKnockSelfDescription('')).toBe(false);
    expect(isKnockSelfDescription('   ')).toBe(false);
    expect(isKnockSelfDescription('x'.repeat(KNOCK_SELF_DESCRIPTION_MAX_LENGTH + 1))).toBe(false);
    expect(isKnockSelfDescription(42)).toBe(false);
    expect(isKnockSelfDescription(null)).toBe(false);
  });

  it('accepts exactly the maximum length', () => {
    expect(isKnockSelfDescription('x'.repeat(KNOCK_SELF_DESCRIPTION_MAX_LENGTH))).toBe(true);
  });
});

describe('isKnockExternalDid', () => {
  it('accepts a well-formed external DID', () => {
    expect(isKnockExternalDid('did:web:boardy.ai')).toBe(true);
  });

  it('rejects non-DIDs and DID patterns/wildcards', () => {
    expect(isKnockExternalDid('boardy.ai')).toBe(false);
    expect(isKnockExternalDid('did:web:*')).toBe(false);
    expect(isKnockExternalDid(null)).toBe(false);
  });
});

describe('KNOCK_STATUSES — fail-closed, no stored "expired" state', () => {
  it('only ever contains pending, accepted, and declined', () => {
    expect(KNOCK_STATUSES).toEqual(['pending', 'accepted', 'declined']);
  });
});

describe('EXTERNAL_DID_VERIFICATION_STATES (#1900) — never a fatal/reject state', () => {
  it('only ever contains verified, declared_unverified, and resolution_failed', () => {
    expect(EXTERNAL_DID_VERIFICATION_STATES).toEqual(['verified', 'declared_unverified', 'resolution_failed']);
  });
});
