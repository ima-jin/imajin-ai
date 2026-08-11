/**
 * Tests for POST /auth/api/apps/token/verify (#1069, hardened for #1800).
 *
 * This is the stateless verification step `requireAppAuth`'s bearer path
 * calls into. For #1800 it is the seam that must prove two things about a
 * service credential:
 *
 *   - Scope enforcement is unchanged: a required scope either is or isn't in
 *     the token, same as for any user-delegated app token.
 *   - Attribution: the returned `AppAuthContext` identifies the app-as-service
 *     principal (`isServiceToken: true`, `userDid: ''`) and never substitutes
 *     a human DID in its place.
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

import { createAppServiceToken, createAppToken } from '@/src/lib/auth/jwt';
import { POST } from '../route';

const APP_DID = 'did:imajin:agrifortress-webhook';
const HUMAN_DID = 'did:imajin:borrowed-human';

function verifyRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/auth/api/apps/token/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /auth/api/apps/token/verify — service credential attribution (#1800)', () => {
  it('identifies the app-as-service principal: isServiceToken, empty userDid, empty attestationId', async () => {
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'supply:read' });

    const res = await POST(verifyRequest({ token }) as never);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.appDid).toBe(APP_DID);
    expect(body.userDid).toBe('');
    expect(body.attestationId).toBe('');
    expect(body.isServiceToken).toBe(true);
    // Never a human — the whole point of #1800.
    expect(body.userDid).not.toBe(HUMAN_DID);
  });

  it('a user-delegated token identifies the human, with no isServiceToken flag', async () => {
    const token = await createAppToken({
      sub: HUMAN_DID,
      azp: APP_DID,
      scope: 'supply:read',
      attestationId: 'att_consent',
    });

    const res = await POST(verifyRequest({ token }) as never);
    const body = await res.json();

    expect(body.appDid).toBe(APP_DID);
    expect(body.userDid).toBe(HUMAN_DID);
    expect(body.attestationId).toBe('att_consent');
    expect(body.isServiceToken).toBeUndefined();
  });
});

describe('POST /auth/api/apps/token/verify — scope enforcement (#1800)', () => {
  it('succeeds when the required scope is granted', async () => {
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'supply:read supply:write' });

    const res = await POST(verifyRequest({ token, scope: 'supply:read' }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scopes).toEqual(['supply:read', 'supply:write']);
  });

  it('rejects with 403 when the required scope was not granted (out-of-scope)', async () => {
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'supply:write' });

    const res = await POST(verifyRequest({ token, scope: 'supply:read' }) as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/supply:read/);
  });

  it('rejects an invalid/garbage token with 401', async () => {
    const res = await POST(verifyRequest({ token: 'not-a-real-token' }) as never);
    expect(res.status).toBe(401);
  });

  it('rejects a request with no token with 400', async () => {
    const res = await POST(verifyRequest({}) as never);
    expect(res.status).toBe(400);
  });
});
