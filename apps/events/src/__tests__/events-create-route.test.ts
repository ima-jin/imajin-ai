/**
 * Tests for apps/events/app/api/events/route.ts (POST)
 *
 * See apps/coffee/app/api/pages/__tests__/route.test.ts for the rationale:
 * these exercise the getNodeSelf() → buildFairManifest() branches (#2000)
 * through the real POST handler and the real (unmocked) buildFairManifest.
 *
 * Real, unmocked: @noble/ed25519 / @noble/hashes signing (fast, no network),
 * node:crypto randomBytes, and buildFairManifest. Mocked: the DID-registration
 * fetch() to the auth service, db, bus, and getNodeSelf() itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const returningMock = vi.fn();
  const valuesMock = vi.fn(() => ({ returning: returningMock }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));

  const requireHardDIDMock = vi.fn();
  const requireAppAuthMock = vi.fn();
  const getNodeSelfMock = vi.fn();
  const publishMock = vi.fn().mockResolvedValue(undefined);
  // Forest scope-fee lookup (#2001, /api/forest/{groupDid}/config/public) —
  // only reached when actingAs is set, unrelated to the getNodeSelf() chain tests.
  const getForestScopeConfigMock = vi.fn().mockResolvedValue(null);

  return { returningMock, valuesMock, insertMock, requireHardDIDMock, requireAppAuthMock, getNodeSelfMock, publishMock, getForestScopeConfigMock };
});

function createStubLog() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

vi.mock('@imajin/logger', () => ({
  // Test double matching apps/kernel/app/connections/api/invites/__tests__/route.test.ts:
  // skip correlation-id/timing plumbing and just invoke the handler directly.
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: ReturnType<typeof createStubLog>; correlationId: string }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: createStubLog(), correlationId: 'cor_test' }),
}));

vi.mock('@/src/db', () => ({
  db: { insert: mocks.insertMock },
  events: {},
  ticketTypes: {},
}));

vi.mock('@imajin/auth', () => ({
  requireHardDID: mocks.requireHardDIDMock,
  requireAppAuth: mocks.requireAppAuthMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => new Headers(),
  getNodeSelf: mocks.getNodeSelfMock,
  getForestScopeConfig: mocks.getForestScopeConfigMock,
}));

vi.mock('@imajin/bus', () => ({
  publish: mocks.publishMock,
}));

// buildFairManifest (@imajin/fair) is intentionally NOT mocked.

// ─── Subject ────────────────────────────────────────────────────────────────

import { POST } from '../../app/api/events/route';
import {
  REGISTRY_NODE_SELF,
  expectRegistrySourcedShares,
  expectDefaultShares,
  itAppliesForestScopeFee,
  type FairChainEntry,
} from '../../../../packages/fair/src/test-helpers';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(body: Record<string, unknown>): Parameters<typeof POST>[0] {
  return new Request('https://events.test/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}

const VALID_BODY = { title: 'Test Meetup', startsAt: '2026-12-01T18:00:00.000Z' };
const callRoute = () => POST(makeRequest(VALID_BODY));
const getChain = (body: Record<string, unknown>) => (body.event as { metadata: { fair: { chain: FairChainEntry[] } } }).metadata.fair.chain;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/events (#2000: node config sourced via getNodeSelf())', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ did: 'did:imajin:event123' }),
    }));

    mocks.getForestScopeConfigMock.mockReset().mockResolvedValue(null);
    mocks.publishMock.mockResolvedValue(undefined);
    mocks.returningMock.mockImplementation(async () => {
      const inserted = mocks.valuesMock.mock.calls.at(-1)?.[0];
      return [inserted];
    });
    mocks.requireHardDIDMock.mockResolvedValue({
      identity: { id: 'did:imajin:creator', actingAs: null },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the registry-sourced fee config in the persisted .fair manifest', async () => {
    mocks.getNodeSelfMock.mockResolvedValue(REGISTRY_NODE_SELF);

    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mocks.getNodeSelfMock).toHaveBeenCalled();

    const body = await res.json();
    expectRegistrySourcedShares(body.event.metadata.fair.chain);
  });

  it('falls back to .fair defaults when the registry is unavailable (getNodeSelf() → null)', async () => {
    mocks.getNodeSelfMock.mockResolvedValue(null);

    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);

    const body = await res.json();
    expectDefaultShares(body.event.metadata.fair.chain);
  });

  itAppliesForestScopeFee({
    getForestScopeConfigMock: mocks.getForestScopeConfigMock,
    getNodeSelfMock: mocks.getNodeSelfMock,
    authMock: mocks.requireHardDIDMock,
    callerId: 'did:imajin:creator',
    callRoute,
    getChain,
  });
});
