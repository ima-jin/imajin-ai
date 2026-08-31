import { describe, it, expect } from 'vitest';
import {
  isDid,
  isDelegationAudience,
  audienceAllows,
  isOnBehalfOfChain,
  grantProvenance,
  type DelegationAudience,
} from '../src/delegation-grant';

describe('isDid', () => {
  it('accepts well-formed DIDs across methods', () => {
    expect(isDid('did:imajin:abc123')).toBe(true);
    expect(isDid('did:web:example.com')).toBe(true);
    expect(isDid('did:key:z6Mkabc')).toBe(true);
  });

  it('rejects non-DIDs and DID patterns/wildcards', () => {
    expect(isDid('not-a-did')).toBe(false);
    expect(isDid('did:imajin:*')).toBe(false);
    expect(isDid('did:imajin:abc*')).toBe(false);
    expect(isDid('')).toBe(false);
    expect(isDid(42)).toBe(false);
    expect(isDid(null)).toBe(false);
  });
});

describe('isDelegationAudience', () => {
  it('accepts { type: "all" } with no extra keys', () => {
    expect(isDelegationAudience({ type: 'all' })).toBe(true);
  });

  it('rejects { type: "all" } carrying extra keys (e.g. a smuggled values array)', () => {
    expect(isDelegationAudience({ type: 'all', values: ['did:imajin:x'] })).toBe(false);
  });

  it('accepts { type: "dids", values: [...] } with plausible DIDs', () => {
    expect(isDelegationAudience({ type: 'dids', values: ['did:imajin:a', 'did:imajin:b'] })).toBe(true);
  });

  it('rejects an empty dids audience — enumeration must name someone', () => {
    expect(isDelegationAudience({ type: 'dids', values: [] })).toBe(false);
  });

  it('rejects duplicate DIDs in the audience', () => {
    expect(isDelegationAudience({ type: 'dids', values: ['did:imajin:a', 'did:imajin:a'] })).toBe(false);
  });

  it('rejects DID patterns/wildcards inside a dids audience', () => {
    expect(isDelegationAudience({ type: 'dids', values: ['did:imajin:*'] })).toBe(false);
  });

  it('rejects any type other than "all" or "dids" (no group variant yet)', () => {
    expect(isDelegationAudience({ type: 'group', values: ['did:imajin:a'] })).toBe(false);
  });

  it('rejects non-object and missing-type input', () => {
    expect(isDelegationAudience(null)).toBe(false);
    expect(isDelegationAudience('all')).toBe(false);
    expect(isDelegationAudience({})).toBe(false);
  });
});

describe('audienceAllows', () => {
  it('allows any target under an "all" audience', () => {
    const audience: DelegationAudience = { type: 'all' };
    expect(audienceAllows(audience, 'did:imajin:anyone')).toBe(true);
    expect(audienceAllows(audience)).toBe(true);
  });

  it('allows only enumerated DIDs under a "dids" audience', () => {
    const audience: DelegationAudience = { type: 'dids', values: ['did:imajin:a'] };
    expect(audienceAllows(audience, 'did:imajin:a')).toBe(true);
    expect(audienceAllows(audience, 'did:imajin:b')).toBe(false);
  });

  it('denies a "dids" audience when no target is supplied at all (fail-closed)', () => {
    const audience: DelegationAudience = { type: 'dids', values: ['did:imajin:a'] };
    expect(audienceAllows(audience)).toBe(false);
  });
});

describe('isOnBehalfOfChain', () => {
  const DELEGATOR = 'did:imajin:group-admin';
  const AGENT = 'did:imajin:matchmaker';

  it('accepts an empty chain (delegator acting on their own behalf)', () => {
    expect(isOnBehalfOfChain([], DELEGATOR, AGENT)).toBe(true);
  });

  it('accepts a chain of DIDs above the delegator', () => {
    expect(isOnBehalfOfChain(['did:imajin:group'], DELEGATOR, AGENT)).toBe(true);
  });

  it('rejects a chain that repeats the delegatorDid or agentDid', () => {
    expect(isOnBehalfOfChain([DELEGATOR], DELEGATOR, AGENT)).toBe(false);
    expect(isOnBehalfOfChain([AGENT], DELEGATOR, AGENT)).toBe(false);
  });

  it('rejects duplicate entries and non-DID entries', () => {
    expect(isOnBehalfOfChain(['did:imajin:group', 'did:imajin:group'], DELEGATOR, AGENT)).toBe(false);
    expect(isOnBehalfOfChain(['not-a-did'], DELEGATOR, AGENT)).toBe(false);
    expect(isOnBehalfOfChain('did:imajin:group', DELEGATOR, AGENT)).toBe(false);
  });
});

describe('grantProvenance', () => {
  it('extracts the dual-stamp provenance triple from a grant', () => {
    expect(
      grantProvenance({ delegatorDid: 'did:imajin:ryan', agentDid: 'did:imajin:agent', grantId: 'grant_1' }),
    ).toEqual({ delegatorDid: 'did:imajin:ryan', agentDid: 'did:imajin:agent', grantId: 'grant_1' });
  });
});
