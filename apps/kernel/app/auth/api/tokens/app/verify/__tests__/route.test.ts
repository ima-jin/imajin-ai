/**
 * Tests for POST /auth/api/tokens/app/verify (#1069 Phase 1).
 *
 * Stateless verification counterpart to POST /auth/api/tokens/app. This is
 * the endpoint @imajin/auth's `verifyAppToken` calls into.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const mocks = vi.hoisted(() => ({ resolveActiveAppByAudienceMock: vi.fn() }));
vi.mock('@/src/lib/kernel/app-registry', () => ({
  resolveActiveAppByAudience: mocks.resolveActiveAppByAudienceMock,
  appNotRegisteredResponse: () =>
    new Response(JSON.stringify({ error: 'app_not_registered', error_description: 'not registered' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
}));

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

beforeEach(() => {
  mocks.resolveActiveAppByAudienceMock.mockReset().mockResolvedValue({
    id: 'app_first_party_coffee',
    appDid: 'did:imajin:app-coffee',
    ownerDid: 'did:imajin:platform',
    tier: 'first_party',
    status: 'active',
  });
});

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

describe('POST /auth/api/tokens/app/verify — registry revocation recheck (#1990)', () => {
  it('rejects with 403 app_not_registered once the audience is no longer registered/active', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: ['profile:read'] });
    mocks.resolveActiveAppByAudienceMock.mockResolvedValue(null);

    const res = await POST(verifyRequest({ token }) as never);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('app_not_registered');
    expect(mocks.resolveActiveAppByAudienceMock).toHaveBeenCalledWith(APP_HOST);
  });
});

describe('POST /auth/api/tokens/app/verify — multi-audience tokens (#2663 gap 2)', () => {
  const MEDIA_HOST = 'jin.imajin.ai';
  const scopes = ['dykil:read', 'media:read'];

  /** The app row for APP_HOST (the token's primary audience), declaring its dependency. */
  const APP_ROW = {
    id: 'app_dykil',
    appDid: 'did:imajin:app-dykil',
    ownerDid: 'did:imajin:platform',
    tier: 'third_party',
    status: 'active',
    dependsOn: [{ aud: MEDIA_HOST, scopes: ['media:read'] }],
  };
  const KERNEL_ROW = { id: 'app_kernel', appDid: 'did:imajin:kernel', ownerDid: 'did:imajin:platform', tier: 'first_party', status: 'active', dependsOn: [] };

  beforeEach(() => {
    mocks.resolveActiveAppByAudienceMock.mockImplementation(async (aud: string) => (aud === APP_HOST ? APP_ROW : KERNEL_ROW));
  });

  it('verifies the same token for the app audience and for the dependency audience', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST], scopes });

    const forApp = await POST(verifyRequest({ token, aud: APP_HOST }) as never);
    const forMedia = await POST(verifyRequest({ token, aud: MEDIA_HOST }) as never);

    expect(forApp.status).toBe(200);
    expect(await forApp.json()).toEqual({ sub: USER_DID, aud: APP_HOST, scopes });
    expect(forMedia.status).toBe(200);
    // `aud` is the audience this verification succeeded for, not just the first claim;
    // `scopes` are the ones bound to that audience (#2674), not the token-wide list.
    expect(await forMedia.json()).toEqual({ sub: USER_DID, aud: MEDIA_HOST, scopes: ['media:read'] });
  });

  describe('per-audience scope binding (#2674)', () => {
    const EVENTS_HOST = 'events.imajin.ai';
    const tokenScopes = ['dykil:read', 'media:read', 'events:read'];
    const twoDeps = {
      ...APP_ROW,
      dependsOn: [
        { aud: MEDIA_HOST, scopes: ['media:read'] },
        { aud: EVENTS_HOST, scopes: ['events:read'] },
      ],
    };

    beforeEach(() => {
      mocks.resolveActiveAppByAudienceMock.mockImplementation(async (aud: string) => (aud === APP_HOST ? twoDeps : KERNEL_ROW));
    });

    async function mint(): Promise<string> {
      return createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST, EVENTS_HOST], scopes: tokenScopes });
    }

    it("honours dependency A's scopes at A and dependency B's at B, each only at its own audience", async () => {
      const token = await mint();

      const atMedia = await (await POST(verifyRequest({ token, aud: MEDIA_HOST }) as never)).json();
      const atEvents = await (await POST(verifyRequest({ token, aud: EVENTS_HOST }) as never)).json();

      expect(atMedia.scopes).toEqual(['media:read']);
      expect(atEvents.scopes).toEqual(['events:read']);
    });

    it("rejects with 403 a scope check for dependency A's scope at dependency B", async () => {
      const token = await mint();

      const res = await POST(verifyRequest({ token, aud: EVENTS_HOST, scope: 'media:read' }) as never);

      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/media:read/);
    });

    it('still accepts the scope at the audience it is bound to', async () => {
      const token = await mint();

      const res = await POST(verifyRequest({ token, aud: MEDIA_HOST, scope: 'media:read' }) as never);

      expect(res.status).toBe(200);
    });

    it("does not honour the app's own providesScopes at a dependency", async () => {
      const token = await mint();

      const res = await POST(verifyRequest({ token, aud: MEDIA_HOST, scope: 'dykil:read' }) as never);

      expect(res.status).toBe(403);
    });

    it('keeps every scope honoured at the primary audience', async () => {
      const token = await mint();

      const body = await (await POST(verifyRequest({ token, aud: APP_HOST }) as never)).json();

      expect(body.scopes).toEqual(tokenScopes);
    });

    it('reports the primary audience scopes when no aud is supplied', async () => {
      const token = await mint();

      const body = await (await POST(verifyRequest({ token }) as never)).json();

      expect(body).toEqual({ sub: USER_DID, aud: APP_HOST, scopes: tokenScopes });
    });

    it('honours nothing at a dependency the app no longer lists in dependsOn', async () => {
      const token = await mint();
      mocks.resolveActiveAppByAudienceMock.mockImplementation(async (aud: string) =>
        aud === APP_HOST ? { ...twoDeps, dependsOn: [{ aud: MEDIA_HOST, scopes: ['media:read'] }] } : KERNEL_ROW,
      );

      const body = await (await POST(verifyRequest({ token, aud: EVENTS_HOST }) as never)).json();

      expect(body.scopes).toEqual([]);
    });
  });

  it('still rejects an audience the token does not carry', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST], scopes });

    const res = await POST(verifyRequest({ token, aud: 'market.imajin.ai' }) as never);

    expect(res.status).toBe(401);
  });

  it('re-checks the registry for EVERY audience on the token', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST], scopes });

    await POST(verifyRequest({ token, aud: MEDIA_HOST }) as never);

    expect(mocks.resolveActiveAppByAudienceMock).toHaveBeenCalledWith(APP_HOST);
    expect(mocks.resolveActiveAppByAudienceMock).toHaveBeenCalledWith(MEDIA_HOST);
  });

  it('rejects with 403 app_not_registered when the app end is revoked, even when verifying for the dependency', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST], scopes });
    mocks.resolveActiveAppByAudienceMock.mockImplementation(async (aud: string) =>
      aud === APP_HOST ? null : { id: 'app_kernel', appDid: 'did:imajin:kernel', ownerDid: 'did:imajin:platform', tier: 'first_party', status: 'active' },
    );

    const res = await POST(verifyRequest({ token, aud: MEDIA_HOST }) as never);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('app_not_registered');
  });
});
