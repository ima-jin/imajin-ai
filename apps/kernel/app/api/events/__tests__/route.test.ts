/**
 * Tests for `POST /api/events` (#2638 / #2641) — the app-callable event emit
 * route. Every gate is exercised: 401 (unauthenticated / wrong token kind),
 * 400 (bad shape), 403 (inactive app, event type not on the operator-approved
 * list), and the accepted path, which must hand `publishAppEvent` the verified
 * app DID — never anything the caller claims.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyAppTokenMock: vi.fn(),
  resolveEmittableEventsMock: vi.fn(),
  publishAppEventMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => new Headers(),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: mocks.verifyAppTokenMock }));
vi.mock('@/src/lib/kernel/app-emittable-events', () => ({ resolveEmittableEvents: mocks.resolveEmittableEventsMock }));
vi.mock('@/src/lib/kernel/app-registry', () => ({
  APP_NOT_REGISTERED_ERROR: { error: 'app_not_registered', error_description: 'not registered' },
}));
vi.mock('@imajin/config', () => ({ rateLimit: mocks.rateLimitMock }));
vi.mock('@imajin/bus', () => ({ publishAppEvent: mocks.publishAppEventMock }));

import { POST, OPTIONS } from '../route';
import { MAX_INTEREST_DIDS } from '@/src/lib/kernel/emittable-events';

const APP_DID = 'did:imajin:app_coffee';
const RECIPIENT = 'did:imajin:alice';

const SERVICE_CLAIMS = { sub: APP_DID, azp: APP_DID, scope: '', aud: 'imajin:apps', isServiceToken: true, attestationId: '' };

function req(body: unknown, headers: Record<string, string> = { authorization: 'Bearer good-token' }): Request {
  return new Request('https://kernel.test/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function manyDids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `did:imajin:user${i}`);
}

const validBody = { type: 'tip.granted', subject: RECIPIENT, payload: { amount: 3, currency: 'USD' } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyAppTokenMock.mockResolvedValue(SERVICE_CLAIMS);
  mocks.rateLimitMock.mockReturnValue({ limited: false, retryAfter: 0 });
  mocks.resolveEmittableEventsMock.mockResolvedValue(['tip.granted', 'tip.sent']);
  mocks.publishAppEventMock.mockResolvedValue({ eventType: 'tip.granted', origin: APP_DID, ran: ['audit-log', 'notify'], skipped: ['attestation', 'mjn'] });
});

describe('POST /api/events — authentication (401)', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await POST(req(validBody, {}) as never);

    expect(res.status).toBe(401);
    expect(mocks.verifyAppTokenMock).not.toHaveBeenCalled();
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const res = await POST(req(validBody, { authorization: 'Basic abc' }) as never);
    expect(res.status).toBe(401);
  });

  it('rejects a token that does not verify (bad signature / expired)', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue(null);

    const res = await POST(req(validBody) as never);

    expect(res.status).toBe(401);
    expect(mocks.resolveEmittableEventsMock).not.toHaveBeenCalled();
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });

  it('rejects a verified user-delegated app token: only the app-service token may speak as the app', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ ...SERVICE_CLAIMS, sub: 'did:imajin:user', isServiceToken: false });

    const res = await POST(req(validBody) as never);

    expect(res.status).toBe(401);
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });

  it('rejects a service token with no azp', async () => {
    mocks.verifyAppTokenMock.mockResolvedValue({ ...SERVICE_CLAIMS, azp: undefined });

    const res = await POST(req(validBody) as never);

    expect(res.status).toBe(401);
  });

  it('authenticates before reading the body: unauthenticated garbage is 401, not 400', async () => {
    const res = await POST(req('not json', {}) as never);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/events — token audience (#2717)', () => {
  it.each([
    ['another app\'s audience', 'market'],
    ['a host-shaped audience', 'kernel.test'],
    ['several audiences, none of them this endpoint\'s', ['market', 'coffee']],
    ['no audience', undefined],
  ])('rejects a validly signed service token minted for %s', async (_label, aud) => {
    mocks.verifyAppTokenMock.mockResolvedValue({ ...SERVICE_CLAIMS, aud });

    const res = await POST(req(validBody) as never);

    expect(res.status).toBe(401);
    expect(mocks.resolveEmittableEventsMock).not.toHaveBeenCalled();
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the generic apps audience', 'imajin:apps'],
    ['the kernel\'s registry audience', 'jin'],
    ['a multi-audience token that includes the kernel\'s', ['market', 'jin']],
  ])('accepts a service token minted for %s', async (_label, aud) => {
    mocks.verifyAppTokenMock.mockResolvedValue({ ...SERVICE_CLAIMS, aud });

    const res = await POST(req(validBody) as never);

    expect(res.status).toBe(201);
  });
});

describe('POST /api/events — rate limit per app (#2717)', () => {
  it('limits per verified app DID, with the kernel rateLimit helper', async () => {
    await POST(req(validBody) as never);

    expect(mocks.rateLimitMock).toHaveBeenCalledTimes(1);
    const [key, limit, windowMs] = mocks.rateLimitMock.mock.calls[0];
    expect(key).toContain(APP_DID);
    expect(limit).toBeGreaterThan(0);
    expect(windowMs).toBe(60_000);
  });

  it('answers 429 with Retry-After and publishes nothing once the app is over budget', async () => {
    mocks.rateLimitMock.mockReturnValue({ limited: true, retryAfter: 17 });

    const res = await POST(req(validBody) as never);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
    expect(await res.json()).toEqual({ error: 'rate_limited', retryAfter: 17 });
    expect(mocks.resolveEmittableEventsMock).not.toHaveBeenCalled();
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });

  it('does not spend an app\'s budget on an unauthenticated request', async () => {
    await POST(req(validBody, {}) as never);

    expect(mocks.rateLimitMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/events — body validation (400)', () => {
  it.each([
    ['invalid JSON', 'not json'],
    ['a non-object body', JSON.stringify([1, 2])],
    ['a missing type', { subject: RECIPIENT }],
    ['an uppercase type', { type: 'Tip.Granted', subject: RECIPIENT }],
    ['a wildcard type', { type: 'tip.*', subject: RECIPIENT }],
    ['a missing subject', { type: 'tip.granted' }],
    ['a subject that is not a DID', { type: 'tip.granted', subject: 'alice@example.com' }],
    ['an array payload', { ...validBody, payload: [1] }],
    ['a string payload', { ...validBody, payload: 'x' }],
    ['a payload over the size cap', { ...validBody, payload: { blob: 'x'.repeat(17 * 1024) } }],
    ['a non-string correlationId', { ...validBody, correlationId: 7 }],
    ['an over-long correlationId', { ...validBody, correlationId: 'c'.repeat(200) }],
    ['interestDids over the cap', { ...validBody, payload: { interestDids: manyDids(MAX_INTEREST_DIDS + 1) } }],
    ['interestDids far over the cap', { ...validBody, payload: { interestDids: manyDids(5000) } }],
    ['interestDids that is not an array', { ...validBody, payload: { interestDids: 'did:imajin:a' } }],
    ['an interestDids entry that is not a DID', { ...validBody, payload: { interestDids: ['did:imajin:a', 'alice@example.com'] } }],
    ['an interestDids entry that is not a string', { ...validBody, payload: { interestDids: [7] } }],
    ['an over-long interestDids entry', { ...validBody, payload: { interestDids: [`did:imajin:${'x'.repeat(300)}`] } }],
  ])('rejects %s without publishing', async (_label, body) => {
    const res = await POST(req(body) as never);

    expect(res.status).toBe(400);
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/events — payload.interestDids cap (#2717)', () => {
  it('accepts exactly the cap and hands the list to the bus untouched', async () => {
    const interestDids = manyDids(MAX_INTEREST_DIDS);

    const res = await POST(req({ ...validBody, payload: { interestDids } }) as never);

    expect(res.status).toBe(201);
    expect(mocks.publishAppEventMock.mock.calls[0][1].payload).toEqual({ interestDids });
  });

  it('accepts an empty list', async () => {
    const res = await POST(req({ ...validBody, payload: { interestDids: [] } }) as never);
    expect(res.status).toBe(201);
  });

  it('names the cap in the 400 so the caller can fix it', async () => {
    const res = await POST(req({ ...validBody, payload: { interestDids: manyDids(MAX_INTEREST_DIDS + 1) } }) as never);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(String(MAX_INTEREST_DIDS));
  });
});

describe('POST /api/events — kernel-owned namespaces (403)', () => {
  it.each(['payment_request.paid', 'loop.completed', 'attestation.created', 'vault.secret_read'])(
    'refuses %s even when a stored allowlist somehow holds it',
    async (type) => {
      mocks.resolveEmittableEventsMock.mockResolvedValue([type]);

      const res = await POST(req({ ...validBody, type }) as never);

      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('event_type_reserved');
      expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
    },
  );

  it('does not even consult the allowlist for a kernel-owned type', async () => {
    await POST(req({ ...validBody, type: 'payment_request.paid' }) as never);

    expect(mocks.resolveEmittableEventsMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/events — operator-approved allowlist (403)', () => {
  it('refuses an event type that is not on the app\'s approved list', async () => {
    const res = await POST(req({ ...validBody, type: 'listing.purchased' }) as never);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('event_type_not_approved');
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });

  it('refuses everything for an app with the default empty list', async () => {
    mocks.resolveEmittableEventsMock.mockResolvedValue([]);

    const res = await POST(req(validBody) as never);

    expect(res.status).toBe(403);
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });

  it('does not treat a prefix or a wildcard of an approved type as approved', async () => {
    const res = await POST(req({ ...validBody, type: 'tip.granted.extra' }) as never);

    expect(res.status).toBe(403);
  });

  it('refuses an app that is no longer active (revoked / unregistered)', async () => {
    mocks.resolveEmittableEventsMock.mockResolvedValue(null);

    const res = await POST(req(validBody) as never);

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('app_not_registered');
    expect(mocks.publishAppEventMock).not.toHaveBeenCalled();
  });

  it('looks the allowlist up by the VERIFIED app DID, not anything in the body', async () => {
    await POST(req({ ...validBody, appDid: 'did:imajin:someone-else', issuer: 'did:imajin:someone-else' }) as never);

    expect(mocks.resolveEmittableEventsMock).toHaveBeenCalledWith(APP_DID);
  });
});

describe('POST /api/events — accepted', () => {
  it('publishes as the verified app and returns 201 with the origin and the reactors that ran', async () => {
    const res = await POST(req({ ...validBody, correlationId: 'corr-1' }) as never);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, type: 'tip.granted', origin: APP_DID, ran: ['audit-log', 'notify'] });
    expect(mocks.publishAppEventMock).toHaveBeenCalledTimes(1);
    expect(mocks.publishAppEventMock).toHaveBeenCalledWith(
      'tip.granted',
      { subject: RECIPIENT, payload: { amount: 3, currency: 'USD' }, correlationId: 'corr-1' },
      APP_DID,
    );
  });

  it('never forwards a caller-supplied scope or issuer to the bus', async () => {
    await POST(req({ ...validBody, scope: 'pay', issuer: 'did:imajin:node' }) as never);

    const [, input, origin] = mocks.publishAppEventMock.mock.calls[0];
    expect(input).not.toHaveProperty('scope');
    expect(input).not.toHaveProperty('issuer');
    expect(origin).toBe(APP_DID);
  });

  it('accepts a payload omitted entirely', async () => {
    const res = await POST(req({ type: 'tip.sent', subject: RECIPIENT }) as never);

    expect(res.status).toBe(201);
    expect(mocks.publishAppEventMock.mock.calls[0][1]).toEqual({ subject: RECIPIENT, payload: undefined, correlationId: undefined });
  });
});

describe('OPTIONS /api/events', () => {
  it('answers the CORS preflight', () => {
    expect((OPTIONS as unknown as () => Response)().status).toBe(204);
  });
});
