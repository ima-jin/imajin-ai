import { describe, it, expect } from 'vitest';
import type { FairManifest } from '@imajin/fair';
import { canReadAsset, getAccessType, getAllowedDids } from '../read-access';

const OWNER = 'did:imajin:owner';
const GRANTED = 'did:imajin:granted';
const STRANGER = 'did:imajin:stranger';

function subject(access: FairManifest['access']) {
  return { ownerDid: OWNER, access };
}

describe('getAccessType / getAllowedDids', () => {
  it('resolves string and object forms', () => {
    expect(getAccessType('public')).toBe('public');
    expect(getAccessType('private')).toBe('private');
    expect(getAccessType({ type: 'trust-graph', allowedDids: [GRANTED] })).toBe('trust-graph');
    expect(getAccessType({ type: 'conversation' })).toBe('conversation');
  });

  it('returns granted DIDs only for object access', () => {
    expect(getAllowedDids('public')).toEqual([]);
    expect(getAllowedDids({ type: 'trust-graph', allowedDids: [GRANTED] })).toEqual([GRANTED]);
  });
});

describe('canReadAsset', () => {
  it('public: anyone, no auth required', () => {
    expect(canReadAsset(subject('public'), null)).toMatchObject({ allowed: true, requiresAuth: false });
    expect(canReadAsset(subject('public'), STRANGER).allowed).toBe(true);
  });

  it('non-public requires authentication', () => {
    expect(canReadAsset(subject('private'), null)).toMatchObject({ allowed: false, requiresAuth: true });
  });

  it('private: owner only', () => {
    expect(canReadAsset(subject('private'), OWNER).allowed).toBe(true);
    expect(canReadAsset(subject('private'), STRANGER).allowed).toBe(false);
  });

  it('trust-graph: owner or a granted DID', () => {
    const access: FairManifest['access'] = { type: 'trust-graph', allowedDids: [GRANTED] };
    expect(canReadAsset(subject(access), OWNER).allowed).toBe(true);
    expect(canReadAsset(subject(access), GRANTED).allowed).toBe(true);
    expect(canReadAsset(subject(access), STRANGER).allowed).toBe(false);
  });

  it('conversation: owner only at the sync layer; non-owner deferred to authorizeAssetRead', () => {
    expect(canReadAsset(subject({ type: 'conversation' }), OWNER).allowed).toBe(true);
    expect(canReadAsset(subject({ type: 'conversation' }), STRANGER).allowed).toBe(false);
    expect(canReadAsset(subject({ type: 'conversation' }), null).allowed).toBe(false);
  });
});
