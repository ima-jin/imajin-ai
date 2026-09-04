/**
 * Tests for POST /auth/api/tokens/app (#1069 Phase 1).
 *
 * This mint endpoint is the first-party counterpart to
 * /auth/api/apps/token: instead of an app DID + attestation, the caller
 * authenticates with their own session cookie and asks for a token scoped
 * to a specific app host (`aud`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));

const mocks = vi.hoisted(() => ({
  verifySessionTokenMock: vi.fn(),
  createSessionAppTokenMock: vi.fn().mockResolvedValue('signed.session-app.jwt'),
}));

vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
  getSessionCookieOptions: () => ({ name: 'imajin_session_dev', options: {} }),
}));
vi.mock('@imajin/auth', () => ({
  validateScopes: (scopes: string[]) => ({
    valid: scopes.filter((s) => s === 'profile:read' || s === 'connections:read'),
    invalid: scopes.filter((s) => s !== 'profile:read' && s !== 'connections:read'),
  }),
}));
vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: mocks.verifySessionTokenMock,
  createSessionAppToken: mocks.createSessionAppTokenMock,
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

const USER_DID = 'did:imajin:user-abc';

function makeRequest(body: Record<string, unknown> | undefined, cookieValue?: string): Request {
  const req = new Request('https://kernel.test/auth/api/tokens/app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Emulate NextRequest's `.cookies.get(name)` surface used by the route.
  (req as unknown as { cookies: { get: (name: string) => { value: string } | undefined } }).cookies = {
    get: (name: string) => (name === 'imajin_session_dev' && cookieValue ? { value: cookieValue } : undefined),
  };
  return req;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSessionAppTokenMock.mockResolvedValue('signed.session-app.jwt');
});

describe('POST /auth/api/tokens/app — requires a valid session (#1069 Phase 1)', () => {
  it('rejects with 401 when there is no session cookie', async () => {
    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai' }) as never);

    expect(res.status).toBe(401);
    expect(mocks.createSessionAppTokenMock).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the session cookie does not verify', async () => {
    mocks.verifySessionTokenMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai' }, 'bad-token') as never);

    expect(res.status).toBe(401);
    expect(mocks.createSessionAppTokenMock).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/tokens/app — minting (#1069 Phase 1)', () => {
  beforeEach(() => {
    mocks.verifySessionTokenMock.mockResolvedValue({ sub: USER_DID });
  });

  it('rejects with 400 when aud is missing', async () => {
    const res = await POST(makeRequest({}, 'good-token') as never);

    expect(res.status).toBe(400);
    expect(mocks.createSessionAppTokenMock).not.toHaveBeenCalled();
  });

  it('mints a token scoped to the requested aud for the session did', async () => {
    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai', scopes: ['profile:read'] }, 'good-token') as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.token).toBe('signed.session-app.jwt');
    expect(body.expiresIn).toBe(600);
    expect(body.scopes).toEqual(['profile:read']);
    expect(mocks.createSessionAppTokenMock).toHaveBeenCalledWith({
      sub: USER_DID,
      aud: 'coffee.imajin.ai',
      scopes: ['profile:read'],
    });
  });

  it('clamps unknown scopes out of the vocabulary rather than minting them', async () => {
    const res = await POST(
      makeRequest({ aud: 'coffee.imajin.ai', scopes: ['profile:read', 'not-a-real-scope'] }, 'good-token') as never
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopes).toEqual(['profile:read']);
  });

  it('mints with an empty scope list when none are requested', async () => {
    const res = await POST(makeRequest({ aud: 'coffee.imajin.ai' }, 'good-token') as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scopes).toEqual([]);
  });
});
