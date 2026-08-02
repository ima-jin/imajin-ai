import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── connector-oauth-routes.ts — connect/callback handler tests (#1521, #1529) ─
//
// Two concerns:
//   1. (#1521) A ConnectorCredentialPendingError must turn into a clean,
//      actionable response rather than an unhandled exception (connect) or a
//      generic failure that masks it (callback).
//   2. (#1529) The callback is a *browser* redirect target, so every branch
//      must redirect back into the app rather than render JSON — and the
//      `returnTo` that drives where it lands must never escape the origin.

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
    redirect: vi.fn((url: string | URL) => ({ status: 307, headers: { location: String(url) } })),
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

  // ── returnTo threading (#1529) ──────────────────────────────────────────────

  it('signs a same-origin returnTo into the state', async () => {
    const signState = vi.fn(() => 'state123');
    const handler = createConnectHandler(async () => 'https://provider.test/authorize', signState);

    await handler(makeRequest('https://kernel.test/connect?returnTo=%2Fauth%2Fconnectors%2Fgithub'));
    expect(signState).toHaveBeenCalledWith('did:imajin:owner', '/auth/connectors/github');
  });

  it('drops an off-origin returnTo rather than signing it', async () => {
    const signState = vi.fn(() => 'state123');
    const handler = createConnectHandler(async () => 'https://provider.test/authorize', signState);

    await handler(makeRequest('https://kernel.test/connect?returnTo=https%3A%2F%2Fevil.com'));
    expect(signState).toHaveBeenCalledWith('did:imajin:owner', undefined);
  });

  it('signs no returnTo when the param is absent', async () => {
    const signState = vi.fn(() => 'state123');
    const handler = createConnectHandler(async () => 'https://provider.test/authorize', signState);

    await handler(makeRequest('https://kernel.test/connect'));
    expect(signState).toHaveBeenCalledWith('did:imajin:owner', undefined);
  });
});

describe('createCallbackHandler', () => {
  const DEFAULT_LANDING = 'https://kernel.test/auth/connectors/github';

  function handlerWith(
    exchange: (ownerDid: string, code: string, searchParams: URLSearchParams) => Promise<void>,
    verifyState: () => { did: string; returnTo?: string } = () => ({ did: 'did:imajin:owner' }),
  ) {
    return createCallbackHandler({
      verifyState,
      exchange,
      connectorName: 'GitHub',
      connectorId: 'github',
    });
  }

  /** Run a callback handler and return the redirect status + Location. */
  async function call(
    handler: ReturnType<typeof handlerWith>,
    url = 'https://kernel.test/callback?code=abc&state=xyz',
  ) {
    return (await handler(makeRequest(url))) as { status: number; headers: { location: string } };
  }

  // ── Success ─────────────────────────────────────────────────────────────────

  it('redirects back into the app instead of rendering JSON', async () => {
    const res = await call(handlerWith(async () => undefined));
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe(`${DEFAULT_LANDING}?connected=github`);
  });

  it('honours a returnTo that was signed into the state', async () => {
    const handler = handlerWith(
      async () => undefined,
      () => ({ did: 'did:imajin:owner', returnTo: '/auth/settings' }),
    );
    const res = await call(handler);
    expect(res.headers.location).toBe('https://kernel.test/auth/settings?connected=github');
  });

  it('ignores an off-origin returnTo even when it survived state verification', async () => {
    // Defence in depth: a leaked signing key must not become an open redirect.
    const handler = handlerWith(
      async () => undefined,
      () => ({ did: 'did:imajin:owner', returnTo: 'https://evil.com/steal' }),
    );
    const res = await call(handler);
    expect(res.headers.location).toBe(`${DEFAULT_LANDING}?connected=github`);
  });

  it('ignores a protocol-relative returnTo', async () => {
    const handler = handlerWith(
      async () => undefined,
      () => ({ did: 'did:imajin:owner', returnTo: '//evil.com/steal' }),
    );
    const res = await call(handler);
    expect(res.headers.location).toBe(`${DEFAULT_LANDING}?connected=github`);
  });

  // ── Failures ────────────────────────────────────────────────────────────────

  it('redirects with missing_params when code or state is absent', async () => {
    const exchange = vi.fn();
    const res = await call(handlerWith(exchange), 'https://kernel.test/callback');
    expect(res.headers.location).toBe(`${DEFAULT_LANDING}?error=missing_params&connector=github`);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('redirects to the default landing with invalid_state when state fails verification', async () => {
    // returnTo is unrecoverable here, so it must not be honoured from the URL.
    const handler = handlerWith(
      async () => undefined,
      () => { throw new Error('signature mismatch'); },
    );
    const res = await call(handler);
    expect(res.headers.location).toBe(`${DEFAULT_LANDING}?error=invalid_state&connector=github`);
  });

  it('redirects with missing_param for a missing provider callback param', async () => {
    const handler = handlerWith(async () => { throw new MissingCallbackParamError('realmId'); });
    const res = await call(handler);
    expect(res.headers.location).toBe(`${DEFAULT_LANDING}?error=missing_param&connector=github`);
  });

  it('redirects with credential_pending rather than a generic failure', async () => {
    const handler = handlerWith(async () => {
      throw new FakeConnectorCredentialPendingError('github_credential_pending: waiting for owner');
    });
    const res = await call(handler);
    expect(res.headers.location).toBe(`${DEFAULT_LANDING}?error=credential_pending&connector=github`);
  });

  it('redirects with exchange_failed for an unrecognised exchange failure', async () => {
    const handler = handlerWith(async () => { throw new Error('token endpoint down'); });
    const res = await call(handler);
    expect(res.headers.location).toBe(`${DEFAULT_LANDING}?error=exchange_failed&connector=github`);
  });

  it('never leaks raw exception text into the redirect URL', async () => {
    const handler = handlerWith(async () => { throw new Error('client_secret=hunter2 rejected'); });
    const res = await call(handler);
    expect(res.headers.location).not.toMatch(/hunter2/);
  });

  it('reports failures on the signed returnTo page when one is available', async () => {
    const handler = handlerWith(
      async () => { throw new Error('token endpoint down'); },
      () => ({ did: 'did:imajin:owner', returnTo: '/auth/settings' }),
    );
    const res = await call(handler);
    expect(res.headers.location).toBe('https://kernel.test/auth/settings?error=exchange_failed&connector=github');
  });
});
