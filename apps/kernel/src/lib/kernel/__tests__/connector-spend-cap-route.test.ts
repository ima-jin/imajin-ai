/**
 * Tests for the shared spend-cap settings route factory (#1923).
 *
 * Every brain connector (Gemini, Anthropic, xAI, OpenAI, Moonshot) gets its
 * GET/PUT/DELETE handlers from here, so this is where the field-format
 * contract is pinned: `"<amountUsd>:<period>"`, fail-closed writes, and
 * acting on the resolved connector owner rather than anything a caller names.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveConnectorOwnerDid, mockReadConnectorRegistration, mockSetConnectorSpendCap } = vi.hoisted(() => ({
  mockResolveConnectorOwnerDid: vi.fn(),
  mockReadConnectorRegistration: vi.fn(),
  mockSetConnectorSpendCap: vi.fn(),
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/kernel/connector-owner-did', () => ({
  resolveConnectorOwnerDid: mockResolveConnectorOwnerDid,
}));

vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  readConnectorRegistration: mockReadConnectorRegistration,
  setConnectorSpendCap: mockSetConnectorSpendCap,
}));

// `spend-cap.ts` pulls in `@/src/db` (a real drizzle client) purely to sum
// `usage.incurred` rows for `checkSpendCap`/`spentUsd` — neither of which
// this route calls. The REAL `parseSpendCap`/`serializeSpendCap` are used
// (not re-implemented) so the route's field-format contract is pinned
// against the actual parser, with just the DB client construction stubbed.
vi.mock('@/src/db', () => ({ db: {}, usageIncurred: {} }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { createConnectorSpendCapRoute } from '../connector-spend-cap-route';

const OWNER = 'did:imajin:veteze';
const { GET, PUT, DELETE, OPTIONS } = createConnectorSpendCapRoute('xai');

type RouteRequest = Parameters<typeof PUT>[0];

function makeReq(body?: unknown, opts: { invalidJson?: boolean } = {}): RouteRequest {
  return {
    headers: new Headers(),
    json: async () => {
      if (opts.invalidJson) throw new Error('invalid json');
      return body;
    },
  } as unknown as RouteRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveConnectorOwnerDid.mockResolvedValue({ ok: true, ownerDid: OWNER });
  mockReadConnectorRegistration.mockResolvedValue(undefined);
  mockSetConnectorSpendCap.mockResolvedValue(undefined);
});

describe('spend-cap route — GET', () => {
  it('reports an empty string when no cap is set', async () => {
    const res = await GET(makeReq());
    expect(await res.json()).toEqual({ spendCap: '' });
  });

  it('formats a stored cap back into "<amountUsd>:<period>"', async () => {
    mockReadConnectorRegistration.mockResolvedValueOnce({ spendCap: { amountUsd: 50, period: 'daily' } });

    const res = await GET(makeReq());

    expect(await res.json()).toEqual({ spendCap: '50:daily' });
    expect(mockReadConnectorRegistration).toHaveBeenCalledWith(OWNER, 'xai');
  });

  it('treats a malformed stored cap as empty rather than 500ing', async () => {
    mockReadConnectorRegistration.mockResolvedValueOnce({ spendCap: { amountUsd: -1, period: 'daily' } });

    const res = await GET(makeReq());

    expect(await res.json()).toEqual({ spendCap: '' });
  });

  it('returns 401 without reading the registry when unauthenticated', async () => {
    mockResolveConnectorOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await GET(makeReq());

    expect(res.status).toBe(401);
    expect(mockReadConnectorRegistration).not.toHaveBeenCalled();
  });
});

describe('spend-cap route — PUT', () => {
  it('saves a well-formed cap for the resolved owner', async () => {
    const res = await PUT(makeReq({ spendCap: '50:daily' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ spendCap: '50:daily' });
    expect(mockSetConnectorSpendCap).toHaveBeenCalledWith(OWNER, 'xai', { amountUsd: 50, period: 'daily' });
  });

  it.each([
    ['not a string', { spendCap: 50 }],
    ['missing a period', { spendCap: '50' }],
    ['an invalid period', { spendCap: '50:weekly' }],
    ['a non-positive amount', { spendCap: '0:daily' }],
    ['not a number', { spendCap: 'fifty:daily' }],
  ])('returns 400 when spendCap is %s, without writing', async (_label, body) => {
    const res = await PUT(makeReq(body));

    expect(res.status).toBe(400);
    expect(mockSetConnectorSpendCap).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await PUT(makeReq(undefined, { invalidJson: true }));
    expect(res.status).toBe(400);
    expect(mockSetConnectorSpendCap).not.toHaveBeenCalled();
  });

  it('returns 500 without leaking the failure when the write throws (fails closed)', async () => {
    mockSetConnectorSpendCap.mockRejectedValueOnce(new Error('connection reset'));

    const res = await PUT(makeReq({ spendCap: '50:daily' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to save spend cap' });
  });

  it('returns 401 without writing when unauthenticated', async () => {
    mockResolveConnectorOwnerDid.mockResolvedValueOnce({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await PUT(makeReq({ spendCap: '50:daily' }));

    expect(res.status).toBe(401);
    expect(mockSetConnectorSpendCap).not.toHaveBeenCalled();
  });
});

describe('spend-cap route — DELETE', () => {
  it('clears the cap for the resolved owner', async () => {
    const res = await DELETE(makeReq());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ spendCap: '' });
    expect(mockSetConnectorSpendCap).toHaveBeenCalledWith(OWNER, 'xai', null);
  });

  it('returns 500 without leaking the failure when clearing throws', async () => {
    mockSetConnectorSpendCap.mockRejectedValueOnce(new Error('connection reset'));

    const res = await DELETE(makeReq());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to clear spend cap' });
  });
});

describe('spend-cap route — OPTIONS', () => {
  it('answers CORS pre-flight', async () => {
    expect((await OPTIONS(makeReq())).status).toBe(204);
  });
});
