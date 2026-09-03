/**
 * Tests for POST /auth/api/tokens/app/verify (#1069 Phase 1).
 *
 * Stateless verification counterpart to POST /auth/api/tokens/app. This is
 * the endpoint @imajin/auth's `verifyAppToken` calls into.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  },
}));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));

import { createSessionAppToken } from '@/src/lib/auth/jwt';
import { POST } from '../route';

const USER_DID = 'did:imajin:user-abc';
const APP_HOST = 'coffee.imajin.ai';

function verifyRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/auth/api/tokens/app/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /auth/api/tokens/app/verify — success (#1069 Phase 1)', () => {
  it('returns sub/aud/scopes for a valid token', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: ['profile:read'] });

    const res = await POST(verifyRequest({ token, aud: APP_HOST }) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ sub: USER_DID, aud: APP_HOST, scopes: ['profile:read'] });
  });

  it('succeeds without an aud check when none is supplied', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });

    const res = await POST(verifyRequest({ token }) as never);
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/api/tokens/app/verify — audience mismatch (#1069 Phase 1)', () => {
  it('rejects with 401 when aud does not match the token', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });

    const res = await POST(verifyRequest({ token, aud: 'market.imajin.ai' }) as never);

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/api/tokens/app/verify — scope enforcement (#1069 Phase 1)', () => {
  it('succeeds when the required scope is granted', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: ['profile:read', 'connections:read'] });

    const res = await POST(verifyRequest({ token, scope: 'profile:read' }) as never);
    expect(res.status).toBe(200);
  });

  it('rejects with 403 when the required scope was not granted', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: ['connections:read'] });

    const res = await POST(verifyRequest({ token, scope: 'profile:read' }) as never);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/profile:read/);
  });
});

describe('POST /auth/api/tokens/app/verify — malformed input (#1069 Phase 1)', () => {
  it('rejects an invalid/garbage token with 401', async () => {
    const res = await POST(verifyRequest({ token: 'not-a-real-token' }) as never);
    expect(res.status).toBe(401);
  });

  it('rejects a request with no token with 400', async () => {
    const res = await POST(verifyRequest({}) as never);
    expect(res.status).toBe(400);
  });
});
