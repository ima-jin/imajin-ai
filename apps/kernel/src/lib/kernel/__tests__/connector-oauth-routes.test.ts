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

const { requireAuthMock, resolveActingDidMock, requireAppAuthMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActingDidMock: vi.fn(() => 'did:imajin:owner'),
  requireAppAuthMock: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  resolveActingDid: resolveActingDidMock,
  requireAppAuth: requireAppAuthMock,
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

import {
  createConnectHandler,
  createCallbackHandler,
  createConfigureHandler,
  createDeviceStartHandler,
  createDevicePollHandler,
  resolveConfigDidFromAppAuth,
  MissingCallbackParamError,
} from '../connector-oauth-routes';
import type { BaseOAuthConfig } from '../connector-oauth';

function makeRequest(url: string) {
  return { url } as unknown as import('next/server').NextRequest;
}

/** A request with headers, for exercising app-auth header detection. */
function makeRequestWithHeaders(url: string, headers: Record<string, string> = {}) {
  return { url, headers: new Headers(headers) } as unknown as import('next/server').NextRequest;
}

/** A request whose `json()` resolves to `body` (or throws when omitted). */
function makeJsonRequest(body: unknown, url = 'https://kernel.test/api') {
  return {
    url,
    json: async () => {
      if (body === undefined) throw new Error('not json');
      return body;
    },
  } as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ identity: {} });
  resolveActingDidMock.mockReset();
  resolveActingDidMock.mockReturnValue('did:imajin:owner');
  requireAppAuthMock.mockReset();
  requireAppAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
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

  it('returns a logged 500 JSON error instead of letting an unrecognised error propagate uncaught (#1765)', async () => {
    const handler = createConnectHandler(
      async () => { throw new Error('boom'); },
      () => 'state123',
    );
    const res = (await handler(makeRequest('https://kernel.test/connect'))) as {
      status: number;
      json(): Promise<{ error: string }>;
    };
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('boom');
  });

  it('maps a missing-config error to 400 rather than an opaque 500 (#1765)', async () => {
    const handler = createConnectHandler(
      async () => { throw new Error('quickbooks_no_config: DID did:imajin:owner has not configured a quickbooks connection'); },
      () => 'state123',
    );
    const res = (await handler(makeRequest('https://kernel.test/connect'))) as {
      status: number;
      json(): Promise<{ error: string }>;
    };
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/quickbooks_no_config/);
  });

  // ── app-auth fallback (#1705, #1765) ────────────────────────────────────────

  it('falls back to app-auth and redirects on success when there is no session', async () => {
    requireAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: 'did:imajin:agrifortress', userDid: 'did:imajin:ryan', scopes: [], attestationId: 'att' },
    });
    const buildAuthorizeUrl = vi.fn(async () => 'https://provider.test/authorize?x=1');
    const handler = createConnectHandler(buildAuthorizeUrl, () => 'state123');

    const res = (await handler(makeRequestWithHeaders('https://kernel.test/connect', { authorization: 'Bearer app-token' }))) as {
      status: number;
      headers: { location: string };
    };

    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('https://provider.test/authorize?x=1');
    expect(buildAuthorizeUrl).toHaveBeenCalledWith('did:imajin:ryan', 'state123', 'did:imajin:agrifortress');
  });

  it('surfaces the app-auth error/status (not the session error) when both fail', async () => {
    requireAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    requireAppAuthMock.mockResolvedValue({ error: 'Invalid app token', status: 403 });
    const handler = createConnectHandler(async () => 'https://provider.test/authorize', () => 'state123');

    const res = (await handler(makeRequestWithHeaders('https://kernel.test/connect', { authorization: 'Bearer bad-token' }))) as {
      status: number;
      json(): Promise<{ error: string }>;
    };

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Invalid app token');
  });

  it('requires a delegating user DID from app-auth', async () => {
    requireAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: 'did:imajin:agrifortress', userDid: '', scopes: [], attestationId: '' },
    });
    const buildAuthorizeUrl = vi.fn();
    const handler = createConnectHandler(buildAuthorizeUrl, () => 'state123');

    const res = (await handler(makeRequestWithHeaders('https://kernel.test/connect', { authorization: 'Bearer service-token' }))) as { status: number };

    expect(res.status).toBe(400);
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
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

  // ── resolveConfigDid threading (#1704) ──────────────────────────────────────

  it('signs the resolved configDid into state and forwards it to buildAuthorizeUrl', async () => {
    const signState = vi.fn(() => 'state123');
    const buildAuthorizeUrl = vi.fn(async () => 'https://provider.test/authorize');
    const resolveConfigDid = vi.fn(async () => 'did:imajin:agrifortress');
    const handler = createConnectHandler(buildAuthorizeUrl, signState, resolveConfigDid);

    await handler(makeRequest('https://kernel.test/connect'));

    expect(resolveConfigDid).toHaveBeenCalledTimes(1);
    expect(signState).toHaveBeenCalledWith('did:imajin:owner', undefined, 'did:imajin:agrifortress');
    expect(buildAuthorizeUrl).toHaveBeenCalledWith('did:imajin:owner', 'state123', 'did:imajin:agrifortress');
  });

  it('signs no configDid when resolveConfigDid resolves undefined (BYO-app unaffected)', async () => {
    const signState = vi.fn(() => 'state123');
    const buildAuthorizeUrl = vi.fn(async () => 'https://provider.test/authorize');
    const resolveConfigDid = vi.fn(async () => undefined);
    const handler = createConnectHandler(buildAuthorizeUrl, signState, resolveConfigDid);

    await handler(makeRequest('https://kernel.test/connect'));

    expect(signState).toHaveBeenCalledWith('did:imajin:owner', undefined);
    expect(buildAuthorizeUrl).toHaveBeenCalledWith('did:imajin:owner', 'state123', undefined);
  });

  it('never calls resolveConfigDid when it is not supplied', async () => {
    const signState = vi.fn(() => 'state123');
    const handler = createConnectHandler(async () => 'https://provider.test/authorize', signState);

    await handler(makeRequest('https://kernel.test/connect'));

    expect(signState).toHaveBeenCalledWith('did:imajin:owner', undefined);
  });
});

