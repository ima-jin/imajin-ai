/**
 * Tests for apps/market/app/api/listings/[id]/route.ts (PATCH)
 *
 * See apps/coffee/app/api/pages/__tests__/route.test.ts for the rationale:
 * these exercise the getNodeSelf() → buildFairManifest() branches (#2000)
 * through the real PATCH handler and the real (unmocked) buildFairManifest,
 * specifically the price-change path that recalculates the .fair manifest.
 *
 * Shared mock plumbing and .fair chain fixtures/assertions live in
 * packages/fair/src/test-helpers.ts — see that file for why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  REGISTRY_NODE_SELF,
  expectRegistrySourcedShares,
  expectDefaultShares,
  resolveActingDidMock,
  passthroughMediaRefFactory,
  jsonResponseMock,
  errorResponseMock,
  makeJsonRequest,
} from '../../../../../../../packages/fair/src/test-helpers';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.hoisted() runs before regular imports are live, so its callback can
// only reference other vi.hoisted()/vi.mock() values.
const mocks = vi.hoisted(() => {
  const selectWhereMock = vi.fn();
  const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
  const selectMock = vi.fn(() => ({ from: selectFromMock }));

  const updateReturningMock = vi.fn();
  const updateWhereMock = vi.fn(() => ({ returning: updateReturningMock }));
  const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn(() => ({ set: updateSetMock }));

  const requireAuthMock = vi.fn();
  const getNodeSelfMock = vi.fn();
  const publishMock = vi.fn().mockResolvedValue(undefined);
  // Forest scope-fee lookup (#2001, /api/forest/{groupDid}/config/public) —
  // only reached when actingAs is set, unrelated to the getNodeSelf() chain tests.
  const getForestScopeConfigMock = vi.fn().mockResolvedValue(null);

  return {
    selectWhereMock, selectFromMock, selectMock,
    updateReturningMock, updateWhereMock, updateSetMock, updateMock,
    requireAuthMock, getNodeSelfMock, publishMock, getForestScopeConfigMock,
  };
});

vi.mock('@/db', () => ({
  db: { select: mocks.selectMock, update: mocks.updateMock },
  listings: { id: 'col_id' },
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  getSession: vi.fn().mockResolvedValue(null),
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@imajin/media', () => passthroughMediaRefFactory());

vi.mock('@imajin/config', () => ({
  getNodeSelf: mocks.getNodeSelfMock,
  getForestScopeConfig: mocks.getForestScopeConfigMock,
}));

vi.mock('@imajin/bus', () => ({
  publish: mocks.publishMock,
}));

vi.mock('@/lib/utils', () => ({
  jsonResponse: jsonResponseMock,
  errorResponse: errorResponseMock,
}));

// buildFairManifest (@imajin/fair) is intentionally NOT mocked.

// ─── Subject ────────────────────────────────────────────────────────────────

import { PATCH } from '../route';

// ─── Helpers ────────────────────────────────────────────────────────────────

const ROUTE_PARAMS = { params: Promise.resolve({ id: 'lst_1' }) };

function makeRequest(body: Record<string, unknown>): Parameters<typeof PATCH>[0] {
  return makeJsonRequest('https://market.test/api/listings/lst_1', 'PATCH', body) as Parameters<typeof PATCH>[0];
}

const EXISTING_LISTING = {
  id: 'lst_1',
  sellerDid: 'did:imajin:seller',
  price: 3000,
  status: 'active',
  sellerTier: 'public_offplatform',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PATCH /api/listings/:id (#2000: node config sourced via getNodeSelf())', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getForestScopeConfigMock.mockReset().mockResolvedValue(null);
    mocks.publishMock.mockResolvedValue(undefined);
    mocks.selectWhereMock.mockReset().mockResolvedValue([EXISTING_LISTING]);
    mocks.updateReturningMock.mockImplementation(async () => [mocks.updateSetMock.mock.calls.at(-1)?.[0]]);
    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:seller', actingAs: null },
    });
  });

  it('recalculates the .fair manifest with the registry-sourced fee config when price changes', async () => {
    mocks.getNodeSelfMock.mockResolvedValue(REGISTRY_NODE_SELF);

    const res = await PATCH(makeRequest({ price: 5000 }), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect(mocks.getNodeSelfMock).toHaveBeenCalled();

    const body = await res.json();
    expectRegistrySourcedShares(body.fairManifest.chain);
  });

  it('falls back to .fair defaults when the registry is unavailable (getNodeSelf() → null)', async () => {
    mocks.getNodeSelfMock.mockResolvedValue(null);

    const res = await PATCH(makeRequest({ price: 5000 }), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    const body = await res.json();
    expectDefaultShares(body.fairManifest.chain);
  });

  it('does not recalculate the .fair manifest (and does not call getNodeSelf) when price/tier/seller are unchanged', async () => {
    const res = await PATCH(makeRequest({ title: 'New title only' }), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect(mocks.getNodeSelfMock).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.fairManifest).toBeUndefined();
  });

  it('applies the forest group scope fee to the .fair manifest when acting as a scope (#2001)', async () => {
    mocks.getNodeSelfMock.mockResolvedValue(null);
    // resolveActingDidMock resolves the caller to actingAs, so the listing's
    // sellerDid must match it for the route's `sellerDid === currentDid` scope
    // check (no scope fee if the acting identity doesn't own the listing).
    mocks.selectWhereMock.mockResolvedValue([{ ...EXISTING_LISTING, sellerDid: 'did:imajin:forest-group' }]);
    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:seller', actingAs: 'did:imajin:forest-group' },
    });
    mocks.getForestScopeConfigMock.mockResolvedValue({ scopeFeeBps: 40 });

    const res = await PATCH(makeRequest({ price: 5000 }), ROUTE_PARAMS);
    expect(res.status).toBe(200);
    expect(mocks.getForestScopeConfigMock).toHaveBeenCalledWith('did:imajin:forest-group');

    const body = await res.json();
    const chain = body.fairManifest.chain as { did: string; role: string; share: number }[];
    expect(chain.find((entry) => entry.role === 'scope')).toMatchObject({
      did: 'did:imajin:forest-group',
      share: 0.004,
    });
  });
});
