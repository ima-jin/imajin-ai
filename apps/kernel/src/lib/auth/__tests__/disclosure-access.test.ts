import { describe, it, expect } from 'vitest';
import { isPartyToAttestation, resolveDisclosureAccess, type DisclosureAudience } from '../disclosure-access';

const SUBJECT = 'did:imajin:alice';
const ACTOR = 'did:imajin:agent';
const DELEGATOR = 'did:imajin:acme';
const STRANGER = 'did:imajin:mallory';

const audience: DisclosureAudience = { subjectDid: SUBJECT, actorDid: ACTOR, delegatorDid: DELEGATOR };

describe('isPartyToAttestation', () => {
  it('is true for the subject, the actor, and the delegator', () => {
    expect(isPartyToAttestation(SUBJECT, audience)).toBe(true);
    expect(isPartyToAttestation(ACTOR, audience)).toBe(true);
    expect(isPartyToAttestation(DELEGATOR, audience)).toBe(true);
  });

  it('is false for an unrelated DID', () => {
    expect(isPartyToAttestation(STRANGER, audience)).toBe(false);
  });

  it('ignores a null delegator', () => {
    const noDelegator: DisclosureAudience = { subjectDid: SUBJECT, actorDid: ACTOR, delegatorDid: null };
    expect(isPartyToAttestation(STRANGER, noDelegator)).toBe(false);
  });
});

describe('resolveDisclosureAccess — public', () => {
  it('is visible to anyone, including anonymous callers', () => {
    expect(resolveDisclosureAccess('public', null, audience, null)).toBe(true);
    expect(resolveDisclosureAccess('public', STRANGER, audience, null)).toBe(true);
  });
});

describe('resolveDisclosureAccess — network', () => {
  it('is visible to any authenticated caller, hidden from anonymous', () => {
    expect(resolveDisclosureAccess('network', STRANGER, audience, null)).toBe(true);
    expect(resolveDisclosureAccess('network', null, audience, null)).toBe(false);
  });
});

describe('resolveDisclosureAccess — parties', () => {
  it('is visible only to the subject, actor, or delegator', () => {
    expect(resolveDisclosureAccess('parties', SUBJECT, audience, null)).toBe(true);
    expect(resolveDisclosureAccess('parties', ACTOR, audience, null)).toBe(true);
    expect(resolveDisclosureAccess('parties', DELEGATOR, audience, null)).toBe(true);
    expect(resolveDisclosureAccess('parties', STRANGER, audience, null)).toBe(false);
    expect(resolveDisclosureAccess('parties', null, audience, null)).toBe(false);
  });
});

describe('resolveDisclosureAccess — connections', () => {
  it('is visible to a party even with no trust-graph data', () => {
    expect(resolveDisclosureAccess('connections', SUBJECT, audience, null)).toBe(true);
  });

  it('is visible to a viewer whose connections set includes the subject or actor', () => {
    expect(resolveDisclosureAccess('connections', STRANGER, audience, new Set([SUBJECT]))).toBe(true);
    expect(resolveDisclosureAccess('connections', STRANGER, audience, new Set([ACTOR]))).toBe(true);
  });

  it('is hidden from a non-party whose connections set does not include the subject or actor', () => {
    expect(resolveDisclosureAccess('connections', STRANGER, audience, new Set(['did:imajin:someone-else']))).toBe(false);
    expect(resolveDisclosureAccess('connections', STRANGER, audience, null)).toBe(false);
  });

  it('is hidden from an anonymous caller', () => {
    expect(resolveDisclosureAccess('connections', null, audience, new Set([SUBJECT]))).toBe(false);
  });
});