describe('resolveConfigDidFromAppAuth (#1704)', () => {
  it('returns undefined when no app-auth headers are present', async () => {
    const result = await resolveConfigDidFromAppAuth(makeRequestWithHeaders('https://kernel.test/connect'));
    expect(result).toBeUndefined();
    expect(requireAppAuthMock).not.toHaveBeenCalled();
  });

  it('resolves the app DID from a bearer app token', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: 'did:imajin:agrifortress', userDid: 'did:imajin:owner', scopes: [], attestationId: 'att' },
    });
    const request = makeRequestWithHeaders('https://kernel.test/connect', { authorization: 'Bearer app-token' });

    const result = await resolveConfigDidFromAppAuth(request);

    expect(result).toBe('did:imajin:agrifortress');
    expect(requireAppAuthMock).toHaveBeenCalledWith(request);
  });

  it('resolves the app DID from legacy X-App-DID + X-App-Authorization headers', async () => {
    requireAppAuthMock.mockResolvedValue({
      appAuth: { appDid: 'did:imajin:agrifortress', userDid: 'did:imajin:owner', scopes: [], attestationId: 'att' },
    });
    const request = makeRequestWithHeaders('https://kernel.test/connect', {
      'x-app-did': 'did:imajin:agrifortress',
      'x-app-authorization': 'att_123',
    });

    expect(await resolveConfigDidFromAppAuth(request)).toBe('did:imajin:agrifortress');
  });

  it('returns undefined (does not throw) when app-auth verification fails', async () => {
    requireAppAuthMock.mockResolvedValue({ error: 'Invalid app token', status: 401 });
    const request = makeRequestWithHeaders('https://kernel.test/connect', { authorization: 'Bearer bad-token' });

    expect(await resolveConfigDidFromAppAuth(request)).toBeUndefined();
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

  // ── appDid threading (#1704) ─────────────────────────────────────────────

  it('forwards the appDid signed into the state to exchange', async () => {
    const exchange = vi.fn(async () => undefined);
    const handler = createCallbackHandler({
      verifyState: () => ({ did: 'did:imajin:owner', appDid: 'did:imajin:agrifortress' }),
      exchange,
      connectorName: 'QuickBooks',
      connectorId: 'quickbooks',
    });

    await call(handler);

    expect(exchange).toHaveBeenCalledWith('did:imajin:owner', 'abc', expect.any(URLSearchParams), 'did:imajin:agrifortress');
  });

  it('forwards undefined when no appDid was signed (BYO-app unaffected)', async () => {
    const exchange = vi.fn(async () => undefined);
    const handler = handlerWith(exchange);

    await call(handler);

    expect(exchange).toHaveBeenCalledWith('did:imajin:owner', 'abc', expect.any(URLSearchParams), undefined);
  });
});

