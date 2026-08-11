/**
 * Unit tests for the app-authorization → channel_links projection adapter
 * (#1803, workstream 2/3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));

  const updateWhereMock = vi.fn().mockResolvedValue(undefined);
  const setMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));

  const CHANNEL_LINKS_TABLE = {
    channel: 'channelLinks.channel',
    channelUid: 'channelLinks.channelUid',
    did: 'channelLinks.did',
    appDid: 'channelLinks.appDid',
    scopes: 'channelLinks.scopes',
    status: 'channelLinks.status',
    revokedAt: 'channelLinks.revokedAt',
  };

  return {
    whereMock,
    fromMock,
    selectMock,
    onConflictDoUpdateMock,
    valuesMock,
    insertMock,
    updateWhereMock,
    setMock,
    updateMock,
    CHANNEL_LINKS_TABLE,
  };
});

const { CHANNEL_LINKS_TABLE } = mocks;

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, insert: mocks.insertMock, update: mocks.updateMock },
  channelLinks: mocks.CHANNEL_LINKS_TABLE,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_test` }));

import {
  projectAppAuthorizationGrant,
  revokeAppAuthorizationGrant,
  hasAppAuthorizationGrant,
  APP_AUTHORIZATION_CHANNEL,
} from '../app-authorization-grant';

const OWNER_DID = 'did:imajin:scott';
const APP_DID = 'did:imajin:agrifortress';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereMock.mockResolvedValue([]);
});

describe('projectAppAuthorizationGrant', () => {
  it('upserts an active row keyed by (channel, ownerDid, appDid) with the granted scopes', async () => {
    await projectAppAuthorizationGrant({ ownerDid: OWNER_DID, appDid: APP_DID, scopes: ['supply:read', 'profile:read'] });

    expect(mocks.insertMock).toHaveBeenCalledWith(CHANNEL_LINKS_TABLE);
    const inserted = mocks.valuesMock.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      channel: APP_AUTHORIZATION_CHANNEL,
      channelUid: OWNER_DID,
      did: OWNER_DID,
      appDid: APP_DID,
      scopes: ['supply:read', 'profile:read'],
      status: 'active',
      revokedAt: null,
    });

    const conflictOpts = mocks.onConflictDoUpdateMock.mock.calls[0][0] as { set: Record<string, unknown> };
    expect(conflictOpts.set).toMatchObject({ scopes: ['supply:read', 'profile:read'], status: 'active', revokedAt: null });
  });

  it('revokes the row instead of upserting when scopes is empty', async () => {
    await projectAppAuthorizationGrant({ ownerDid: OWNER_DID, appDid: APP_DID, scopes: [] });

    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).toHaveBeenCalledWith(CHANNEL_LINKS_TABLE);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }));
  });
});

describe('revokeAppAuthorizationGrant', () => {
  it('flips the active row to revoked', async () => {
    await revokeAppAuthorizationGrant({ ownerDid: OWNER_DID, appDid: APP_DID });

    expect(mocks.updateMock).toHaveBeenCalledWith(CHANNEL_LINKS_TABLE);
    expect(mocks.setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }));
  });
});

describe('hasAppAuthorizationGrant', () => {
  it('returns true when an active row carries the requested scope', async () => {
    mocks.whereMock.mockResolvedValue([{ scopes: ['supply:read'] }]);

    await expect(hasAppAuthorizationGrant(APP_DID, OWNER_DID, 'supply:read')).resolves.toBe(true);
  });

  it('returns false when no active row carries the requested scope', async () => {
    mocks.whereMock.mockResolvedValue([{ scopes: ['profile:read'] }]);

    await expect(hasAppAuthorizationGrant(APP_DID, OWNER_DID, 'supply:read')).resolves.toBe(false);
  });

  it('returns false when no rows are found at all', async () => {
    mocks.whereMock.mockResolvedValue([]);

    await expect(hasAppAuthorizationGrant(APP_DID, OWNER_DID, 'supply:read')).resolves.toBe(false);
  });

  it('propagates a DB error rather than swallowing it (fail-closed)', async () => {
    mocks.whereMock.mockRejectedValue(new Error('db unavailable'));

    await expect(hasAppAuthorizationGrant(APP_DID, OWNER_DID, 'supply:read')).rejects.toThrow('db unavailable');
  });
});
