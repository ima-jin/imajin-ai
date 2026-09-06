/**
 * Tests for apps/market/app/api/listings/route.ts (POST)
 *
 * See apps/coffee/app/api/pages/__tests__/route.test.ts for the rationale:
 * these exercise the getNodeSelf() → buildFairManifest() branches (#2000)
 * through the real POST handler and the real (unmocked) buildFairManifest.
 *
 * Shared mock plumbing and .fair chain fixtures/assertions live in
 * packages/fair/src/test-helpers.ts — see that file for why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveActingDidMock,
  passthroughMediaRefFactory,
  jsonResponseMock,
  errorResponseMock,
  makeJsonRequest,
  echoLastInsertedValue,
  itDrivesFairManifestFromNodeSelf,
  type FairChainEntry,
} from '../../../../../../packages/fair/src/test-helpers';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.hoisted() runs before regular imports are live, so its callback can
// only reference other vi.hoisted()/vi.mock() values — the shared
// createInsertChainMocks() helper is used elsewhere but not here.
const mocks = vi.hoisted(() => {
  const returningMock = vi.fn();
  const valuesMock = vi.fn(() => ({ returning: returningMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));

  const requireAuthMock = vi.fn();
  const getSessionMock = vi.fn().mockResolvedValue(null);
  const getNodeSelfMock = vi.fn();
  const publishMock = vi.fn().mockResolvedValue(undefined);
  // Forest scope-fee lookup (#2001, /api/forest/{groupDid}/config/public) —
  // only reached when actingAs is set, unrelated to the getNodeSelf() chain tests.
  const getForestScopeConfigMock = vi.fn().mockResolvedValue(null);

  return { returningMock, valuesMock, insertMock, requireAuthMock, getSessionMock, getNodeSelfMock, publishMock, getForestScopeConfigMock };
});

vi.mock('@/db', () => ({
  db: { insert: mocks.insertMock },
  listings: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  getSession: mocks.getSessionMock,
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
  generateId: (prefix: string) => `${prefix}_test123`,
  jsonResponse: jsonResponseMock,
  errorResponse: errorResponseMock,
}));

// buildFairManifest (@imajin/fair) is intentionally NOT mocked.

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return makeJsonRequest('https://market.test/api/listings', 'POST', body) as Parameters<typeof POST>[0];
}

const VALID_BODY = {
  title: 'Vintage Chair',
  price: 5000,
  contactInfo: { email: 'seller@example.com' },
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/listings (#2000: node config sourced via getNodeSelf())', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getForestScopeConfigMock.mockReset().mockResolvedValue(null);
    mocks.publishMock.mockResolvedValue(undefined);
    mocks.returningMock.mockImplementation(echoLastInsertedValue(mocks.valuesMock));
    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:seller', actingAs: null },
    });
  });

  itDrivesFairManifestFromNodeSelf({
    getNodeSelfMock: mocks.getNodeSelfMock,
    callRoute: () => POST(makeRequest(VALID_BODY)),
    getChain: (body) => (body.fairManifest as { chain: FairChainEntry[] }).chain,
  });

  it('applies the forest group scope fee to the .fair manifest when acting as a scope (#2001)', async () => {
    mocks.getNodeSelfMock.mockResolvedValue(null);
    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:seller', actingAs: 'did:imajin:forest-group' },
    });
    mocks.getForestScopeConfigMock.mockResolvedValue({ scopeFeeBps: 40 });

    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mocks.getForestScopeConfigMock).toHaveBeenCalledWith('did:imajin:forest-group');

    const body = await res.json();
    const chain = (body.fairManifest as { chain: FairChainEntry[] }).chain;
    expect(chain.find((entry) => entry.role === 'scope')).toMatchObject({
      did: 'did:imajin:forest-group',
      share: 0.004,
    });
  });
});