// ─── Device flow (#1391) ─────────────────────────────────────────────────────

describe('createConfigureHandler — device vs authorization-code bodies', () => {
  function handlerFor(supportsDeviceFlow: boolean) {
    const storeConfig = vi.fn().mockResolvedValue(undefined);
    const { POST } = createConfigureHandler<BaseOAuthConfig>({
      buildConfig: (base) => base,
      storeConfig,
      supportsDeviceFlow,
    });
    return { POST, storeConfig };
  }

  async function post(handler: ReturnType<typeof handlerFor>, body: unknown) {
    return (await handler.POST(makeJsonRequest(body))) as {
      status: number;
      json(): Promise<{ error?: string; flow?: string }>;
    };
  }

  it('seals a clientId-only config as device mode', async () => {
    const handler = handlerFor(true);

    const res = await post(handler, { clientId: 'cid-device' });

    expect(res.status).toBe(201);
    expect((await res.json()).flow).toBe('device');
    expect(handler.storeConfig).toHaveBeenCalledWith('did:imajin:owner', {
      clientId: 'cid-device',
      flow: 'device',
    });
  });

  it('honours an explicit device flow even when the connector could infer otherwise', async () => {
    const handler = handlerFor(true);

    const res = await post(handler, { flow: 'device', clientId: 'cid-device' });

    expect(res.status).toBe(201);
    expect(handler.storeConfig).toHaveBeenCalledWith('did:imajin:owner', {
      clientId: 'cid-device',
      flow: 'device',
    });
  });

  it('refuses to seal a secret alongside a device-mode request', async () => {
    const handler = handlerFor(true);

    const res = await post(handler, { flow: 'device', clientId: 'cid', clientSecret: 'csecret' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/device flow takes clientId only/);
    expect(handler.storeConfig).not.toHaveBeenCalled();
  });

  it('rejects device mode on a connector that did not opt in', async () => {
    const handler = handlerFor(false);

    const res = await post(handler, { clientId: 'cid-device' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not support device flow/);
    expect(handler.storeConfig).not.toHaveBeenCalled();
  });

  it('still accepts a pre-#1391 three-field body as authorization code', async () => {
    const handler = handlerFor(true);

    const res = await post(handler, {
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://imajin.test/cb',
    });

    expect(res.status).toBe(201);
    expect(handler.storeConfig).toHaveBeenCalledWith('did:imajin:owner', {
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://imajin.test/cb',
      flow: 'authorization_code',
    });
  });

  it('still rejects a half-filled authorization-code body', async () => {
    const handler = handlerFor(true);

    const res = await post(handler, { clientId: 'cid', clientSecret: 'csecret' });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/clientId, clientSecret and redirectUri are required/);
  });
});

describe('createDeviceStartHandler', () => {
  const GRANT = {
    deviceCode: 'dev-code-xyz',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 900,
    interval: 5,
  };

  function handlerFor(requestDeviceCode: (did: string) => Promise<typeof GRANT>) {
    return createDeviceStartHandler({
      requestDeviceCode,
      signDeviceTicket: (did, code) => `ticket(${did}|${code})`,
      connectorName: 'github',
    });
  }

  it('returns the user code, verification URI, and a signed ticket', async () => {
    const handler = handlerFor(async () => GRANT);

    const res = (await handler(makeJsonRequest({}))) as {
      status: number;
      json(): Promise<Record<string, unknown>>;
    };

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      ticket: 'ticket(did:imajin:owner|dev-code-xyz)',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
    });
  });

  it('never returns the raw device code to the browser', async () => {
    const handler = handlerFor(async () => GRANT);

    const res = (await handler(makeJsonRequest({}))) as { json(): Promise<Record<string, unknown>> };

    expect(await res.json()).not.toHaveProperty('deviceCode');
  });

  it('returns 401 without starting a flow when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    const requestDeviceCode = vi.fn();
    const handler = handlerFor(requestDeviceCode);

    const res = (await handler(makeJsonRequest({}))) as { status: number };

    expect(res.status).toBe(401);
    expect(requestDeviceCode).not.toHaveBeenCalled();
  });

  it('maps a missing config to 400 rather than a 500', async () => {
    const handler = handlerFor(async () => {
      throw new Error('github_no_config: DID did:imajin:owner has not configured a github connection');
    });

    const res = (await handler(makeJsonRequest({}))) as { status: number };

    expect(res.status).toBe(400);
  });

  it('maps a pending credential to 409', async () => {
    const handler = handlerFor(async () => {
      throw new FakeConnectorCredentialPendingError('github_credential_pending: waiting for owner');
    });

    const res = (await handler(makeJsonRequest({}))) as { status: number };

    expect(res.status).toBe(409);
  });

  it('maps a provider-side device endpoint failure to 502', async () => {
    const handler = handlerFor(async () => {
      throw new Error('github_device_code: device_flow_disabled');
    });

    const res = (await handler(makeJsonRequest({}))) as { status: number; json(): Promise<{ error: string }> };

    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/device_flow_disabled/);
  });
});

