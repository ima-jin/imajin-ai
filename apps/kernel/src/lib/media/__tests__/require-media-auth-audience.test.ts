/**
 * #2706: kernel media verifies scoped app-tokens against its seeded `jin`
 * registry audience — never the node's host, which every path-routed app shares.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('next/server', () => ({ NextResponse: { json: vi.fn() } }));
vi.mock('@imajin/auth/delegation-policy', () => ({ enforceRoutePolicy: vi.fn() }));

import { createAuthMock, createLoggerMock, appToken } from './media-auth-test-helpers';

const mockVerifyAppToken = vi.hoisted(() => vi.fn());
vi.mock('@imajin/auth', () => createAuthMock(mockVerifyAppToken));
vi.mock('@imajin/logger', () => createLoggerMock());

import { requireMediaAuth, MEDIA_APP_AUDIENCE } from '../require-media-auth';
import { requireAuth } from '@imajin/auth';

function request(): NextRequest {
  return new Request('https://dev-jin.imajin.ai/media/api/assets', {
    headers: { authorization: 'Bearer scoped-token' },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireMediaAuth audience (#2706)', () => {
  it('is the seeded `jin` slug, not a host', () => {
    expect(MEDIA_APP_AUDIENCE).toBe('jin');
  });

  it('verifies the Bearer against `jin`', async () => {
    mockVerifyAppToken.mockResolvedValue(appToken(['media:read']));

    const result = await requireMediaAuth(request(), 'media:read');

    expect(mockVerifyAppToken).toHaveBeenCalledWith('scoped-token', { aud: 'jin' });
    expect(result).toEqual({ auth: { did: 'did:imajin:app-user', identity: null } });
  });

  it('rejects a token for another audience: it falls through to requireAuth and gets its 401', async () => {
    mockVerifyAppToken.mockResolvedValue(null);
    vi.mocked(requireAuth).mockResolvedValueOnce({ error: 'Unauthorized', status: 401 } as never);

    const result = await requireMediaAuth(request(), 'media:read');

    expect(result).toEqual({ error: 'Unauthorized', status: 401 });
  });
});
