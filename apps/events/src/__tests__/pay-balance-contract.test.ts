/**
 * Contract test (#2137, sibling of #2002/PR #2133): the events app's
 * `GET /api/balance` proxy and the kernel's documented pay.yaml spec must
 * agree on the same path — and a failed upstream call must never come back
 * disguised as a real zero balance.
 *
 * The path-parity checks read the two source files directly (same style as
 * apps/kernel/src/lib/kernel/__tests__/api-specs.test.ts and the sibling
 * pay-balance-transfer-contract.test.ts) so a future drift between the call
 * site and the spec fails CI immediately instead of surfacing as a runtime
 * 404. The 404/200 checks exercise the real route handler (same style as
 * orders-refund-route.test.ts) to pin the failure-visibility behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALL_SITE_PATH = resolve(HERE, '../../app/api/balance/route.ts');
// apps/events/src/__tests__ -> apps/events/src -> apps/events -> apps -> apps/kernel
const PAY_SPEC_PATH = resolve(HERE, '../../../kernel/api-spec/pay.yaml');

describe('pay.yaml balance contract', () => {
  const spec = readFileSync(PAY_SPEC_PATH, 'utf-8');
  const callSite = readFileSync(CALL_SITE_PATH, 'utf-8');

  it('documents GET /api/balance/{did}', () => {
    expect(spec).toMatch(/\n {2}\/api\/balance\/\{did\}:\n {4}get:/);
  });

  it('mounts every documented path under the /{service} (pay) prefix in its servers block', () => {
    // servers[].url ends in /{service}, and the {service} variable defaults
    // to "pay" — so /api/balance/{did} is actually served at
    // /pay/api/balance/{did}, which is exactly what the events call site
    // must reach once PAY_SERVICE_URL (already /pay-suffixed) is combined
    // with the endpoint path.
    expect(spec).toMatch(/servers:\n(?:.*\n)*? {6}service:\n {8}default: pay\b/);
  });

  it('requires cookieAuth or bearerAuth on the balance endpoint', () => {
    const section = spec.slice(spec.indexOf('\n  /api/balance/{did}:'));
    const nextPathIndex = section.indexOf('\n  /api/balance/gift:');
    const balanceSection = section.slice(0, nextPathIndex);

    expect(balanceSection).toContain('- cookieAuth: []');
    expect(balanceSection).toContain('- bearerAuth: []');
  });

  it('the events call site targets the documented /api/balance/{did} path, not a duplicated /pay prefix', () => {
    expect(callSite).toContain('${PAY_SERVICE_URL}/api/balance/${encodeURIComponent(buyerDid)}');
    // Scoped to the actual fetch() call rather than the whole file, since the
    // doc comment above it (like balance-checkout-helpers.ts's) intentionally
    // spells out the old buggy `/pay/pay/api/balance/{did}` path for context.
    const fetchCallLine = callSite.split('\n').find((line) => line.includes('await fetch(payUrl'));
    expect(fetchCallLine).toBeDefined();
    const payUrlAssignment = callSite.split('\n').find((line) => line.includes('const payUrl ='));
    expect(payUrlAssignment).not.toContain('/pay/api/balance/');
  });

  it("the events call site authenticates with the forwarded session cookie, matching cookieAuth", () => {
    expect(callSite).toMatch(/'Cookie':\s*request\.headers\.get\('cookie'\)/);
  });
});

// ─── Route behavior ─────────────────────────────────────────────────────────

function createStubLog() {
  return { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  requireAuthMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  // Same test double as events-create-route.test.ts / orders-refund tests:
  // skip correlation-id/timing plumbing and just invoke the handler directly,
  // but keep a stable log double so warn/error calls can be asserted.
  withLogger: (_service: string, handler: (req: unknown, ctx: { log: ReturnType<typeof createStubLog>; correlationId: string }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: mocks.log, correlationId: 'cor_test' }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string | null; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));

import { GET } from '../../app/api/balance/route';

function makeRequest(): Request {
  return new Request('https://events.test/api/balance', {
    headers: { cookie: 'session=abc' },
  });
}

describe('GET /api/balance (#2137: upstream failures must not hide as a real zero)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthMock.mockResolvedValue({
      identity: { id: 'did:imajin:buyer', actingAs: null },
    });
    vi.stubGlobal('fetch', mocks.fetchMock);
  });

  it('returns 401 when auth fails', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });

    const res = await GET(makeRequest() as any);
    expect(res.status).toBe(401);
    expect(mocks.fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 404 from the pay service as an unavailable balance, logs the status + url, and does not silently return a bare 200 zero', async () => {
    mocks.fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const res = await GET(makeRequest() as any);

    // A 404 must be visibly distinguishable from a real zero balance.
    expect(res.status).not.toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ balance: 0, unavailable: true });

    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, url: expect.stringContaining('/api/balance/') }),
      expect.any(String),
    );
  });

  it('surfaces a fetch/network failure the same way (unavailable, non-200, logged)', async () => {
    mocks.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await GET(makeRequest() as any);

    expect(res.status).not.toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ balance: 0, unavailable: true });
    expect(mocks.log.error).toHaveBeenCalled();
  });

  it('passes through a real balance on a 200 upstream response, without the unavailable flag', async () => {
    mocks.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ total: 42.5, currency: 'USD' }),
    });

    const res = await GET(makeRequest() as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ balance: 42.5, currency: 'USD' });
    expect(body.unavailable).toBeUndefined();
  });

  it("requests the documented /api/balance/{did} path with the caller's DID and forwarded session cookie", async () => {
    mocks.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ total: 0, currency: 'CAD' }) });

    await GET(makeRequest() as any);

    expect(mocks.fetchMock).toHaveBeenCalledOnce();
    const [url, init] = mocks.fetchMock.mock.calls[0];
    expect(url).toContain('/api/balance/did%3Aimajin%3Abuyer');
    expect(url).not.toContain('/pay/api/balance/');
    expect(init.headers.Cookie).toBe('session=abc');
  });
});
