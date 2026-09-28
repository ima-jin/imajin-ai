/**
 * Unit tests for `POST /api/apps/signing-key/fetch` (#2411) — every boot
 * AFTER the first-boot claim exchange re-fetches the signing key here,
 * authenticated by a bootstrap-key signature instead of a claim code.
 * Covers the issue's required cases: wrong bootstrap key -> 401, replayed
 * nonce -> 401, no binding (no keystore/no code completed) -> 404, and
 * grant missing/revoked -> the shared status mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  verifyBootstrapFetchAuthMock,
  resolveSigningKeyForGrantMock,
  getNodeSigningIdentityMock,
  publishMock,
} = vi.hoisted(() => ({
  verifyBootstrapFetchAuthMock: vi.fn(),
  resolveSigningKeyForGrantMock: vi.fn(),
  getNodeSigningIdentityMock: vi.fn(),
  publishMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));
vi.mock('@/src/lib/apps/bootstrap-fetch-auth', () => ({
  verifyBootstrapFetchAuth: verifyBootstrapFetchAuthMock,
}));
vi.mock('@/src/lib/apps/signing-key-fetch', () => ({
  resolveSigningKeyForGrant: resolveSigningKeyForGrantMock,
  statusForSigningKeyFetchOutcome: (status: string) => {
    if (status === 'not_found' || status === 'not_grantee') return 404;
    if (status === 'consumed') return 410;
    if (status === 'wrong_purpose') return 500;
    return 403;
  },
  errorForSigningKeyFetchOutcome: (status: string) => `error-for-${status}`,
  emitSigningKeyFetchedEvent: (params: { nodeDid: string; slug: string; appDid: string; grantId: string; outcome: string; via: string }) => {
    publishMock('apps.signing-key.fetched', {
      issuer: params.nodeDid,
      subject: params.appDid,
      scope: 'apps',
      payload: { slug: params.slug, appDid: params.appDid, grantId: params.grantId, outcome: params.outcome, via: params.via },
    });
  },
}));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: getNodeSigningIdentityMock,
}));

import { POST } from '../route';

const NODE_DID = 'did:imajin:node';
const APP_DID = 'did:imajin:app-under-test';
const GRANT_ID = 'vdg_app_self_1';
const SLUG = 'dykil';

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/apps/signing-key/fetch', { method: 'POST', body: JSON.stringify(body) });
}

function validBody(overrides: Partial<{ appDid: string; timestamp: number; nonce: string; signature: string }> = {}) {
  return { appDid: APP_DID, timestamp: Date.now(), nonce: 'nonce-1', signature: 'sig-hex', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  getNodeSigningIdentityMock.mockReturnValue({ senderDid: NODE_DID });
});

describe('POST /api/apps/signing-key/fetch — validation', () => {
  it('rejects invalid JSON', async () => {
    const request = new Request('http://localhost/api/apps/signing-key/fetch', { method: 'POST', body: '{not json' });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
  });

  it('rejects a missing appDid', async () => {
    const response = await POST(postRequest({ timestamp: Date.now(), nonce: 'n', signature: 's' }) as never);
    expect(response.status).toBe(400);
    expect(verifyBootstrapFetchAuthMock).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric timestamp', async () => {
    const response = await POST(postRequest({ ...validBody(), timestamp: 'not-a-number' }) as never);
    expect(response.status).toBe(400);
  });

  it('rejects a missing nonce', async () => {
    const response = await POST(postRequest({ appDid: APP_DID, timestamp: Date.now(), signature: 's' }) as never);
    expect(response.status).toBe(400);
  });

  it('rejects a missing signature', async () => {
    const response = await POST(postRequest({ appDid: APP_DID, timestamp: Date.now(), nonce: 'n' }) as never);
    expect(response.status).toBe(400);
  });
});

describe('POST /api/apps/signing-key/fetch — auth outcomes', () => {
  // #2411 required test: no keystore/no claim completed -> no binding.
  it('returns 404 when no bootstrap key is bound for this app (no binding)', async () => {
    verifyBootstrapFetchAuthMock.mockResolvedValue({ status: 'no_binding' });

    const response = await POST(postRequest(validBody()) as never);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toMatch(/complete the first-boot claim exchange/);
    expect(resolveSigningKeyForGrantMock).not.toHaveBeenCalled();
  });

  // #2411 required test: wrong bootstrap key -> 401.
  it('returns 401 for an invalid (wrong-key) signature', async () => {
    verifyBootstrapFetchAuthMock.mockResolvedValue({ status: 'invalid_signature' });

    const response = await POST(postRequest(validBody()) as never);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toMatch(/[Ii]nvalid/);
  });

  it('returns 401 for a stale timestamp', async () => {
    verifyBootstrapFetchAuthMock.mockResolvedValue({ status: 'stale_timestamp' });

    const response = await POST(postRequest(validBody()) as never);

    expect(response.status).toBe(401);
  });

  // #2411 required test: replayed nonce -> 401.
  it('returns 401 for a replayed nonce', async () => {
    verifyBootstrapFetchAuthMock.mockResolvedValue({ status: 'replayed_nonce' });

    const response = await POST(postRequest(validBody()) as never);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toMatch(/already been used/);
  });
});

describe('POST /api/apps/signing-key/fetch — grant outcomes (after valid auth)', () => {
  beforeEach(() => {
    verifyBootstrapFetchAuthMock.mockResolvedValue({ status: 'ok', binding: { slug: SLUG, appDid: APP_DID, grantId: GRANT_ID, boundPublicKey: 'pub' } });
  });

  it('returns 404 when the underlying grant no longer exists', async () => {
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'not_found' });

    const response = await POST(postRequest(validBody()) as never);

    expect(response.status).toBe(404);
  });

  it('returns 403 when the underlying grant has been revoked', async () => {
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'inactive' });

    const response = await POST(postRequest(validBody()) as never);

    expect(response.status).toBe(403);
  });
});

describe('POST /api/apps/signing-key/fetch — success', () => {
  it('returns the signing key and emits apps.signing-key.fetched with via: bootstrap-key', async () => {
    verifyBootstrapFetchAuthMock.mockResolvedValue({ status: 'ok', binding: { slug: SLUG, appDid: APP_DID, grantId: GRANT_ID, boundPublicKey: 'pub' } });
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'ok', appDid: APP_DID, privateKey: 'private-hex', publicKey: 'public-hex' });

    const response = await POST(postRequest(validBody()) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ appDid: APP_DID, privateKey: 'private-hex', publicKey: 'public-hex' });
    expect(publishMock).toHaveBeenCalledWith('apps.signing-key.fetched', expect.objectContaining({
      payload: expect.objectContaining({ slug: SLUG, appDid: APP_DID, grantId: GRANT_ID, outcome: 'ok', via: 'bootstrap-key' }),
    }));
  });

  it('never leaks the private key or signature on a non-2xx response', async () => {
    verifyBootstrapFetchAuthMock.mockResolvedValue({ status: 'invalid_signature' });

    const response = await POST(postRequest(validBody({ signature: 'super-secret-signature' })) as never);
    const text = await response.text();

    expect(text).not.toContain('privateKey');
    expect(text).not.toContain('super-secret-signature');
  });
});

describe('POST /api/apps/signing-key/fetch — error handling', () => {
  it('returns 500 when verifyBootstrapFetchAuth throws unexpectedly', async () => {
    verifyBootstrapFetchAuthMock.mockRejectedValue(new Error('db unavailable'));

    const response = await POST(postRequest(validBody()) as never);

    expect(response.status).toBe(500);
  });
});
