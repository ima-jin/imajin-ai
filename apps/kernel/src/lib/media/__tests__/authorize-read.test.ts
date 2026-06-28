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

  it('non-conversation access never calls checkAccess', async () => {
    const checkAccess = vi.fn();
    expect((await authorizeAssetRead({ ownerDid: OWNER, access: 'private' }, STRANGER, { checkAccess })).allowed).toBe(false);
    expect((await authorizeAssetRead({ ownerDid: OWNER, access: 'public' }, STRANGER, { checkAccess })).allowed).toBe(true);
    expect(checkAccess).not.toHaveBeenCalled();
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
