import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireAppAuthMock, publishMock, getLotChainMock, recentLotsBySupplierMock } = vi.hoisted(() => ({
  requireAppAuthMock: vi.fn(),
  publishMock: vi.fn(),
  getLotChainMock: vi.fn(),
  recentLotsBySupplierMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ requireAppAuth: requireAppAuthMock }));
vi.mock('@imajin/bus', () => ({ publish: publishMock, getLotChain: getLotChainMock, recentLotsBySupplier: recentLotsBySupplierMock }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'lot_test' }));

import { publishSupplyStage, publishReceiptStage, handleLotGet, handleLotsBySupplierGet } from '../supply';

const SCOTT = 'did:imajin:scott';

function req(body: unknown, searchParams?: Record<string, string>): NextRequest {
  const url = searchParams
    ? `https://kernel.test/supply/api/lots?${new URLSearchParams(searchParams).toString()}`
    : 'https://kernel.test/supply/api/lots';
  return { json: async () => body, url } as unknown as NextRequest;
}

function grantWrite() {
  requireAppAuthMock.mockResolvedValue({ appAuth: { appDid: 'did:app', userDid: SCOTT, scopes: ['supply:write'] } });
}

beforeEach(() => {
  requireAppAuthMock.mockReset();
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  getLotChainMock.mockReset();
  recentLotsBySupplierMock.mockReset();
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

describe('publishReceiptStage (#1384)', () => {
  const DAVID = 'did:imajin:david';

  function grantWriteAs(did: string) {
    requireAppAuthMock.mockResolvedValue({ appAuth: { appDid: 'did:app', userDid: did, scopes: ['supply:write'] } });
  }

  it('publishes supply.received pinned to the recipient DID', async () => {
    grantWriteAs(DAVID);
    const res = await publishReceiptStage(
      req({ lotId: 'lot_eggs_1', commodity: 'eggs', quantity: 12, unit: 'dozen' }),
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.stage).toBe('received');
    expect(json.correlationId).toBe('lot_eggs_1');

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [type, event] = publishMock.mock.calls[0];
    expect(type).toBe('supply.received');
    expect(event.issuer).toBe(DAVID);
    expect(event.correlationId).toBe('lot_eggs_1');
    expect(event.payload.recipientDid).toBe(DAVID);
    expect(event.payload.commodity).toBe('eggs');
  });

  it('requires lotId (no minting — receipt always threads an existing lot)', async () => {
    grantWriteAs(DAVID);
    const res = await publishReceiptStage(
      req({ commodity: 'eggs', quantity: 12, unit: 'dozen' }),
    );
    expect(res.status).toBe(400);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('validates required payload fields', async () => {
    grantWriteAs(DAVID);
    const res = await publishReceiptStage(req({ lotId: 'lot_1', commodity: 'eggs' }));
    expect(res.status).toBe(400);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('threads priorCid when provided', async () => {
    grantWriteAs(DAVID);
    await publishReceiptStage(
      req({ lotId: 'lot_eggs_1', commodity: 'eggs', quantity: 12, unit: 'dozen', priorCid: 'bafy-listed' }),
    );
    const [, event] = publishMock.mock.calls[0];
    expect(event.payload.priorCid).toBe('bafy-listed');
  });

  it('returns 401 when app-auth fails', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    const res = await publishReceiptStage(req({ lotId: 'lot_1', commodity: 'eggs', quantity: 12, unit: 'dozen' }));
    expect(res.status).toBe(401);
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

describe('handleLotsBySupplierGet (#1435)', () => {
  function grantRead() {
    requireAppAuthMock.mockResolvedValue({ appAuth: { appDid: 'did:app', userDid: SCOTT, scopes: ['supply:read'] } });
  }

  it('returns lots newest-first for a supply:read caller', async () => {
    grantRead();
    const lots = [
      { correlationId: 'lot_2', originatingDid: SCOTT, commodity: 'eggs', status: 'listed', createdAt: 't2', updatedAt: 't3' },
      { correlationId: 'lot_1', originatingDid: SCOTT, commodity: 'eggs', status: 'declared', createdAt: 't0', updatedAt: 't1' },
    ];
    recentLotsBySupplierMock.mockResolvedValue(lots);

    const res = await handleLotsBySupplierGet(req({}, { supplier: SCOTT, limit: '2' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lots).toHaveLength(2);
    expect(json.lots[0].correlationId).toBe('lot_2');
    expect(recentLotsBySupplierMock).toHaveBeenCalledWith(SCOTT, 2);
  });

  it('returns empty lots array when supplier has no lots', async () => {
    grantRead();
    recentLotsBySupplierMock.mockResolvedValue([]);

    const res = await handleLotsBySupplierGet(req({}, { supplier: 'did:imajin:unknown' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lots).toEqual([]);
  });

  it('returns 400 when the supplier query param is missing', async () => {
    grantRead();
    const res = await handleLotsBySupplierGet(req({}));
    expect(res.status).toBe(400);
    expect(recentLotsBySupplierMock).not.toHaveBeenCalled();
  });

  it('returns 401 when app-auth fails and never reads', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    const res = await handleLotsBySupplierGet(req({}, { supplier: SCOTT }));
    expect(res.status).toBe(401);
    expect(recentLotsBySupplierMock).not.toHaveBeenCalled();
  });
});
