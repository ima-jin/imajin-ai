import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, operator, latest, preflight } = vi.hoisted(() => ({
  auth: vi.fn(), operator: vi.fn(), latest: vi.fn(), preflight: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({ requireAuth: auth }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://test.imajin.ai' }),
  corsOptions: preflight,
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: vi.fn() }));
vi.mock('@/src/lib/notify/operator-approvals', async (original) => ({
  ...await original<typeof import('@/src/lib/notify/operator-approvals')>(),
  getOperatorDid: operator,
}));
vi.mock('@/src/lib/loops/query', () => ({ getLastStepEventAt: latest }));

import { dynamic, GET, OPTIONS } from '../route';

const DID = 'did:imajin:operator';
const request = (query = '') => new Request(
  `https://test.imajin.ai/jin/api/runs/horizon-status${query}`,
) as Parameters<typeof GET>[0];

function expectHeaders(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://test.imajin.ai');
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ identity: { id: DID } });
  operator.mockResolvedValue(DID);
  latest.mockResolvedValue(null);
  preflight.mockReturnValue(new Response(null, { status: 204 }));
});

describe('Horizon status operator adapter', () => {
  it('is dynamic and delegates OPTIONS without authentication or registry reads', async () => {
    const req = request();
    expect(dynamic).toBe('force-dynamic');
    expect((await OPTIONS(req)).status).toBe(204);
    expect(preflight).toHaveBeenCalledWith(req);
    expect(auth).not.toHaveBeenCalled();
    expect(operator).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])('preserves auth error status %s before any operator or registry lookup', async (status) => {
    auth.mockResolvedValue({ error: 'Authentication unavailable', status });
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'Authentication unavailable' });
    expectHeaders(response);
    expect(operator).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'did:imajin:other' },
    { id: 'did:imajin:jin', actingFor: DID },
    { id: DID, actingFor: 'did:imajin:other' },
    { id: DID, actingFor: DID },
  ])('hides status without registry reads for nonoperator/delegated identity %j', async (identity) => {
    auth.mockResolvedValue({ identity });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isOperator: false, lastStepEventAt: null });
    expectHeaders(response);
    expect(latest).not.toHaveBeenCalled();
  });

  it('hides status when no node operator is configured, without registry reads', async () => {
    operator.mockResolvedValue(null);
    const response = await GET(request());
    expect(await response.json()).toEqual({ isOperator: false, lastStepEventAt: null });
    expectHeaders(response);
    expect(latest).not.toHaveBeenCalled();
  });

  it.each([null, '2026-10-16T12:00:00.000Z'])('returns operator status %s scoped only to the gated DID', async (at) => {
    latest.mockImplementation(async (principal) => {
      expect(auth).toHaveBeenCalledOnce();
      expect(operator).toHaveBeenCalledOnce();
      expect(principal).toBe(DID);
      return at;
    });
    const response = await GET(request('?principal=did:imajin:other'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isOperator: true, lastStepEventAt: at });
    expectHeaders(response);
    expect(latest).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenCalledWith(DID);
  });

  it.each(['auth', 'operator', 'registry'])('sanitizes thrown %s failures', async (source) => {
    const error = new Error('private database or authentication details');
    if (source === 'auth') auth.mockRejectedValue(error);
    if (source === 'operator') operator.mockRejectedValue(error);
    if (source === 'registry') latest.mockRejectedValue(error);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Horizon status unavailable' });
    expectHeaders(response);
    if (source !== 'registry') expect(latest).not.toHaveBeenCalled();
    if (source === 'auth') expect(operator).not.toHaveBeenCalled();
  });
});
