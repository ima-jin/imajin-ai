import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// DELETE and PATCH /media/api/assets/[id] are owner-only mutations (#2393):
// this suite exercises both auth modes requireMediaAuth now supports — the
// pre-existing session cookie (via requireAuth, unchanged) and a scoped
// app-token (verifyAppToken) — plus the actingFor agent-delegation gate,
// which only applies on the session path.

const mockAssetLimit = vi.hoisted(() => vi.fn());
const mockUpdateWhere = vi.hoisted(() => vi.fn(async () => undefined));
const mockDeleteWhere = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: mockAssetLimit })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: mockUpdateWhere })) })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
  },
  assets: {},
  assetReferences: {},
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

import { createAuthMock, createNodeUrlMock, createLoggerMock, appToken, APP_TOKEN_WRITE_ONLY, APP_TOKEN_NO_SCOPES } from './media-auth-test-helpers';

const mockVerifyAppToken = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@imajin/auth', () => createAuthMock(mockVerifyAppToken));
vi.mock('@/src/lib/http/node-url', () => createNodeUrlMock());
vi.mock('@imajin/logger', () => createLoggerMock());

const mockUnlink = vi.hoisted(() => vi.fn(async () => undefined));
const mockRename = vi.hoisted(() => vi.fn(async () => undefined));
const mockReadFile = vi.hoisted(() => vi.fn(async () => Buffer.from('')));
vi.mock('node:fs/promises', () => ({ readFile: mockReadFile, unlink: mockUnlink, rename: mockRename }));

import { DELETE, PATCH } from '@/app/media/api/assets/[id]/route';
import { requireAuth } from '@imajin/auth';

// ─── Helpers ───────────────────────────────────────────────────────────────

const params = Promise.resolve({ id: 'asset_test' });

function makeRequest(method: 'DELETE' | 'PATCH', body?: unknown, bearer?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return new Request('https://test.imajin.ai/media/api/assets/asset_test', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

const activeAsset = {
  id: 'asset_test',
  status: 'active',
  ownerDid: 'did:imajin:owner',
  immutable: false,
  storagePath: '/mnt/media/asset_test.bin',
  fairPath: null as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyAppToken.mockResolvedValue(null);
  mockAssetLimit.mockResolvedValue([activeAsset]);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockDeleteWhere.mockResolvedValue(undefined);
});

// ─── DELETE ────────────────────────────────────────────────────────────────

describe('DELETE /media/api/assets/[id] — auth modes (#2393)', () => {
  it('deletes the asset for the resolved session identity on the cookie path', async () => {
    const res = await DELETE(makeRequest('DELETE'), { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockVerifyAppToken).not.toHaveBeenCalled();
  });

  it('accepts a scoped app-token carrying media:write and allows the token subject to delete its own asset', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_WRITE_ONLY, 'did:imajin:owner'));

    const res = await DELETE(makeRequest('DELETE', undefined, 'scoped-app-token'), { params });

    expect(res.status).toBe(200);
    expect(vi.mocked(requireAuth)).not.toHaveBeenCalled();
  });

  it('returns 403 when a properly-scoped app-token subject does not own the asset', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_WRITE_ONLY, 'did:imajin:stranger'));

    const res = await DELETE(makeRequest('DELETE', undefined, 'scoped-app-token'), { params });

    expect(res.status).toBe(403);
  });

  it('rejects a scoped app-token that lacks media:write with 403, without deleting', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_NO_SCOPES, 'did:imajin:owner'));

    const res = await DELETE(makeRequest('DELETE', undefined, 'read-only-app-token'), { params });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('media:write');
    expect(vi.mocked(requireAuth)).not.toHaveBeenCalled();
    expect(mockDeleteWhere).not.toHaveBeenCalled();
  });

  it('still blocks actingFor agent delegation on the session path', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      identity: { id: 'did:imajin:agent', scope: 'actor', actingFor: 'did:imajin:owner' },
    });

    const res = await DELETE(makeRequest('DELETE'), { params });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('AGENT_APPROVAL_REQUIRED');
  });

  it('returns 401 when neither a scoped app-token nor session auth verifies', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await DELETE(makeRequest('DELETE'), { params });

    expect(res.status).toBe(401);
  });
});

// ─── PATCH ─────────────────────────────────────────────────────────────────

describe('PATCH /media/api/assets/[id] — auth modes (#2393)', () => {
  it('renames the asset for the resolved session identity on the cookie path', async () => {
    const res = await PATCH(makeRequest('PATCH', { filename: 'renamed.bin' }), { params });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, filename: 'renamed.bin' });
    expect(mockVerifyAppToken).not.toHaveBeenCalled();
  });

  it('accepts a scoped app-token carrying media:write and allows the token subject to rename its own asset', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_WRITE_ONLY, 'did:imajin:owner'));

    const res = await PATCH(
      makeRequest('PATCH', { filename: 'renamed.bin' }, 'scoped-app-token'),
      { params },
    );

    expect(res.status).toBe(200);
    expect(vi.mocked(requireAuth)).not.toHaveBeenCalled();
  });

  it('returns 403 when a properly-scoped app-token subject does not own the asset', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_WRITE_ONLY, 'did:imajin:stranger'));

    const res = await PATCH(
      makeRequest('PATCH', { filename: 'renamed.bin' }, 'scoped-app-token'),
      { params },
    );

    expect(res.status).toBe(403);
  });

  it('rejects a scoped app-token that lacks media:write with 403, without renaming', async () => {
    mockVerifyAppToken.mockResolvedValueOnce(appToken(APP_TOKEN_NO_SCOPES, 'did:imajin:owner'));

    const res = await PATCH(
      makeRequest('PATCH', { filename: 'renamed.bin' }, 'read-only-app-token'),
      { params },
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('media:write');
    expect(vi.mocked(requireAuth)).not.toHaveBeenCalled();
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('still blocks actingFor agent delegation on the session path', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({
      identity: { id: 'did:imajin:agent', scope: 'actor', actingFor: 'did:imajin:owner' },
    });

    const res = await PATCH(makeRequest('PATCH', { filename: 'renamed.bin' }), { params });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('AGENT_APPROVAL_REQUIRED');
  });

  it('returns 401 when neither a scoped app-token nor session auth verifies', async () => {
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Not authenticated', status: 401 });

    const res = await PATCH(makeRequest('PATCH', { filename: 'renamed.bin' }), { params });

    expect(res.status).toBe(401);
  });
});
