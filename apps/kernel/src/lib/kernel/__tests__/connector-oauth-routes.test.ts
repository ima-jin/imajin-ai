import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── connector-oauth-routes.ts — connect/callback handler tests (#1521) ───────
//
// Focus: the two places a ConnectorCredentialPendingError must turn into a
// clean, actionable response rather than an unhandled exception (connect) or
// the generic "connection failed" 502 that would otherwise mask it (callback).

const { requireAuthMock, resolveActingDidMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActingDidMock: vi.fn(() => 'did:imajin:owner'),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: { update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }) },
  channelLinks: {},
}));

vi.mock('@/src/lib/vault', () => ({ deleteFromVault: vi.fn() }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));

vi.mock('next/server', () => ({
  NextResponse: {
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
    redirect: vi.fn((url: string) => ({ status: 307, headers: { location: url } })),
  },
  NextRequest: class {},
}));

const { FakeConnectorCredentialPendingError } = vi.hoisted(() => {
  class FakeConnectorCredentialPendingError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConnectorCredentialPendingError';
    }
  }
  return { FakeConnectorCredentialPendingError };
});
vi.mock('../connector-oauth', () => ({ ConnectorCredentialPendingError: FakeConnectorCredentialPendingError }));

import { createConnectHandler, createCallbackHandler, MissingCallbackParamError } from '../connector-oauth-routes';

function makeRequest(url: string) {
  return { url } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ identity: {} });
  resolveActingDidMock.mockReset();
  resolveActingDidMock.mockReturnValue('did:imajin:owner');
});

describe('createConnectHandler', () => {
  it('redirects to the built authorize URL on success', async () => {
    const handler = createConnectHandler(
      async () => 'https://provider.test/authorize?x=1',
      () => 'state123',
    );
    const res = (await handler(makeRequest('https://kernel.test/connect'))) as { status: number; headers: { location: string } };
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('https://provider.test/authorize?x=1');
  });

  it('returns 401 when the caller is unauthenticated (never calls buildAuthorizeUrl)', async () => {
    requireAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    const buildAuthorizeUrl = vi.fn();
    const handler = createConnectHandler(buildAuthorizeUrl, () => 'state123');

    const res = (await handler(makeRequest('https://kernel.test/connect'))) as { status: number };
    expect(res.status).toBe(401);
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it('returns a 409 with the pending message instead of an unhandled exception', async () => {
    const handler = createConnectHandler(
      async () => { throw new FakeConnectorCredentialPendingError('github_credential_pending: waiting for owner'); },
      () => 'state123',
    );

    const res = (await handler(makeRequest('https://kernel.test/connect'))) as { status: number; json(): Promise<{ error: string }> };
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/github_credential_pending/);
  });

  it('lets any other error propagate (not silently swallowed)', async () => {
    const handler = createConnectHandler(
      async () => { throw new Error('boom'); },
      () => 'state123',
    );
    await expect(handler(makeRequest('https://kernel.test/connect'))).rejects.toThrow('boom');
  });
});

describe('createCallbackHandler', () => {
  function handlerWith(exchange: (ownerDid: string, code: string, searchParams: URLSearchParams) => Promise<void>) {
    return createCallbackHandler({
      verifyState: () => 'did:imajin:owner',
      exchange,
      connectorName: 'GitHub',
    });
  }

  it('returns { connected: true } on success', async () => {
    const handler = handlerWith(async () => undefined);
    const res = (await handler(makeRequest('https://kernel.test/callback?code=abc&state=xyz'))) as {
      status: number; json(): Promise<{ connected: boolean }>;
    };
    expect((await res.json()).connected).toBe(true);
  });

  it('returns 400 for a missing callback param', async () => {
    const handler = handlerWith(async () => { throw new MissingCallbackParamError('realmId'); });
    const res = (await handler(makeRequest('https://kernel.test/callback?code=abc&state=xyz'))) as { status: number };
    expect(res.status).toBe(400);
  });

  it('returns a 409 with the pending message instead of the generic 502 "connection failed"', async () => {
    const handler = handlerWith(async () => {
      throw new FakeConnectorCredentialPendingError('github_credential_pending: waiting for owner');
    });

    const res = (await handler(makeRequest('https://kernel.test/callback?code=abc&state=xyz'))) as {
      status: number; json(): Promise<{ error: string }>;
    };
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/github_credential_pending/);
  });

  it('falls back to a generic 502 for an unrecognised exchange failure', async () => {
    const handler = handlerWith(async () => { throw new Error('token endpoint down'); });
    const res = (await handler(makeRequest('https://kernel.test/callback?code=abc&state=xyz'))) as { status: number };
    expect(res.status).toBe(502);
  });
});
