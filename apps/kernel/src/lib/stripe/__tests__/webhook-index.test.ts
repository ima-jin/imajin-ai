import { describe, it, expect, vi, beforeEach } from 'vitest';

const { onConflictDoUpdateMock, valuesMock, insertMock, limitMock, whereMock, selectMock, deleteWhereMock, deleteMock } = vi.hoisted(() => {
  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  const limitMock = vi.fn();
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const selectMock = vi.fn(() => ({ from: () => ({ where: whereMock }) }));
  const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn(() => ({ where: deleteWhereMock }));
  return { onConflictDoUpdateMock, valuesMock, insertMock, limitMock, whereMock, selectMock, deleteWhereMock, deleteMock };
});

vi.mock('@/src/db', () => ({
  db: { insert: insertMock, select: selectMock, delete: deleteMock },
  stripeWebhookIndex: {
    routingId: 'routing_id',
    ownerDid: 'owner_did',
    endpointId: 'endpoint_id',
    updatedAt: 'updated_at',
  },
}));

import {
  upsertWebhookIndex,
  resolveWebhookOwner,
  findWebhookIndexByOwner,
  deleteWebhookIndexByOwner,
} from '../webhook-index';

const OWNER = 'did:imajin:scott';
const ROUTING_ID = 'stripewh_abc123';
const ENDPOINT_ID = 'we_123';

beforeEach(() => {
  onConflictDoUpdateMock.mockClear();
  valuesMock.mockClear();
  insertMock.mockClear();
  limitMock.mockReset();
  whereMock.mockClear();
  selectMock.mockClear();
  deleteWhereMock.mockClear();
  deleteMock.mockClear();
});

describe('upsertWebhookIndex (#1785)', () => {
  it('inserts with an onConflict upsert keyed by ownerDid', async () => {
    await upsertWebhookIndex(ROUTING_ID, OWNER, ENDPOINT_ID);

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith({ routingId: ROUTING_ID, ownerDid: OWNER, endpointId: ENDPOINT_ID });
    expect(onConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'owner_did',
        set: expect.objectContaining({ routingId: ROUTING_ID, endpointId: ENDPOINT_ID }),
      }),
    );
  });
});

describe('resolveWebhookOwner (#1785)', () => {
  it('returns the ownerDid + endpointId pair for an indexed routingId', async () => {
    limitMock.mockResolvedValue([{ ownerDid: OWNER, endpointId: ENDPOINT_ID }]);
    expect(await resolveWebhookOwner(ROUTING_ID)).toEqual({ ownerDid: OWNER, endpointId: ENDPOINT_ID });
  });

  it('returns undefined for an unindexed routingId (rejects an unknown/forged delivery)', async () => {
    limitMock.mockResolvedValue([]);
    expect(await resolveWebhookOwner(ROUTING_ID)).toBeUndefined();
  });
});

describe('findWebhookIndexByOwner (#1785)', () => {
  it('returns the current routing row for an owner', async () => {
    limitMock.mockResolvedValue([{ routingId: ROUTING_ID, endpointId: ENDPOINT_ID }]);
    expect(await findWebhookIndexByOwner(OWNER)).toEqual({ routingId: ROUTING_ID, endpointId: ENDPOINT_ID });
  });

  it('returns undefined when the owner has never connected', async () => {
    limitMock.mockResolvedValue([]);
    expect(await findWebhookIndexByOwner(OWNER)).toBeUndefined();
  });
});

describe('deleteWebhookIndexByOwner (#1785)', () => {
  it('deletes the row scoped to the owner', async () => {
    await deleteWebhookIndexByOwner(OWNER);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteWhereMock).toHaveBeenCalled();
  });
});
