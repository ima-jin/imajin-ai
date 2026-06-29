import { describe, it, expect } from 'vitest';
import { canWriteAssetContent } from '../write-access';

const OWNER = 'did:imajin:owner';
const STRANGER = 'did:imajin:stranger';

describe('canWriteAssetContent (owner-only content update)', () => {
  it('allows the owner to write a mutable asset', () => {
    expect(canWriteAssetContent({ ownerDid: OWNER, immutable: false }, OWNER)).toEqual({ allowed: true });
    // null immutable is treated as not-immutable
    expect(canWriteAssetContent({ ownerDid: OWNER, immutable: null }, OWNER)).toEqual({ allowed: true });
  });

  it('forbids a non-owner (no delegated write grants in v1) — read != write', () => {
    const decision = canWriteAssetContent({ ownerDid: OWNER, immutable: false }, STRANGER);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('forbidden');
  });

  it('forbids an unauthenticated (null) requester', () => {
    const decision = canWriteAssetContent({ ownerDid: OWNER, immutable: false }, null);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('forbidden');
  });

  it('blocks the owner from editing an immutable asset', () => {
    const decision = canWriteAssetContent({ ownerDid: OWNER, immutable: true }, OWNER);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('immutable');
  });

  it('checks ownership before immutability (a non-owner never learns it is locked)', () => {
    const decision = canWriteAssetContent({ ownerDid: OWNER, immutable: true }, STRANGER);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('forbidden');
  });
});
