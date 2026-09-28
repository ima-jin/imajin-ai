/**
 * Unit tests for `POST /api/apps/claim` (#2411) — the claim-code exchange
 * a third-party app uses at first boot to fetch its own vault-minted
 * signing key. Covers: bootstrapPublicKey validation, claim code outcomes
 * (reused, expired), grant outcomes (missing, revoked, wrong purpose) via
 * the shared `signing-key-fetch` module, and the success/audit shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  claimSigningKeyMock,
  resolveSigningKeyForGrantMock,
  getNodeSigningIdentityMock,
  publishMock,
} = vi.hoisted(() => ({
  claimSigningKeyMock: vi.fn(),
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
vi.mock('@/src/lib/apps/signing-key-claims', () => ({
  claimSigningKey: claimSigningKeyMock,
}));
// Full manual mock of the shared grant-fetch module — its own unit tests
// (signing-key-fetch.test.ts) cover the status/error mapping logic itself;
// this route only needs to verify it delegates to it correctly and tags
// the audit event with `via: 'claim'`.
vi.mock('@/src/lib/apps/signing-key-fetch', () => ({
  resolveSigningKeyForGrant: resolveSigningKeyForGrantMock,
  statusForSigningKeyFetchOutcome: (status: string) => {
    if (status === 'not_found' || status === 'not_grantee') return 404;
    if (status === 'consumed') return 410;
    if (status === 'wrong_purpose') return 500;
    return 403;
  },
  errorForSigningKeyFetchOutcome: (status: string) => {
    if (status === 'not_found' || status === 'not_grantee') return 'The app-signing-key grant no longer exists';
    if (status === 'consumed') return 'The app-signing-key grant has already been fetched';
    if (status === 'inactive') return 'The app-signing-key grant is no longer active (revoked)';
    if (status === 'expired') return 'The app-signing-key grant has expired';
    return 'Unable to fetch the app-signing-key grant';
  },
  emitSigningKeyFetchedEvent: (params: { nodeDid: string; slug: string; appDid: string; grantId: string; outcome: string; via: string }) => {
    publishMock('apps.signing-key.fetched', {
      issuer: params.nodeDid,
      subject: params.appDid,
      scope: 'apps',
      payload: { slug: params.slug, appDid: params.appDid, grantId: params.grantId, outcome: params.outcome, via: params.via, context_id: params.appDid, context_type: 'apps.signing-key' },
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
const BOOTSTRAP_PUBLIC_KEY = 'a'.repeat(64);

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/apps/claim', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getNodeSigningIdentityMock.mockReturnValue({ senderDid: NODE_DID });
});

describe('POST /api/apps/claim — validation', () => {
  it('rejects invalid JSON', async () => {
    const request = new Request('http://localhost/api/apps/claim', { method: 'POST', body: '{not json' });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
  });

  it('rejects a missing claimCode', async () => {
    const response = await POST(postRequest({ bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    expect(response.status).toBe(400);
    expect(claimSigningKeyMock).not.toHaveBeenCalled();
  });

  it('rejects a missing bootstrapPublicKey', async () => {
    const response = await POST(postRequest({ claimCode: 'claim_x' }) as never);
    expect(response.status).toBe(400);
    expect(claimSigningKeyMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-hex, wrong-length) bootstrapPublicKey', async () => {
    const response = await POST(postRequest({ claimCode: 'claim_x', bootstrapPublicKey: 'not-hex' }) as never);
    expect(response.status).toBe(400);
    expect(claimSigningKeyMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized hostHint', async () => {
    const response = await POST(postRequest({ claimCode: 'claim_x', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY, hostHint: 'x'.repeat(201) }) as never);
    expect(response.status).toBe(400);
  });
});

describe('POST /api/apps/claim — claim code outcomes', () => {
  it('returns 404 for an unrecognized claim code', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'not_found' });

    const response = await POST(postRequest({ claimCode: 'claim_unknown', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);

    expect(response.status).toBe(404);
    expect(resolveSigningKeyForGrantMock).not.toHaveBeenCalled();
  });

  // #2411 required test: claim code reused.
  it('returns 410 when the claim code has already been redeemed (claim code reused)', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'already_claimed' });

    const response = await POST(postRequest({ claimCode: 'claim_used', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.error).toMatch(/already been redeemed/);
    expect(resolveSigningKeyForGrantMock).not.toHaveBeenCalled();
  });

  // #2411 required test: claim code expired.
  it('returns 410 when the claim code has expired', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'expired' });

    const response = await POST(postRequest({ claimCode: 'claim_stale', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.error).toMatch(/expired/);
  });

  it('passes the lowercased bootstrapPublicKey through to claimSigningKey', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'not_found' });

    await POST(postRequest({ claimCode: 'claim_x', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY.toUpperCase() }) as never);

    expect(claimSigningKeyMock).toHaveBeenCalledWith({ code: 'claim_x', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY, hostHint: null });
  });
});

describe('POST /api/apps/claim — grant outcomes (after a valid claim)', () => {
  beforeEach(() => {
    claimSigningKeyMock.mockResolvedValue({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
  });

  // #2411 required test: grant missing.
  it('returns 404 when the underlying grant no longer exists (grant missing)', async () => {
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'not_found' });

    const response = await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toMatch(/no longer exists/);
  });

  // #2411 required test: grant revoked.
  it('returns 403 when the underlying grant has been revoked (grant revoked)', async () => {
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'inactive' });

    const response = await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/revoked/);
  });

  it('returns 403 when the underlying grant has expired', async () => {
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'expired' });

    const response = await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    expect(response.status).toBe(403);
  });

  it('returns 410 when the underlying (one-time) grant was already consumed', async () => {
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'consumed' });

    const response = await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    expect(response.status).toBe(410);
  });

  // #2411 required test: wrong purpose.
  it('refuses with 500 when the resolved grant has an unexpected purpose (wrong purpose)', async () => {
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'wrong_purpose' });

    const response = await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('private-key-hex');
  });
});

describe('POST /api/apps/claim — success', () => {
  it('returns the appDid/privateKey/publicKey on a fully successful exchange', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'ok', appDid: APP_DID, privateKey: 'private-key-hex', publicKey: 'the-public-key' });

    const response = await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY, hostHint: 'dykil-standalone' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ appDid: APP_DID, privateKey: 'private-key-hex', publicKey: 'the-public-key' });
    expect(claimSigningKeyMock).toHaveBeenCalledWith({ code: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY, hostHint: 'dykil-standalone' });
    expect(resolveSigningKeyForGrantMock).toHaveBeenCalledWith({ grantId: GRANT_ID, appDid: APP_DID });
  });

  it('never leaks the private key on a non-2xx response', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'inactive' });

    const response = await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);
    const text = await response.text();

    expect(text).not.toContain('privateKey');
  });

  it('emits apps.signing-key.claimed and apps.signing-key.fetched (via: claim), never carrying the private key or claim code', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    resolveSigningKeyForGrantMock.mockResolvedValue({ status: 'ok', appDid: APP_DID, privateKey: 'private-key-hex', publicKey: 'the-public-key' });

    await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);

    expect(publishMock).toHaveBeenCalledWith('apps.signing-key.claimed', expect.objectContaining({
      payload: expect.objectContaining({ slug: SLUG, appDid: APP_DID, grantId: GRANT_ID }),
    }));
    expect(publishMock).toHaveBeenCalledWith('apps.signing-key.fetched', expect.objectContaining({
      payload: expect.objectContaining({ slug: SLUG, appDid: APP_DID, grantId: GRANT_ID, outcome: 'ok', via: 'claim' }),
    }));
    for (const call of publishMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('private-key-hex');
      expect(JSON.stringify(call)).not.toContain('claim_valid');
    }
  });
});

describe('POST /api/apps/claim — error handling', () => {
  it('returns 500 when claimSigningKey throws unexpectedly', async () => {
    claimSigningKeyMock.mockRejectedValue(new Error('db unavailable'));

    const response = await POST(postRequest({ claimCode: 'claim_valid', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY }) as never);

    expect(response.status).toBe(500);
  });
});
