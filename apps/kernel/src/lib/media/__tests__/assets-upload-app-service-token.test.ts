/**
 * #2747: an app's OWN `app-service+jwt` (minted by POST /auth/api/apps/token/service)
 * authenticates POST /media/api/assets.
 *
 * Unlike the neighbouring auth-mode suites, the token here is minted with the
 * real `createAppServiceToken` and verified by the real verify path
 * (`verifyAppServiceToken` + the live registry check) — only the DB rows, the
 * session-app transport (`@imajin/auth`'s `verifyAppToken`, an HTTP call to the
 * kernel's own session-app verify route) and the asset pipeline are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateAsset = vi.hoisted(() => vi.fn());
const mockSelectLimit = vi.hoisted(() => vi.fn());

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockSelectLimit })) })),
    })),
  },
  assets: {},
  identities: { id: 'id', tier: 'tier', uploadLimitMb: 'uploadLimitMb' },
  registryApps: { appDid: 'appDid', status: 'status' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  ilike: vi.fn(),
  like: vi.fn(),
}));

import { createAuthMock, createNodeUrlMock, createLoggerMock } from './media-auth-test-helpers';

const mockVerifyAppToken = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@imajin/auth', () => createAuthMock(mockVerifyAppToken));
vi.mock('@/src/lib/http/node-url', () => createNodeUrlMock());
vi.mock('@imajin/logger', () => createLoggerMock());
vi.mock('@imajin/config', () => ({
  rateLimit: vi.fn(() => ({ limited: false })),
  getClientIP: vi.fn(() => '127.0.0.1'),
}));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: vi.fn(() => ({})),
  corsOptions: vi.fn(() => new Response(null, { status: 204 })),
}));
vi.mock('@/src/lib/media/create-asset', () => ({
  createAsset: mockCreateAsset,
  inferMime: (browserMime: string) => browserMime,
  isAllowedMime: () => true,
}));

import type { NextRequest } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { POST } from '@/app/media/api/assets/route';
import { createAppServiceToken, createAppToken } from '@/src/lib/auth/jwt';

const APP_DID = 'did:imajin:dykil-app';
const USER_DID = 'did:imajin:legacy-survey-owner';

function uploadRequest(bearer: string): NextRequest {
  const form = new FormData();
  form.append('file', new File(['hello'], 'note.txt', { type: 'text/plain' }), 'note.txt');
  return new Request('https://test.imajin.ai/media/api/assets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
    body: form,
  }) as unknown as NextRequest;
}

/** Registry row lookup (status), then the uploader's identity-row lookup (none: an app has no identity row). */
function registry(status: string | null) {
  mockSelectLimit.mockResolvedValueOnce(status ? [{ status }] : []).mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAppToken.mockResolvedValue(null);
  vi.mocked(requireAuth).mockResolvedValue({ error: 'Unauthorized', status: 401 } as never);
  mockCreateAsset.mockResolvedValue({
    asset: {
      id: 'asset_new',
      filename: 'note.txt',
      mimeType: 'text/plain',
      size: 5,
      hash: 'deadbeef',
      cid: 'bafytest',
      storagePath: '/mnt/media/x/assets/asset_new.txt',
      fairManifest: {},
      createdAt: new Date('2026-10-09T00:00:00Z'),
    },
    deduplicated: false,
  });
});

describe('POST /media/api/assets — app-service token (#2747)', () => {
  it('accepts the app’s own token carrying media:write and owns the asset by the app DID', async () => {
    registry('active');
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'media:write' });

    const res = await POST(uploadRequest(token));

    expect(res.status).toBe(201);
    expect(mockCreateAsset).toHaveBeenCalledWith(expect.objectContaining({ ownerDid: APP_DID, uploadedBy: APP_DID }));
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it('is terminal 403 — never session auth — when the token lacks media:write', async () => {
    registry('active');
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'media:read supply:read' });

    const res = await POST(uploadRequest(token));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Missing required scope: media:write' });
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it('refuses a token whose app is no longer active (revocation bites before the TTL)', async () => {
    registry('revoked');
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'media:write' });

    const res = await POST(uploadRequest(token));

    expect(res.status).toBe(401);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('refuses a token for an app that is not in the registry', async () => {
    registry(null);
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'media:write' });

    expect((await POST(uploadRequest(token))).status).toBe(401);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('refuses a service token minted for another audience', async () => {
    registry('active');
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'media:write', aud: 'some-other-app' });

    expect((await POST(uploadRequest(token))).status).toBe(401);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('refuses a user-delegated app+jwt: only the service type is accepted, so a user identity is never assumed', async () => {
    registry('active');
    const token = await createAppToken({ sub: USER_DID, azp: APP_DID, scope: 'media:write', attestationId: 'att_1' });

    expect((await POST(uploadRequest(token))).status).toBe(401);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('refuses a tampered token', async () => {
    registry('active');
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'media:write' });
    const [header, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: USER_DID })).toString('base64url');

    expect((await POST(uploadRequest(`${header}.${forged}.${signature}`))).status).toBe(401);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it('leaves the session-app path as it was: a verified session-app token still wins, owned by its user', async () => {
    mockVerifyAppToken.mockResolvedValue({ sub: USER_DID, aud: 'jin', scopes: ['media:write'] } as never);

    const res = await POST(uploadRequest('session-app-token'));

    expect(res.status).toBe(201);
    expect(mockCreateAsset).toHaveBeenCalledWith(expect.objectContaining({ ownerDid: USER_DID }));
    expect(mockSelectLimit).toHaveBeenCalledTimes(1); // the identity-row lookup only — no registry check
  });
});
