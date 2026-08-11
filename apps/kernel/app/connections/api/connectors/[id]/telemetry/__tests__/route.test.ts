import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveEffectiveDid, mockGetConnector, mockReadTelemetry } = vi.hoisted(() => ({
  mockResolveEffectiveDid: vi.fn(),
  mockGetConnector: vi.fn(),
  mockReadTelemetry: vi.fn(),
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

vi.mock('@/src/lib/kernel/connector-telemetry', () => ({
  readConnectorTelemetry: mockReadTelemetry,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { GET, OPTIONS } from '../route';

const OWNER_DID = 'did:imajin:owner';
const OTHER_DID = 'did:imajin:someone-else';

const GITHUB_ENTRY = { id: 'github', channel: 'github', scopes: [{ name: 'github:read', label: 'Read', releaseClass: 'silent' }] };

type RouteRequest = Parameters<typeof GET>[0];

function makeReq(url: string): RouteRequest {
  return { headers: new Headers(), url } as unknown as RouteRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConnector.mockReturnValue(GITHUB_ENTRY);
  mockResolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: OWNER_DID, via: 'session', composedBy: null });
  mockReadTelemetry.mockResolvedValue({
    connectorId: 'github',
    ownerDid: OWNER_DID,
    consumerDid: null,
    scopes: ['github:read'],
    totalCount: 0,
    byKind: [],
    firstSeenAt: null,
    lastSeenAt: null,
  });
});

describe('GET /connections/api/connectors/[id]/telemetry (#1799)', () => {
  it('404s for an unknown connector before doing any auth or DB work', async () => {
    mockGetConnector.mockReturnValue(undefined);

    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/nope/telemetry'), makeParams('nope'));

    expect(res.status).toBe(404);
    expect(mockResolveEffectiveDid).not.toHaveBeenCalled();
    expect(mockReadTelemetry).not.toHaveBeenCalled();
  });

  it('fails closed on missing or invalid auth', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce({ ok: false, status: 401, error: 'Unauthorized' });

    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/github/telemetry'), makeParams('github'));

    expect(res.status).toBe(401);
    expect(mockReadTelemetry).not.toHaveBeenCalled();
  });

  it('defaults ownerDid to the caller\u2019s own effective DID when no query params are given', async () => {
    await GET(makeReq('https://kernel.test/connections/api/connectors/github/telemetry'), makeParams('github'));

    expect(mockReadTelemetry).toHaveBeenCalledWith(GITHUB_ENTRY, OWNER_DID, null);
  });

  it('lets the effective DID read its own telemetry as the named owner', async () => {
    const res = await GET(
      makeReq(`https://kernel.test/connections/api/connectors/github/telemetry?ownerDid=${OWNER_DID}`),
      makeParams('github'),
    );

    expect(res.status).toBe(200);
    expect(mockReadTelemetry).toHaveBeenCalledWith(GITHUB_ENTRY, OWNER_DID, null);
  });

  it('lets the effective DID read a rollup naming it as the consumer of another DID\u2019s connector', async () => {
    const res = await GET(
      makeReq(`https://kernel.test/connections/api/connectors/github/telemetry?ownerDid=${OTHER_DID}&consumerDid=${OWNER_DID}`),
      makeParams('github'),
    );

    expect(res.status).toBe(200);
    expect(mockReadTelemetry).toHaveBeenCalledWith(GITHUB_ENTRY, OTHER_DID, OWNER_DID);
  });

  /**
   * The core access-control boundary (#1799): DID A must never be able to read
   * DID B's telemetry by naming a (ownerDid, consumerDid) pair neither of which
   * is A's own effective DID.
   */
  it('forbids reading another DID\u2019s telemetry (DID A cannot read DID B\u2019s telemetry)', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce({ ok: true, effectiveDid: OTHER_DID, via: 'session', composedBy: null });

    const res = await GET(
      makeReq(`https://kernel.test/connections/api/connectors/github/telemetry?ownerDid=${OWNER_DID}`),
      makeParams('github'),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden — can only read your own connector telemetry' });
    expect(mockReadTelemetry).not.toHaveBeenCalled();
  });

  it('forbids naming a consumerDid that is not the caller either', async () => {
    const res = await GET(
      makeReq(`https://kernel.test/connections/api/connectors/github/telemetry?ownerDid=${OTHER_DID}&consumerDid=did:imajin:third-party`),
      makeParams('github'),
    );

    expect(res.status).toBe(403);
    expect(mockReadTelemetry).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking the underlying failure when the rollup query throws', async () => {
    mockReadTelemetry.mockRejectedValueOnce(new Error('connection reset'));

    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/github/telemetry'), makeParams('github'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Connector telemetry unavailable' });
  });

  it('marks the response as no-store', async () => {
    const res = await GET(makeReq('https://kernel.test/connections/api/connectors/github/telemetry'), makeParams('github'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeReq('https://kernel.test/connections/api/connectors/github/telemetry'));
    expect(res.status).toBe(204);
  });
});
