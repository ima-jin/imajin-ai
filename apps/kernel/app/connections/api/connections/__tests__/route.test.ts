/**
 * Regression test for #1812: `resolveEffectiveDid` used to only attempt app
 * auth when the legacy `X-App-DID` header was present, so a bearer-only
 * external app (the preferred path since #1069) fell through to session
 * auth and got a generic 401 on every dual-guard route — including this one.
 *
 * This wires the *real* `resolveEffectiveDid` -> `requireAppAuth` ->
 * app-token-verify chain together (only `fetch` is stubbed, to route the
 * bearer-verification round trip to the in-process verify handler instead of
 * the network), through the *real* route handler — the AgriFortress shape
 * described in the issue: bearer app token, no `x-app-did`, `connections:read`
 * scope, `GET /connections/api/connections`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextRequest: Request,
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      }),
  },
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
  withCors: (response: Response) => response,
}));

const { mockListConnections } = vi.hoisted(() => ({ mockListConnections: vi.fn() }));
vi.mock('@/src/lib/connections/list', () => ({ listConnections: mockListConnections }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { createAppToken } from '@/src/lib/auth/jwt';
import { POST as verifyAppTokenRoute } from '@/app/auth/api/apps/token/verify/route';
import { GET } from '../route';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';
const APP_DID = 'did:imajin:agrifortress-webhook';
const RECIPIENT_DID = 'did:imajin:agrifortress-recipient';

function connectionsRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://kernel.test/connections/api/connections', { headers });
}

async function mintAppToken(scope: string): Promise<string> {
  return createAppToken({ sub: RECIPIENT_DID, azp: APP_DID, scope, attestationId: 'att_consent' });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
  mockListConnections.mockResolvedValue([]);

  // The bearer path round-trips through HTTP in production (#1069); here we
  // stub `fetch` to hand the request straight to the real verify handler
  // in-process, so the resolveEffectiveDid -> requireAppAuth -> verify chain
  // runs on real code end to end.
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === `${AUTH_SERVICE_URL}/api/apps/token/verify`) {
      const req = new Request(String(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: init?.body,
      });
      return verifyAppTokenRoute(req as never);
    }
    throw new Error(`Unexpected fetch to ${String(url)}`);
  }) as unknown as typeof fetch;
});

describe('GET /connections/api/connections — AgriFortress bearer-only app token (#1812)', () => {
  it('resolves the app branch and lists connections for a bearer app token with the granted scope, no x-app-did', async () => {
    const token = await mintAppToken('connections:read');

    const res = await GET(connectionsRequest({ authorization: `Bearer ${token}` }) as never);

    expect(res.status).toBe(200);
    expect(mockListConnections).toHaveBeenCalledWith(RECIPIENT_DID);
  });

  it('rejects a bearer app token missing the connections:read scope with 403, not a generic 401', async () => {
    const token = await mintAppToken('connections:write');

    const res = await GET(connectionsRequest({ authorization: `Bearer ${token}` }) as never);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/connections:read/);
    expect(mockListConnections).not.toHaveBeenCalled();
  });
});
