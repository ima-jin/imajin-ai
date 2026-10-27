/**
 * Tests for apps/kernel/app/auth/api/apps/token/route.ts (#1739)
 *
 * Proof-of-possession for a developer app token mint must resolve the app's
 * public key from `registry.apps`, not `auth.identities`. A promoted actor row
 * for the same appDid can be stale/orphaned (for example, a pre-#1735
 * `agent_<appId>` sentinel), and that must never poison this endpoint.
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

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  const verifySignatureMock = vi.fn();
  const recordUse = vi.fn();
  const consume = vi.fn();
  const createAppTokenMock = vi.fn().mockResolvedValue('signed.app.jwt');
  // Minting a token must be read-only w.r.t. the consent attestation (#1795):
  // these spies let tests assert the route never reaches for a mutation path.
  const insertMock = vi.fn();
  const updateMock = vi.fn();
  const resolveActiveAppByAudienceMock = vi.fn();
  return { whereMock, selectMock, verifySignatureMock, createAppTokenMock, insertMock, updateMock, resolveActiveAppByAudienceMock, recordUse, consume };
});

describe('kernel-verified single-use code exchange', () => {
  const code = 'a'.repeat(64);
  const state = 's'.repeat(64);
  function codeBody(extra: Record<string, unknown> = {}) {
    const { attestationId: _unused, ...proof } = VALID_BODY;
    return { ...proof, timestamp: new Date().toISOString(), code, state, ...extra };
  }
  function consumed(subjectDid = ATTESTATION_ROW.issuerDid) {
    mocks.consume.mockResolvedValue({ authorization: { attestationId: ATTESTATION_ID, subjectDid } });
  }

  it('returns the kernel subject and grant after proof and atomic consumption', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([ATTESTATION_ROW]);
    consumed();
    const body = codeBody();
    const response = await POST(makeRequest(body) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      subjectDid: ATTESTATION_ROW.issuerDid, attestationId: ATTESTATION_ID,
      token: 'signed.app.jwt', scopes: ['profile:read'],
    });
    expect(mocks.verifySignatureMock).toHaveBeenCalledWith(
      `${APP_DID}:${code}:${body.nonce}:${body.timestamp}`, body.signature, REAL_PUBLIC_KEY,
    );
    expect(mocks.consume).toHaveBeenCalledWith({ appDid: APP_DID, code, state, callbackUrl: REGISTRY_APP_ROW.callbackUrl });
    expect(mocks.verifySignatureMock.mock.invocationCallOrder[0]).toBeLessThan(mocks.consume.mock.invocationCallOrder[0]);
    expect(mocks.createAppTokenMock).toHaveBeenCalledWith(expect.objectContaining({ sub: ATTESTATION_ROW.issuerDid }));
  });

  it.each(['unissued', 'expired', 'foreign-app', 'callback-changed', 'state-mismatch', 'used'])(
    'rejects %s code consumption without a token', async failure => {
      nextSelect([REGISTRY_APP_ROW]);
      const error = failure === 'used' ? 'code_used' : 'code_invalid';
      mocks.consume.mockResolvedValue({ error });
      const response = await POST(makeRequest(codeBody()) as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
      expect(mocks.createAppTokenMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { revokedAt: new Date() }, { expiresAt: new Date(0) }, { issuerDid: 'did:imajin:other' },
  ])('refuses a non-live or mismatched grant', async change => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([{ ...ATTESTATION_ROW, ...change }]);
    consumed();
    expect((await POST(makeRequest(codeBody()) as never)).status).toBeGreaterThanOrEqual(400);
    expect(mocks.createAppTokenMock).not.toHaveBeenCalled();
  });

  it('does not consume a code without valid app proof', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    mocks.verifySignatureMock.mockResolvedValue(false);
    expect((await POST(makeRequest(codeBody()) as never)).status).toBe(401);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it.each([
    { code: '' }, { code: 'invalid' }, { state: undefined }, { state: '' }, { state: 1 },
    { state: 's'.repeat(257) }, { attestationId: ATTESTATION_ID }, { principalDid: 'did:imajin:user' },
    { nonce: 'short' }, { timestamp: 'invalid' }, { timestamp: new Date(0).toISOString() },
    { appDid: 1 }, { signature: null },
  ])('refuses malformed or ambiguous code exchanges', async change => {
    expect((await POST(makeRequest(codeBody(change)) as never)).status).toBeGreaterThanOrEqual(400);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.createAppTokenMock).not.toHaveBeenCalled();
  });
});

describe('successful mint usage recording (#3009)', () => {
  it('records the resolved attestation only after minting, without awaiting telemetry', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([ATTESTATION_ROW]);
    mocks.recordUse.mockReturnValue(new Promise(() => {}));
    const response = await POST(makeRequest(VALID_BODY) as never);
    expect(response.status).toBe(200);
    expect(mocks.recordUse).toHaveBeenCalledWith(ATTESTATION_ID);
    expect(mocks.createAppTokenMock.mock.invocationCallOrder[0]).toBeLessThan(mocks.recordUse.mock.invocationCallOrder[0]);
  });

  it.each(['proof', 'missing', 'revoked', 'scope', 'private'] as const)('does not record a denied %s mint', async failure => {
    nextSelect([{ ...REGISTRY_APP_ROW, ...(failure === 'private' ? { visibility: 'private', ownerDid: 'other' } : {}) }]);
    if (failure === 'proof') mocks.verifySignatureMock.mockResolvedValue(false);
    nextSelect(failure === 'missing' ? [] : [{ ...ATTESTATION_ROW, revokedAt: failure === 'revoked' ? new Date() : null }]);
    const response = await POST(makeRequest({
      ...VALID_BODY, ...(failure === 'scope' ? { scope: 'not-granted' } : {}),
    }) as never);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.recordUse).not.toHaveBeenCalled();
  });

  it('does not record a failed token signing operation', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([ATTESTATION_ROW]);
    mocks.createAppTokenMock.mockRejectedValue(new Error('signing unavailable'));
    await expect(POST(makeRequest(VALID_BODY) as never)).rejects.toThrow('signing unavailable');
    expect(mocks.recordUse).not.toHaveBeenCalled();
  });
});

function nextSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as unknown as { limit: (n: number) => Promise<unknown[]> };
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock, insert: mocks.insertMock, update: mocks.updateMock },
  attestations: {
    id: 'attestations.id',
    subjectDid: 'attestations.subjectDid',
    type: 'attestations.type',
  },
  registryApps: {
    appDid: 'registryApps.appDid',
    publicKey: 'registryApps.publicKey',
    status: 'registryApps.status',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@/src/lib/auth/crypto', () => ({ verifySignature: mocks.verifySignatureMock }));
vi.mock('@/src/lib/auth/jwt', () => ({ createAppToken: mocks.createAppTokenMock }));
vi.mock('@/src/lib/auth/app-authorization-usage', () => ({ recordAppAuthorizationUse: mocks.recordUse }));
vi.mock('@/src/lib/auth/app-authorization-code', () => ({ consumeAppAuthorizationCode: mocks.consume }));
vi.mock('@/src/lib/kernel/app-registry', () => ({
  resolveActiveAppByAudience: mocks.resolveActiveAppByAudienceMock,
  appNotRegisteredResponse: () =>
    new Response(JSON.stringify({ error: 'app_not_registered', error_description: 'not registered' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    }),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

const APP_DID = 'did:imajin:wjLjV7nSWNZLTUqnhKRUiBrnGG8mKK7q9WXpNEnV2SM';
const REAL_PUBLIC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
const SENTINEL_PUBLIC_KEY = 'agent_app_4MbCYrndTWiJjMPe';
const ATTESTATION_ID = 'att_test123';

const REGISTRY_APP_ROW = { publicKey: REAL_PUBLIC_KEY, status: 'active', callbackUrl: 'https://app.test/callback' };
const ATTESTATION_ROW = {
  id: ATTESTATION_ID,
  issuerDid: 'did:imajin:user',
  subjectDid: APP_DID,
  type: 'app.authorized',
  revokedAt: null,
  payload: { scopes: ['profile:read'] },
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/auth/api/apps/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  appDid: APP_DID,
  attestationId: ATTESTATION_ID,
  nonce: 'n'.repeat(16),
  timestamp: new Date().toISOString(),
  signature: 'sig'.repeat(20),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whereMock.mockReset();
  mocks.verifySignatureMock.mockResolvedValue(true);
  mocks.createAppTokenMock.mockResolvedValue('signed.app.jwt');
  mocks.recordUse.mockReset().mockResolvedValue(undefined);
  mocks.consume.mockReset();
  mocks.resolveActiveAppByAudienceMock.mockReset().mockResolvedValue({
    id: 'app_first_party_coffee',
    appDid: 'did:imajin:app-coffee',
    ownerDid: 'did:imajin:platform',
    tier: 'first_party',
    status: 'active',
  });
});

describe('POST /auth/api/apps/token — registry.apps PoP lookup (#1739)', () => {
  it('verifies the PoP signature against registry.apps.publicKey', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([ATTESTATION_ROW]);

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(200);
    expect(mocks.verifySignatureMock).toHaveBeenCalledOnce();
    const [, , publicKeyArg] = mocks.verifySignatureMock.mock.calls[0];
    expect(publicKeyArg).toBe(REAL_PUBLIC_KEY);
    expect(publicKeyArg).not.toMatch(/^agent_/);
  });

  it('ignores stale/orphaned auth.identities agent_ sentinel keys for the same appDid', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([ATTESTATION_ROW]);

    const res = await POST(makeRequest(VALID_BODY) as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.token).toBe('signed.app.jwt');
    expect(mocks.verifySignatureMock).toHaveBeenCalledWith(
      expect.any(String),
      VALID_BODY.signature,
      REAL_PUBLIC_KEY,
    );
    expect(mocks.verifySignatureMock.mock.calls.some((call) => call[2] === SENTINEL_PUBLIC_KEY)).toBe(false);
  });

  it('returns 404 when the appDid has no registry.apps row', async () => {
    nextSelect([]);

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(404);
    expect(mocks.verifySignatureMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the app has been revoked in registry.apps', async () => {
    nextSelect([{ ...REGISTRY_APP_ROW, status: 'revoked' }]);

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(403);
    expect(mocks.verifySignatureMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the PoP signature does not verify against the registry key', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    mocks.verifySignatureMock.mockResolvedValue(false);

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/api/apps/token — explicit aud must be registered (#1990)', () => {
  it('mints normally when no aud is requested (unchanged default behavior)', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([ATTESTATION_ROW]);

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(200);
    expect(mocks.resolveActiveAppByAudienceMock).not.toHaveBeenCalled();
  });

  it('returns 403 app_not_registered when the requested aud has no active registry.apps row', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    mocks.resolveActiveAppByAudienceMock.mockResolvedValue(null);

    const res = await POST(makeRequest({ ...VALID_BODY, aud: 'evil.example.com' }) as never);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('app_not_registered');
    expect(mocks.createAppTokenMock).not.toHaveBeenCalled();
  });

  it('mints when the requested aud IS a registered, active app', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([ATTESTATION_ROW]);

    const res = await POST(makeRequest({ ...VALID_BODY, aud: 'coffee' }) as never);

    expect(res.status).toBe(200);
    expect(mocks.resolveActiveAppByAudienceMock).toHaveBeenCalledWith('coffee');
  });
});

describe('POST /auth/api/apps/token — mint is read-only w.r.t. the consent attestation (#1795)', () => {
  it('never calls db.insert or db.update when minting a token', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([ATTESTATION_ROW]);

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(200);
    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('repeated mint calls against the same consent attestation never create app.revoked records', async () => {
    // Simulates the #1795 retry storm: several rapid mint calls against the
    // same attestationId (e.g. two parallel reads each minting their own
    // short-lived token, possibly retried) must each succeed without ever
    // touching the attestation.
    for (let i = 0; i < 10; i++) {
      nextSelect([REGISTRY_APP_ROW]);
      nextSelect([ATTESTATION_ROW]);
      const res = await POST(makeRequest(VALID_BODY) as never);
      expect(res.status).toBe(200);
    }

    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });

  it('does not mutate the attestation even when the authorization has been revoked', async () => {
    nextSelect([REGISTRY_APP_ROW]);
    nextSelect([{ ...ATTESTATION_ROW, revokedAt: new Date().toISOString() }]);

    const res = await POST(makeRequest(VALID_BODY) as never);

    expect(res.status).toBe(403);
    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(mocks.updateMock).not.toHaveBeenCalled();
  });
});