describe('createDevicePollHandler', () => {
  function handlerFor(
    pollDeviceTokenOnce: ReturnType<typeof vi.fn>,
    verify: (ticket: string) => { did: string; deviceCode: string } =
      () => ({ did: 'did:imajin:owner', deviceCode: 'dev-code-xyz' }),
  ) {
    return createDevicePollHandler({
      pollDeviceTokenOnce,
      verifyDeviceTicket: verify,
      connectorName: 'github',
    });
  }

  it('polls with the device code carried by the ticket', async () => {
    const poll = vi.fn().mockResolvedValue('pending');
    const handler = handlerFor(poll);

    const res = (await handler(makeJsonRequest({ ticket: 't' }))) as {
      status: number;
      json(): Promise<{ status: string }>;
    };

    expect(poll).toHaveBeenCalledWith('did:imajin:owner', 'dev-code-xyz');
    expect((await res.json()).status).toBe('pending');
  });

  it('passes the authorized status through once the server sealed the token', async () => {
    const handler = handlerFor(vi.fn().mockResolvedValue('authorized'));

    const res = (await handler(makeJsonRequest({ ticket: 't' }))) as { json(): Promise<{ status: string }> };

    expect((await res.json()).status).toBe('authorized');
  });

  it('never returns a token, only a status', async () => {
    const handler = handlerFor(vi.fn().mockResolvedValue('authorized'));

    const res = (await handler(makeJsonRequest({ ticket: 't' }))) as { json(): Promise<Record<string, unknown>> };

    expect(Object.keys(await res.json())).toEqual(['status']);
  });

  it('rejects a ticket minted for a different DID', async () => {
    const poll = vi.fn();
    const handler = handlerFor(poll, () => ({ did: 'did:imajin:mallory', deviceCode: 'dev-code-xyz' }));

    const res = (await handler(makeJsonRequest({ ticket: 't' }))) as { status: number };

    expect(res.status).toBe(403);
    expect(poll).not.toHaveBeenCalled();
  });

  it('rejects a tampered or expired ticket without polling', async () => {
    const poll = vi.fn();
    const handler = handlerFor(poll, () => { throw new Error('github_device: signature mismatch'); });

    const res = (await handler(makeJsonRequest({ ticket: 't' }))) as {
      status: number;
      json(): Promise<{ error: string }>;
    };

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid or expired ticket');
    expect(poll).not.toHaveBeenCalled();
  });

  it('requires a ticket in the body', async () => {
    const poll = vi.fn();
    const handler = handlerFor(poll);

    const res = (await handler(makeJsonRequest({}))) as { status: number };

    expect(res.status).toBe(400);
    expect(poll).not.toHaveBeenCalled();
  });

  it('returns 401 without polling when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'unauthorized', status: 401 });
    const poll = vi.fn();
    const handler = handlerFor(poll);

    const res = (await handler(makeJsonRequest({ ticket: 't' }))) as { status: number };

    expect(res.status).toBe(401);
    expect(poll).not.toHaveBeenCalled();
  });
});
