import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAppAuth, mockResolveEffectiveDid, mockPublish, mockReadProjection } = vi.hoisted(() => ({
  mockRequireAppAuth: vi.fn(),
  mockResolveEffectiveDid: vi.fn(),
  mockPublish: vi.fn(),
  mockReadProjection: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAppAuth: mockRequireAppAuth,
  resolveEffectiveDid: mockResolveEffectiveDid,
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://example.test' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/kernel/telemetry-usage', () => ({
  readTelemetryUsageProjection: mockReadProjection,
  DEFAULT_TELEMETRY_USAGE_ROW_LIMIT: 1000,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST, GET, OPTIONS } from '../route';

const APP_DID = 'did:imajin:openclaw-connector';
const PRINCIPAL_DID = 'did:imajin:ryan';

function makeRequest(body: unknown, url = 'https://kernel.test/connections/api/telemetry') {
  return {
    headers: new Headers(),
    url,
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

function makeGetRequest(url = 'https://kernel.test/connections/api/telemetry') {
  return { headers: new Headers(), url } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAppAuth.mockResolvedValue({
    appAuth: { appDid: APP_DID, userDid: PRINCIPAL_DID, scopes: ['telemetry:write'], attestationId: 'att_1' },
  });
  mockPublish.mockResolvedValue(undefined);
  mockResolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: PRINCIPAL_DID, via: 'session', composedBy: null });
  mockReadProjection.mockResolvedValue({ principal: PRINCIPAL_DID, totalCount: 0, bySchema: [] });
});

describe('POST /connections/api/telemetry (#1677)', () => {
  it('fails closed when app auth fails', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({ error: 'Invalid app token', status: 401 });

    const res = await POST(makeRequest({ events: [{ type: 'telemetry.usage', schema: 'usage.tokens', data: { input: 1 } }] }));

    expect(res.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects a service token with no delegating user DID', async () => {
    mockRequireAppAuth.mockResolvedValueOnce({
      appAuth: { appDid: APP_DID, userDid: '', scopes: ['telemetry:write'], attestationId: '', isServiceToken: true },
    });

    const res = await POST(makeRequest({ events: [{ type: 'telemetry.usage', schema: 'usage.tokens', data: { input: 1 } }] }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Telemetry ingestion requires a delegating user DID' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON bodies', async () => {
    const request = {
      headers: new Headers(),
      url: 'https://kernel.test/connections/api/telemetry',
      json: async () => {
        throw new SyntaxError('bad json');
      },
    } as unknown as Parameters<typeof POST>[0];

    const res = await POST(request);
    expect(res.status).toBe(400);
  });

  it('forbids naming a principal other than the delegating DID', async () => {
    const res = await POST(
      makeRequest({
        principal: 'did:imajin:someone-else',
        events: [{ type: 'telemetry.usage', schema: 'usage.tokens', data: { input: 1 } }],
      }),
    );

    expect(res.status).toBe(403);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('allows an explicit principal that matches the delegating DID', async () => {
    const res = await POST(
      makeRequest({
        principal: PRINCIPAL_DID,
        events: [{ type: 'telemetry.usage', schema: 'usage.tokens', data: { input: 1 } }],
      }),
    );

    expect(res.status).toBe(202);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for a structurally invalid events envelope', async () => {
    const res = await POST(makeRequest({ events: [] }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'events must not be empty' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('publishes one bus event per accepted event, attributing issuer/subject correctly', async () => {
    const res = await POST(
      makeRequest({
        events: [
          { type: 'telemetry.usage', schema: 'usage.tokens', data: { input: 100, output: 20 }, sessionRef: 'run_1' },
          { type: 'telemetry.error', schema: 'error.rate_limit', data: { code: 429 } },
        ],
      }),
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ accepted: 2, rejected: [], maxBatchSize: 200 });

    expect(mockPublish).toHaveBeenNthCalledWith(1, 'telemetry.usage', {
      issuer: APP_DID,
      subject: PRINCIPAL_DID,
      scope: 'telemetry',
      payload: {
        schema: 'usage.tokens',
        data: { input: 100, output: 20 },
        sessionRef: 'run_1',
        context_id: 'run_1',
        context_type: 'telemetry',
      },
    });
    expect(mockPublish).toHaveBeenNthCalledWith(2, 'telemetry.error', {
      issuer: APP_DID,
      subject: PRINCIPAL_DID,
      scope: 'telemetry',
      payload: {
        schema: 'error.rate_limit',
        data: { code: 429 },
        context_id: 'error.rate_limit',
        context_type: 'telemetry',
      },
    });
  });

  it('reports accepted and rejected counts for a mixed batch', async () => {
    const res = await POST(
      makeRequest({
        events: [
          { type: 'telemetry.usage', schema: 'usage.tokens', data: { input: 1 } },
          { type: 'telemetry.usage', schema: 'bad schema', data: { input: 1 } },
        ],
      }),
    );

    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.accepted).toBe(1);
    expect(body.rejected).toEqual([{ index: 1, reason: 'schema must be a namespaced key, e.g. "usage.tokens"' }]);
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it('does not fail the request when publish rejects (non-fatal)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('bus down'));

    const res = await POST(makeRequest({ events: [{ type: 'telemetry.usage', schema: 'usage.tokens', data: { input: 1 } }] }));

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(1);
  });
});

describe('GET /connections/api/telemetry (#1677)', () => {
  it('fails closed on missing or invalid auth', async () => {
    mockResolveEffectiveDid.mockResolvedValueOnce({ ok: false, status: 401, error: 'Unauthorized' });

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(401);
    expect(mockReadProjection).not.toHaveBeenCalled();
  });

  it('reads the projection for the caller\u2019s own effective DID', async () => {
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    expect(mockReadProjection).toHaveBeenCalledWith(PRINCIPAL_DID, 1000);
  });

  it('honours a bounded limit query param', async () => {
    await GET(makeGetRequest('https://kernel.test/connections/api/telemetry?limit=50'));
    expect(mockReadProjection).toHaveBeenCalledWith(PRINCIPAL_DID, 50);
  });

  it('clamps an over-large limit query param to the hard ceiling', async () => {
    await GET(makeGetRequest('https://kernel.test/connections/api/telemetry?limit=999999'));
    expect(mockReadProjection).toHaveBeenCalledWith(PRINCIPAL_DID, 5000);
  });

  it('ignores a non-numeric limit query param and falls back to the default', async () => {
    await GET(makeGetRequest('https://kernel.test/connections/api/telemetry?limit=abc'));
    expect(mockReadProjection).toHaveBeenCalledWith(PRINCIPAL_DID, 1000);
  });

  it('returns 500 without leaking the underlying failure when the projection query throws', async () => {
    mockReadProjection.mockRejectedValueOnce(new Error('connection reset'));

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Telemetry usage unavailable' });
  });

  it('marks the response as no-store', async () => {
    const res = await GET(makeGetRequest());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('OPTIONS /connections/api/telemetry', () => {
  it('answers CORS pre-flight', async () => {
    const res = await OPTIONS(makeGetRequest());
    expect(res.status).toBe(204);
  });
});
