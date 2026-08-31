import { describe, it, expect, vi } from 'vitest';
import type { FairManifest } from '@imajin/fair';
import { authorizeAssetRead } from '../authorize-read';

const OWNER = 'did:imajin:owner';
const MEMBER = 'did:imajin:member';
const STRANGER = 'did:imajin:stranger';
const DM = 'did:imajin:dm:abc123';
const GROUP = 'did:imajin:group:xyz789';

const conv = (conversationDid?: string): FairManifest['access'] =>
  conversationDid ? { type: 'conversation', conversationDid } : { type: 'conversation' };

describe('authorizeAssetRead (conversation membership #1168)', () => {
  it('owner is allowed without a membership check', async () => {
    const checkAccess = vi.fn();
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: conv(DM) }, OWNER, { checkAccess });
    expect(d.allowed).toBe(true);
    expect(checkAccess).not.toHaveBeenCalled();
  });

  it('conversation access never calls isGroupMember', async () => {
    const checkAccess = vi.fn().mockResolvedValue({ allowed: true });
    const isGroupMember = vi.fn();
    await authorizeAssetRead({ ownerDid: OWNER, access: conv(DM) }, MEMBER, { checkAccess, isGroupMember });
    expect(isGroupMember).not.toHaveBeenCalled();
  });

  it('public access never calls checkAccess or isGroupMember', async () => {
    const checkAccess = vi.fn();
    const isGroupMember = vi.fn();
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: 'public' }, STRANGER, { checkAccess, isGroupMember });
    expect(d.allowed).toBe(true);
    expect(checkAccess).not.toHaveBeenCalled();
    expect(isGroupMember).not.toHaveBeenCalled();
  });

  it('conversation member is allowed via checkAccess (DM)', async () => {
    const checkAccess = vi.fn().mockResolvedValue({ allowed: true });
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: conv(DM) }, MEMBER, { checkAccess });
    expect(d.allowed).toBe(true);
    expect(checkAccess).toHaveBeenCalledWith(MEMBER, DM);
  });

  it('conversation non-member is denied (group)', async () => {
    const checkAccess = vi.fn().mockResolvedValue({ allowed: false });
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: conv(GROUP) }, STRANGER, { checkAccess });
    expect(d.allowed).toBe(false);
    expect(checkAccess).toHaveBeenCalledWith(STRANGER, GROUP);
  });

  it('resolves the conversation DID from metadata.context.entityId when the manifest lacks it', async () => {
    const checkAccess = vi.fn().mockResolvedValue({ allowed: true });
    const d = await authorizeAssetRead(
      { ownerDid: OWNER, access: conv(), metadata: { context: { entityId: DM } } },
      MEMBER,
      { checkAccess },
    );
    expect(d.allowed).toBe(true);
    expect(checkAccess).toHaveBeenCalledWith(MEMBER, DM);
  });

  it('denies conversation access when the conversation DID is unresolvable', async () => {
    const checkAccess = vi.fn();
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: conv() }, STRANGER, { checkAccess });
    expect(d.allowed).toBe(false);
    expect(checkAccess).not.toHaveBeenCalled();
  });

  it('ignores a non-conversation entityId in metadata', async () => {
    const checkAccess = vi.fn();
    const d = await authorizeAssetRead(
      { ownerDid: OWNER, access: conv(), metadata: { context: { entityId: 'asset_123' } } },
      STRANGER,
      { checkAccess },
    );
    expect(d.allowed).toBe(false);
    expect(checkAccess).not.toHaveBeenCalled();
  });
});

describe('authorizeAssetRead (private-asset group/business membership #1851)', () => {
  it('owner is allowed without a group-membership check', async () => {
    const isGroupMember = vi.fn();
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: 'private' }, OWNER, { isGroupMember });
    expect(d.allowed).toBe(true);
    expect(isGroupMember).not.toHaveBeenCalled();
  });

  it('unauthenticated requester is denied without a group-membership check', async () => {
    const isGroupMember = vi.fn();
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: 'private' }, null, { isGroupMember });
    expect(d.allowed).toBe(false);
    expect(isGroupMember).not.toHaveBeenCalled();
  });

  it('(a) an active identity_members row on a group/business owner grants read', async () => {
    const isGroupMember = vi.fn().mockResolvedValue(true);
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: 'private' }, MEMBER, { isGroupMember });
    expect(d.allowed).toBe(true);
    expect(isGroupMember).toHaveBeenCalledWith(OWNER, MEMBER);
  });

  it('(b) a non-member stays denied', async () => {
    const isGroupMember = vi.fn().mockResolvedValue(false);
    const d = await authorizeAssetRead({ ownerDid: OWNER, access: 'private' }, STRANGER, { isGroupMember });
    expect(d.allowed).toBe(false);
    expect(d.accessType).toBe('private');
    expect(isGroupMember).toHaveBeenCalledWith(OWNER, STRANGER);
  });

  // (c) Personal-scope owners unaffected: the scope gate (only group/
  // business/community owners consult identity_members) lives inside
  // isActiveGroupMember itself, exercised against a real (mocked-DB)
  // implementation in group-membership.test.ts — not re-mocked here.

  it('trust-graph access never calls isGroupMember', async () => {
    const isGroupMember = vi.fn();
    const d = await authorizeAssetRead(
      { ownerDid: OWNER, access: { type: 'trust-graph', allowedDids: [MEMBER] } },
      MEMBER,
      { isGroupMember },
    );
    expect(d.allowed).toBe(true);
    expect(isGroupMember).not.toHaveBeenCalled();
  });
});
