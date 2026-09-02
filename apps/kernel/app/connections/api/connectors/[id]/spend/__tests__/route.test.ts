import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveEffectiveDid, mockGetConnector, mockReadConnectorRegistration, mockReadInferenceBurnDown } = vi.hoisted(() => ({
  mockResolveEffectiveDid: vi.fn(),
  mockGetConnector: vi.fn(),
  mockReadConnectorRegistration: vi.fn(),
  mockReadInferenceBurnDown: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  resolveEffectiveDid: mockResolveEffectiveDid,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/kernel/connector-registry', () => ({
  getConnector: mockGetConnector,
}));

vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  connectorRegistryId: (ownerDid: string, provider: string) => `conn_${ownerDid}_${provider}`,
  readConnectorRegistration: mockReadConnectorRegistration,
}));

vi.mock('@/src/lib/inference/inference-burn-down', () => ({
  readInferenceBurnDown: mockReadInferenceBurnDown,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';
const XAI_ENTRY = { id: 'xai' };

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(url: string): RouteRequest {
  return { headers: new Headers(), url } as unknown as RouteRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConnector.mockReturnValue(XAI_ENTRY);
  mockResolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: OWNER_DID, via: 'session', composedBy: null });
  mockReadConnectorRegistration.mockResolvedValue(undefined);
  mockReadInferenceBurnDown.mockResolvedValue({
    connectorId: `conn_${OWNER_DID}_xai`,
    provider: 'xai',
    ownerDid: OWNER_DID,
    spendCap: null,
    spentUsd: 0,
    totalCostUsd: 0,
    totalCallCount: 0,
    bySession: [],
    byTurn: [],
    byAgent: [],
  });
});

describe('GET /connections/api/connectors/[id]/spend (#1923)', () => {
  it('404s for a connector id that is not one of the brain connectors', async () => {
    mockGetConnector.mockReturnValue({ id: 'github' });

    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/github/spend'), makeParams('github'));

    expect(res.status).toBe(404);
    expect(mockResolveEffectiveDid).not.toHaveBeenCalled();
  });

  it('404s for a genuinely unknown connector id', async () => {
    mockGetConnector.mockReturnValue(undefined);

    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/nope/spend'), makeParams('nope'));

    expect(res.status).toBe(404);
  });

  it('requires the infer:usage-read scope and fails closed on auth failure', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce({ ok: false, status: 401, error: 'Unauthorized' });

    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/xai/spend'), makeParams('xai'));

    expect(res.status).toBe(401);
    expect(mockReadInferenceBurnDown).not.toHaveBeenCalled();
    expect(mockResolveEffectiveDid).toHaveBeenCalledWith(expect.anything(), { scope: 'infer:usage-read' });
  });

  it('reads the burn-down for the callers own registration, computing a connector id when none exists yet', async () => {
    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/xai/spend'), makeParams('xai'));

    expect(res.status).toBe(200);
    expect(mockReadConnectorRegistration).toHaveBeenCalledWith(OWNER_DID, 'xai');
    expect(mockReadInferenceBurnDown).toHaveBeenCalledWith(`conn_${OWNER_DID}_xai`, 'xai', OWNER_DID, undefined);
  });

  it('uses the real registration row id when one exists', async () => {
    mockReadConnectorRegistration.mockResolvedValueOnce({ id: 'conn_real_row', spendCap: null });

    await GET(makeReq('https://kernel.test/connections/api/connectors/xai/spend'), makeParams('xai'));

    expect(mockReadInferenceBurnDown).toHaveBeenCalledWith('conn_real_row', 'xai', OWNER_DID, { id: 'conn_real_row', spendCap: null });
  });

  it('returns 500 without leaking the underlying failure when the burn-down query throws', async () => {
    mockReadInferenceBurnDown.mockRejectedValueOnce(new Error('connection reset'));

    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/xai/spend'), makeParams('xai'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Inference burn-down unavailable' });
  });

  it('marks the response as no-store', async () => {
    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/xai/spend'), makeParams('xai'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq('https://kernel.test/connections/api/connectors/xai/spend'));
    expect(res.status).toBe(204);
  });
});
