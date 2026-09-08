/**
 * Tests for apps/coffee/app/api/pages/route.ts
 *
 * Focus: the #2000 registry migration replaced a raw `relay.relay_config`
 * SELECT with `getNodeSelf()` (from @imajin/config). These tests exercise
 * both branches of `nodeSelf?.field ?? undefined` through the real POST
 * handler and the real (unmocked) `buildFairManifest`, so the resulting
 * `.fair` chain is asserted end-to-end rather than just unit-testing
 * `getNodeSelf()` in isolation.
 *
 * Shared mock plumbing and .fair chain fixtures/assertions live in
 * packages/fair/src/test-helpers.ts — see that file for why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  silentLoggerFactory,
  resolveActingDidMock,
  jsonResponseMock,
  errorResponseMock,
  makeJsonRequest,
  echoLastInsertedValue,
  itDrivesFairManifestFromNodeSelf,
  itAppliesForestScopeFee,
  type FairChainEntry,
} from '../../../../../../packages/fair/src/test-helpers';

// ─── Mocks ────────────────────────────────────────────────────────────────

// vi.hoisted() runs before regular imports are live, so its callback can
// only reference other vi.hoisted()/vi.mock() values — the shared
// createInsertChainMocks() helper is used elsewhere but not here.
const mocks = vi.hoisted(() => {
  const returningMock = vi.fn();
  const valuesMock = vi.fn(() => ({ returning: returningMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  const findFirstMock = vi.fn();
  const requireAuthMock = vi.fn();
  const getNodeSelfMock = vi.fn();
  // Forest scope-fee lookup (#2001, /api/forest/{groupDid}/config/public) —
  // only reached when actingAs is set, unrelated to the getNodeSelf() chain tests.
  const getForestScopeConfigMock = vi.fn().mockResolvedValue(null);

  return { findFirstMock, returningMock, valuesMock, insertMock, requireAuthMock, getNodeSelfMock, getForestScopeConfigMock };
});

vi.mock('@imajin/logger', () => silentLoggerFactory());

vi.mock('@/db', () => ({
  db: {
    query: { coffeePages: { findFirst: mocks.findFirstMock } },
    insert: mocks.insertMock,
  },
  coffeePages: {},
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@imajin/config', () => ({
  getNodeSelf: mocks.getNodeSelfMock,
  getForestScopeConfig: mocks.getForestScopeConfigMock,
}));

vi.mock('@/lib/utils', () => ({
  jsonResponse: jsonResponseMock,
  errorResponse: errorResponseMock,
  isValidHandle: (handle: string) => /^[a-z0-9_]{3,30}$/.test(handle),
  generateId: (prefix: string) => `${prefix}_test123`,
}));

// buildFairManifest (@imajin/fair) is intentionally NOT mocked — the whole
// point of these tests is to prove nodeSelf's fields really flow into the
// manifest the route persists.

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return makeJsonRequest('https://coffee.test/api/pages', 'POST', body) as Parameters<typeof POST>[0];
}

const VALID_BODY = {
  handle: 'creator_handle',
  title: 'My Coffee Page',
  paymentMethods: { stripe: { enabled: true } },
};

const callRoute = () => POST(makeRequest(VALID_BODY));
const getChain = (body: Record<string, unknown>) => (body.fairManifest as { chain: FairChainEntry[] }).chain;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/pages (#2000: node config sourced via getNodeSelf())', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirstMock.mockReset().mockResolvedValue(undefined);
    mocks.getForestScopeConfigMock.mockReset().mockResolvedValue(null);
    mocks.returningMock.mockImplementation(echoLastInsertedValue(mocks.valuesMock));
    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:creator', actingAs: null },
    });
  });

  // Direct, literal assertion (rather than only delegating to the shared
  // itDrivesFairManifestFromNodeSelf/itAppliesForestScopeFee helpers below)
  // so this file itself is recognized as containing test cases — those
  // helpers register their own real it() cases, but only inside
  // packages/fair/src/test-helpers.ts, not textually in this file. Also a
  // real validation gap neither helper covers: the route's own required-field
  // guard, exercised before any getNodeSelf()/DB call.
  it('rejects a request missing the required handle field, before touching the database', async () => {
    const res = await POST(makeRequest({ title: 'My Coffee Page', paymentMethods: { stripe: { enabled: true } } }));

    expect(res.status).toBe(400);
    expect(mocks.getNodeSelfMock).not.toHaveBeenCalled();
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  itDrivesFairManifestFromNodeSelf({
    getNodeSelfMock: mocks.getNodeSelfMock,
    callRoute,
    getChain,
  });

  itAppliesForestScopeFee({
    getForestScopeConfigMock: mocks.getForestScopeConfigMock,
    getNodeSelfMock: mocks.getNodeSelfMock,
    authMock: mocks.requireAuthMock,
    callerId: 'did:imajin:creator',
    callRoute,
    getChain,
  });
});
