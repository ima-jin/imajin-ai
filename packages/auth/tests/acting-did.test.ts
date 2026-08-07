import { describe, it, expect } from 'vitest';
import { resolveActingDid, resolveComposedBy } from '../src/acting-did';
import type { Identity } from '../src/types';

function makeIdentity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: 'did:imajin:self',
    scope: 'actor',
    ...overrides,
  };
}

describe('resolveActingDid', () => {
  it('returns id when no delegation is set', () => {
    const identity = makeIdentity();
    expect(resolveActingDid(identity)).toBe('did:imajin:self');
  });

  it('returns actingAs when only actingAs is set', () => {
    const identity = makeIdentity({ actingAs: 'did:imajin:group' });
    expect(resolveActingDid(identity)).toBe('did:imajin:group');
  });

  it('returns actingFor when only actingFor is set', () => {
    const identity = makeIdentity({ actingFor: 'did:imajin:user' });
    expect(resolveActingDid(identity)).toBe('did:imajin:user');
  });

  it('actingFor wins over actingAs (agent delegation beats group impersonation)', () => {
    const identity = makeIdentity({
      actingFor: 'did:imajin:user',
      actingAs: 'did:imajin:group',
    });
    expect(resolveActingDid(identity)).toBe('did:imajin:user');
  });

  it('actingAs wins over id when actingFor is absent', () => {
    const identity = makeIdentity({ actingAs: 'did:imajin:group' });
    expect(resolveActingDid(identity)).toBe('did:imajin:group');
  });

  it('falls back to id when actingFor and actingAs are both undefined', () => {
    const identity = makeIdentity({ actingFor: undefined, actingAs: undefined });
    expect(resolveActingDid(identity)).toBe('did:imajin:self');
  });
});

describe('resolveComposedBy (#1673)', () => {
  it('returns the agent DID when acting for someone else', () => {
    const identity = makeIdentity({ actingFor: 'did:imajin:user' });

    // The pair is the whole point: the human owns it, the agent typed it.
    expect(resolveActingDid(identity)).toBe('did:imajin:user');
    expect(resolveComposedBy(identity)).toBe('did:imajin:self');
  });

  it('returns null with no delegation at all', () => {
    expect(resolveComposedBy(makeIdentity())).toBeNull();
  });

  it('returns null for group impersonation — actingAs is not transcription', () => {
    const identity = makeIdentity({ actingAs: 'did:imajin:group' });
    expect(resolveComposedBy(identity)).toBeNull();
  });

  it('returns null when the caller is delegated to itself', () => {
    const identity = makeIdentity({ actingFor: 'did:imajin:self' });
    expect(resolveComposedBy(identity)).toBeNull();
  });

  it('still reports the composer when actingFor and actingAs are both set', () => {
    const identity = makeIdentity({
      actingFor: 'did:imajin:user',
      actingAs: 'did:imajin:group',
    });
    expect(resolveComposedBy(identity)).toBe('did:imajin:self');
  });
});
