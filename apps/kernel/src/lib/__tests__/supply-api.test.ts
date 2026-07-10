import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireAppAuthMock, publishMock, getLotChainMock } = vi.hoisted(() => ({
  requireAppAuthMock: vi.fn(),
  publishMock: vi.fn(),
  getLotChainMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAppAuth: requireAppAuthMock }));
vi.mock('@imajin/bus', () => ({ publish: publishMock, getLotChain: getLotChainMock }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'lot_test' }));

import { publishSupplyStage, handleLotGet } from '../supply';

const SCOTT = 'did:imajin:scott';

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function grantWrite() {
  requireAppAuthMock.mockResolvedValue({ appAuth: { appDid: 'did:app', userDid: SCOTT, scopes: ['supply:write'] } });
}

beforeEach(() => {
  requireAppAuthMock.mockReset();
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  getLotChainMock.mockReset();
});

describe('publishSupplyStage (#1135)', () => {
  it('publishes supply.declared pinned to userDid, minting the lot id', async () => {
    grantWrite();
    const res = await publishSupplyStage(req({ commodity: 'eggs', quantity: 12, unit: 'dozen' }), 'supply.declared');

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.correlationId).toBe('lot_test');
    expect(json.stage).toBe('declared');

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [type, event] = publishMock.mock.calls[0];
    expect(type).toBe('supply.declared');
    expect(event.issuer).toBe(SCOTT);
    expect(event.subject).toBe(SCOTT);
    expect(event.correlationId).toBe('lot_test');
    expect(event.payload.lotId).toBe('lot_test');
    expect(event.payload.supplierDid).toBe(SCOTT);
  });

  it('threads the provided lotId as correlationId on later stages', async () => {
    grantWrite();
    const res = await publishSupplyStage(
      req({ lotId: 'lot_eggs_1', commodity: 'eggs', quantity: 12, unit: 'dozen', priorCid: 'bafy-x' }),
      'supply.collected',
    );

    expect(res.status).toBe(201);
    const [type, event] = publishMock.mock.calls[0];
    expect(type).toBe('supply.collected');
    expect(event.correlationId).toBe('lot_eggs_1');
    expect(event.payload.priorCid).toBe('bafy-x');
  });

  it('requires lotId for non-declared stages', async () => {
    grantWrite();
    const res = await publishSupplyStage(req({ commodity: 'eggs', quantity: 12, unit: 'dozen' }), 'supply.collected');
    expect(res.status).toBe(400);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('validates required payload fields', async () => {
    grantWrite();
    const res = await publishSupplyStage(req({ commodity: 'eggs' }), 'supply.declared');
    expect(res.status).toBe(400);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('returns 401 when app-auth fails and never publishes', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    const res = await publishSupplyStage(req({ commodity: 'eggs', quantity: 12, unit: 'dozen' }), 'supply.declared');
    expect(res.status).toBe(401);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the supply:write scope is missing', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'insufficient scope', status: 403 });
    const res = await publishSupplyStage(req({ commodity: 'eggs', quantity: 12, unit: 'dozen' }), 'supply.declared');
    expect(res.status).toBe(403);
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('handleLotGet (#1135)', () => {
  it('returns the lot chain for a supply:read caller', async () => {
    requireAppAuthMock.mockResolvedValue({ appAuth: { appDid: 'did:app', userDid: SCOTT, scopes: ['supply:read'] } });
    getLotChainMock.mockResolvedValue({ lot: { correlationId: 'lot_1', status: 'listed' }, stages: [{ stage: 'declared' }] });

    const res = await handleLotGet(req({}), 'lot_1');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lot.correlationId).toBe('lot_1');
    expect(json.stages).toHaveLength(1);
  });

  it('returns 404 when the lot is unknown', async () => {
    requireAppAuthMock.mockResolvedValue({ appAuth: { appDid: 'did:app', userDid: SCOTT, scopes: ['supply:read'] } });
    getLotChainMock.mockResolvedValue({ lot: null, stages: [] });

    const res = await handleLotGet(req({}), 'missing');
    expect(res.status).toBe(404);
  });

  it('returns 401 when app-auth fails and never reads', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    const res = await handleLotGet(req({}), 'lot_1');
    expect(res.status).toBe(401);
    expect(getLotChainMock).not.toHaveBeenCalled();
  });
});
