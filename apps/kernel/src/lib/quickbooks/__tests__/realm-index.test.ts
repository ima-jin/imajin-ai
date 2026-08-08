import { describe, it, expect, vi, beforeEach } from 'vitest';

const { onConflictDoUpdateMock, valuesMock, insertMock, limitMock, whereMock, orderByMock, selectMock } = vi.hoisted(() => {
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  const limitMock = vi.fn();
  const orderByMock = vi.fn(() => ({ limit: limitMock }));
  const whereMock = vi.fn(() => ({ limit: limitMock, orderBy: orderByMock }));
  const selectMock = vi.fn(() => ({ from: () => ({ where: whereMock }) }));
  return { onConflictDoUpdateMock, valuesMock, insertMock, limitMock, whereMock, orderByMock, selectMock };
});

vi.mock('@/src/db', () => ({
  db: { insert: insertMock, select: selectMock },
  quickbooksRealmIndex: { realmId: 'realm_id', ownerDid: 'owner_did', appDid: 'app_did', updatedAt: 'updated_at' },
}));

import { upsertRealmIndex, resolveRealmOwner, resolveAppDidForOwner } from '../realm-index';

const OWNER = 'did:imajin:scott';
const APP = 'did:imajin:agrifortress';
const REALM = 'realm9';

beforeEach(() => {
  onConflictDoUpdateMock.mockClear();
  valuesMock.mockClear();
  insertMock.mockClear();
  limitMock.mockReset();
  whereMock.mockClear();
  orderByMock.mockClear();
  selectMock.mockClear();
});

describe('upsertRealmIndex (xprize #35)', () => {
  it('inserts with an onConflict upsert keyed by realmId', async () => {
    await upsertRealmIndex(REALM, OWNER, APP);

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith({ realmId: REALM, ownerDid: OWNER, appDid: APP });
    expect(onConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'realm_id',
        set: expect.objectContaining({ ownerDid: OWNER, appDid: APP }),
      }),
    );
  });
});

describe('resolveRealmOwner (xprize #35)', () => {
  it('returns the ownerDid + appDid pair for an indexed realmId', async () => {
    limitMock.mockResolvedValue([{ ownerDid: OWNER, appDid: APP }]);
    expect(await resolveRealmOwner(REALM)).toEqual({ ownerDid: OWNER, appDid: APP });
  });

  it('returns undefined for an unindexed realmId', async () => {
    limitMock.mockResolvedValue([]);
    expect(await resolveRealmOwner(REALM)).toBeUndefined();
  });
});

describe('resolveAppDidForOwner (xprize #35 cron reconcile)', () => {
  it('returns the most recently connected appDid for the owner', async () => {
    limitMock.mockResolvedValue([{ appDid: APP }]);
    expect(await resolveAppDidForOwner(OWNER)).toBe(APP);
    expect(orderByMock).toHaveBeenCalled();
  });

  it('falls back to the ownerDid itself when no row is indexed (BYO-app)', async () => {
    limitMock.mockResolvedValue([]);
    expect(await resolveAppDidForOwner(OWNER)).toBe(OWNER);
  });
});
