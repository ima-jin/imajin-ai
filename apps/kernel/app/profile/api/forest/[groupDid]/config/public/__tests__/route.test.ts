import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));
vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));
vi.mock('@imajin/config', () => ({
  SERVICES: [
    { name: 'pay', category: 'kernel', visibility: 'authenticated' },
    { name: 'media', category: 'kernel', visibility: 'authenticated' },
    { name: 'hidden-kernel', category: 'kernel', visibility: 'internal' },
    { name: 'private-app', category: 'core', visibility: 'public' },
  ],
}));

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = vi.fn(self);
  chain.where = vi.fn(self);
  chain.limit = vi.fn(async () => result);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
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
  registryApps: { slug: 'app_slug', status: 'app_status', visibility: 'app_visibility' },
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { GET } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GROUP_DID = 'did:imajin:forest-group';

function makeParams(groupDid: string) {
  return { params: Promise.resolve({ groupDid }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockDbSelect.mockImplementation(() => makeSelectChain([{ slug: 'coffee' }]));
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
    expect(mockDbSelect).toHaveBeenCalledOnce();
  });
  it('queries only active public registry apps without leaking hidden, retired or unknown names', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([{
      enabledServices: ['pay', 'media', 'coffee', 'private-app', 'unlisted-app', 'internal-app', 'retired-app', 'unknown-app', 'hidden-kernel'],
      landingService: 'private-app', scopeFeeBps: 40,
    }]));
    const appChain = makeSelectChain([{ slug: 'coffee' }]);
    mockDbSelect.mockImplementationOnce(() => appChain);
    const res = await GET({} as never, makeParams(GROUP_DID));
    expect(appChain.where).toHaveBeenCalledWith({
      and: [{ eq: ['app_status', 'active'] }, { eq: ['app_visibility', 'public'] }],
    });
    expect(await res.json()).toEqual({
      enabledServices: ['pay', 'media', 'coffee'], landingService: null, scopeFeeBps: 40,
    });
  });
  it('preserves a visible kernel landing service without changing app/web permissions', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([{
      enabledServices: ['pay'], landingService: 'pay', scopeFeeBps: 0,
    }]));
    expect(await (await GET({} as never, makeParams(GROUP_DID))).json()).toEqual({
      enabledServices: ['pay'], landingService: 'pay', scopeFeeBps: 0,
    });
  });
  it('clears a landing service not in the projected enabled list', async () => {
    mockDbSelect.mockImplementationOnce(() => makeSelectChain([{
      enabledServices: ['media'], landingService: 'coffee', scopeFeeBps: null,
    }]));
    expect(await (await GET({} as never, makeParams(GROUP_DID))).json()).toEqual({
      enabledServices: ['media'], landingService: null, scopeFeeBps: null,
    });
  });
});
