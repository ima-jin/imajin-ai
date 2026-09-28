/**
 * Unit tests for `POST /api/apps/claim` (#2411) — the claim-code exchange
 * a third-party app uses at first boot to fetch its own vault-minted
 * signing key. Covers: grant missing, grant revoked, wrong purpose, claim
 * code reused, claim code expired, and the success/audit shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  claimSigningKeyMock,
  fetchGrantSecretMock,
  getMintedKeyByDidMock,
  getNodeSigningIdentityMock,
  publishMock,
} = vi.hoisted(() => ({
  claimSigningKeyMock: vi.fn(),
  fetchGrantSecretMock: vi.fn(),
  getMintedKeyByDidMock: vi.fn(),
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
  APP_SIGNING_KEY_PURPOSE: 'app-signing-key',
}));
vi.mock('@/src/lib/vault', () => ({
  fetchGrantSecret: fetchGrantSecretMock,
}));
vi.mock('@/src/lib/vault/key-cards', () => ({
  getMintedKeyByDid: getMintedKeyByDidMock,
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
  return new Request('http://localhost/api/apps/claim', { method: 'POST', body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getNodeSigningIdentityMock.mockReturnValue({ senderDid: NODE_DID });
  getMintedKeyByDidMock.mockResolvedValue({ publicKey: 'the-public-key' });
});

describe('POST /api/apps/claim — validation', () => {
  it('rejects invalid JSON', async () => {
    const request = new Request('http://localhost/api/apps/claim', { method: 'POST', body: '{not json' });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
  });

  it('rejects a missing claimCode', async () => {
    const response = await POST(postRequest({}) as never);
    expect(response.status).toBe(400);
    expect(claimSigningKeyMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized hostHint', async () => {
    const response = await POST(postRequest({ claimCode: 'claim_x', hostHint: 'x'.repeat(201) }) as never);
    expect(response.status).toBe(400);
  });
});

describe('POST /api/apps/claim — claim code outcomes', () => {
  it('returns 404 for an unrecognized claim code', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'not_found' });

    const response = await POST(postRequest({ claimCode: 'claim_unknown' }) as never);

    expect(response.status).toBe(404);
    expect(fetchGrantSecretMock).not.toHaveBeenCalled();
  });

  // #2411 required test: claim code reused.
  it('returns 410 when the claim code has already been redeemed (claim code reused)', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'already_claimed' });

    const response = await POST(postRequest({ claimCode: 'claim_used' }) as never);
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.error).toMatch(/already been redeemed/);
    expect(fetchGrantSecretMock).not.toHaveBeenCalled();
  });

  // #2411 required test: claim code expired.
  it('returns 410 when the claim code has expired', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'expired' });

    const response = await POST(postRequest({ claimCode: 'claim_stale' }) as never);
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.error).toMatch(/expired/);
  });
});

describe('POST /api/apps/claim — grant outcomes (after a valid claim)', () => {
  beforeEach(() => {
    claimSigningKeyMock.mockResolvedValue({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
  });

  // #2411 required test: grant missing.
  it('returns 404 when the underlying grant no longer exists (grant missing)', async () => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'not_found' });

    const response = await POST(postRequest({ claimCode: 'claim_valid' }) as never);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toMatch(/no longer exists/);
  });

  // #2411 required test: grant revoked.
  it('returns 403 when the underlying grant has been revoked (grant revoked)', async () => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'inactive' });

    const response = await POST(postRequest({ claimCode: 'claim_valid' }) as never);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/revoked/);
  });

  it('returns 403 when the underlying grant has expired', async () => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'expired' });

    const response = await POST(postRequest({ claimCode: 'claim_valid' }) as never);
    expect(response.status).toBe(403);
  });

  it('returns 410 when the underlying (one-time) grant was already consumed', async () => {
    fetchGrantSecretMock.mockResolvedValue({ status: 'consumed' });

    const response = await POST(postRequest({ claimCode: 'claim_valid' }) as never);
    expect(response.status).toBe(410);
  });

  // #2411 required test: wrong purpose.
  it('refuses with 500 when the resolved grant has an unexpected purpose (wrong purpose)', async () => {
    fetchGrantSecretMock.mockResolvedValue({
      status: 'ok',
      value: 'private-key-hex',
      grant: { purpose: 'some-other-purpose' },
    });

    const response = await POST(postRequest({ claimCode: 'claim_valid' }) as never);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('private-key-hex');
  });
});

describe('POST /api/apps/claim — success', () => {
  it('returns the appDid/privateKey/publicKey on a fully successful exchange', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    fetchGrantSecretMock.mockResolvedValue({
      status: 'ok',
      value: 'private-key-hex',
      grant: { purpose: 'app-signing-key' },
    });

    const response = await POST(postRequest({ claimCode: 'claim_valid', hostHint: 'dykil-standalone' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ appDid: APP_DID, privateKey: 'private-key-hex', publicKey: 'the-public-key' });
    expect(claimSigningKeyMock).toHaveBeenCalledWith({ code: 'claim_valid', hostHint: 'dykil-standalone' });
    expect(fetchGrantSecretMock).toHaveBeenCalledWith({ grantId: GRANT_ID, granteeDid: APP_DID });
  });

  it('never leaks the private key on a non-2xx response', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    fetchGrantSecretMock.mockResolvedValue({ status: 'inactive' });

    const response = await POST(postRequest({ claimCode: 'claim_valid' }) as never);
    const text = await response.text();

    expect(text).not.toContain('privateKey');
  });

  it('emits apps.signing-key.claimed and apps.signing-key.fetched, never carrying the private key or claim code', async () => {
    claimSigningKeyMock.mockResolvedValue({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    fetchGrantSecretMock.mockResolvedValue({
      status: 'ok',
      value: 'private-key-hex',
      grant: { purpose: 'app-signing-key' },
    });

    await POST(postRequest({ claimCode: 'claim_valid' }) as never);

    expect(publishMock).toHaveBeenCalledWith('apps.signing-key.claimed', expect.objectContaining({
      payload: expect.objectContaining({ slug: SLUG, appDid: APP_DID, grantId: GRANT_ID }),
    }));
    expect(publishMock).toHaveBeenCalledWith('apps.signing-key.fetched', expect.objectContaining({
      payload: expect.objectContaining({ slug: SLUG, appDid: APP_DID, grantId: GRANT_ID, outcome: 'ok' }),
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

    const response = await POST(postRequest({ claimCode: 'claim_valid' }) as never);

    expect(response.status).toBe(500);
  });
});
