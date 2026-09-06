import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  return chain;
}

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
  forestConfig: {
    enabledServices: 'enabled_services',
    landingService: 'landing_service',
    scopeFeeBps: 'scope_fee_bps',
    groupDid: 'group_did',
  },
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { GET } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GROUP_DID = 'did:imajin:forest-group';

function makeParams(groupDid: string) {
  return { params: Promise.resolve({ groupDid }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /profile/api/forest/[groupDid]/config/public (#2001: scopeFeeBps parity)', () => {
  it('includes scopeFeeBps alongside enabledServices/landingService for a configured group', async () => {
    mockDbSelect.mockImplementationOnce(() =>
      makeSelectChain([{ enabledServices: ['coffee'], landingService: 'coffee', scopeFeeBps: 40 }])
    );

    const res = await GET({} as never, makeParams(GROUP_DID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ enabledServices: ['coffee'], landingService: 'coffee', scopeFeeBps: 40 });
  });

  it('defaults scopeFeeBps to null for an unconfigured group, no auth required', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([]));

    const res = await GET({} as never, makeParams(GROUP_DID));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ enabledServices: [], landingService: null, scopeFeeBps: null });
  });
});
