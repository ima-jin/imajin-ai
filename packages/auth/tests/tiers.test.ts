import { describe, it, expect } from 'vitest';
import {
  isVerifiedTier,
  isEstablishedTier,
  isStewardTier,
  isOperatorTier,
  normalizeTier,
} from '../src/tiers';

describe('isVerifiedTier', () => {
  it('returns false for soft', () => expect(isVerifiedTier('soft')).toBe(false));
  it('returns true for preliminary', () => expect(isVerifiedTier('preliminary')).toBe(true));
  it('returns true for established', () => expect(isVerifiedTier('established')).toBe(true));
  it('returns true for steward', () => expect(isVerifiedTier('steward')).toBe(true));
  it('returns true for operator', () => expect(isVerifiedTier('operator')).toBe(true));
  it('returns false for undefined', () => expect(isVerifiedTier(undefined)).toBe(false));
  it('returns false for null', () => expect(isVerifiedTier(null)).toBe(false));
  it('returns false for garbage', () => expect(isVerifiedTier('admin')).toBe(false));
});

describe('isEstablishedTier', () => {
  it('returns false for soft', () => expect(isEstablishedTier('soft')).toBe(false));
  it('returns false for preliminary', () => expect(isEstablishedTier('preliminary')).toBe(false));
  it('returns true for established', () => expect(isEstablishedTier('established')).toBe(true));
  it('returns true for steward', () => expect(isEstablishedTier('steward')).toBe(true));
  it('returns true for operator', () => expect(isEstablishedTier('operator')).toBe(true));
});

describe('isStewardTier', () => {
  it('returns false for established', () => expect(isStewardTier('established')).toBe(false));
  it('returns true for steward', () => expect(isStewardTier('steward')).toBe(true));
  it('returns true for operator', () => expect(isStewardTier('operator')).toBe(true));
});

describe('isOperatorTier', () => {
  it('returns false for steward', () => expect(isOperatorTier('steward')).toBe(false));
  it('returns true for operator', () => expect(isOperatorTier('operator')).toBe(true));
});

describe('normalizeTier', () => {
  it('maps hard to preliminary', () => expect(normalizeTier('hard')).toBe('preliminary'));
  it('passes through preliminary', () => expect(normalizeTier('preliminary')).toBe('preliminary'));
  it('passes through established', () => expect(normalizeTier('established')).toBe('established'));
  it('passes through steward', () => expect(normalizeTier('steward')).toBe('steward'));
  it('passes through operator', () => expect(normalizeTier('operator')).toBe('operator'));
  it('defaults undefined to soft', () => expect(normalizeTier(undefined)).toBe('soft'));
  it('defaults null to soft', () => expect(normalizeTier(null)).toBe('soft'));
  it('defaults unknown string to soft', () => expect(normalizeTier('admin')).toBe('soft'));
});
