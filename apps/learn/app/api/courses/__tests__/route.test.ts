/**
 * Tests for apps/learn/app/api/courses/route.ts (POST)
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
  REGISTRY_NODE_SELF,
  expectRegistrySourcedShares,
  expectDefaultShares,
  resolveActingDidMock,
  jsonResponseMock,
  errorResponseMock,
  makeJsonRequest,
  itAppliesForestScopeFee,
  FOREST_SCOPE_DID,
} from '../../../../../../packages/fair/src/test-helpers';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.hoisted() runs before regular imports are live, so its callback can
// only reference other vi.hoisted()/vi.mock() values — the shared
// createInsertChainMocks() helper is used elsewhere but not here.
const mocks = vi.hoisted(() => {
  const limitMock = vi.fn().mockResolvedValue([]);
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));

  const requireHardDIDMock = vi.fn();
  const getNodeSelfMock = vi.fn();
  // Forest scope-fee lookup (#2001, /api/forest/{groupDid}/config/public) —
  // only reached when actingAs is set, unrelated to the getNodeSelf() chain tests.
  const getForestScopeConfigMock = vi.fn().mockResolvedValue(null);

  return { limitMock, whereMock, fromMock, selectMock, insertValuesMock, insertMock, requireHardDIDMock, getNodeSelfMock, getForestScopeConfigMock };
});

vi.mock('@/db', () => ({
  db: {
    select: mocks.selectMock,
    insert: mocks.insertMock,
  },
}));

vi.mock('@/db/schema', () => ({
  courses: { id: 'col_id', slug: 'col_slug' },
  modules: {},
  lessons: {},
}));

vi.mock('@imajin/auth', () => ({
  requireHardDID: mocks.requireHardDIDMock,
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@imajin/config', () => ({
  getNodeSelf: mocks.getNodeSelfMock,
  getForestScopeConfig: mocks.getForestScopeConfigMock,
}));

vi.mock('@/lib/utils', () => ({
  generateId: (prefix: string) => `${prefix}_test123`,
  slugify: (text: string) => text.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  jsonResponse: jsonResponseMock,
  errorResponse: errorResponseMock,
}));

// buildFairManifest (@imajin/fair) is intentionally NOT mocked.

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return makeJsonRequest('https://learn.test/api/courses', 'POST', body) as Parameters<typeof POST>[0];
}

const VALID_BODY = { title: 'Intro to Testing' };

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/courses (#2000: node config sourced via getNodeSelf())', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limitMock.mockReset().mockResolvedValue([]);
    mocks.insertValuesMock.mockReset().mockResolvedValue(undefined);
    mocks.getForestScopeConfigMock.mockReset().mockResolvedValue(null);
    mocks.requireHardDIDMock.mockResolvedValue({
      identity: { id: 'did:imajin:creator', actingAs: null },
    });
  });

  it('uses the registry-sourced fee config in the persisted .fair manifest', async () => {
    mocks.getNodeSelfMock.mockResolvedValue(REGISTRY_NODE_SELF);

    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mocks.getNodeSelfMock).toHaveBeenCalled();

    const body = await res.json();
    expectRegistrySourcedShares(body.metadata.fair.chain);
  });

  it('falls back to .fair defaults when the registry is unavailable (getNodeSelf() → null)', async () => {
    mocks.getNodeSelfMock.mockResolvedValue(null);

    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);

    const body = await res.json();
    expectDefaultShares(body.metadata.fair.chain);
  });

  itAppliesForestScopeFee({
    getForestScopeConfigMock: mocks.getForestScopeConfigMock,
    arrange: () => {
      mocks.getNodeSelfMock.mockResolvedValue(null);
      mocks.requireHardDIDMock.mockResolvedValue({
        identity: { id: 'did:imajin:creator', actingAs: FOREST_SCOPE_DID },
      });
    },
    callRoute: () => POST(makeRequest(VALID_BODY)),
    getChain: (body) => (body.metadata as { fair: { chain: { did: string; role: string; share: number }[] } }).fair.chain,
  });
});
