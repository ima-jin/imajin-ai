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
  const createAppTokenMock = vi.fn().mockResolvedValue('signed.app.jwt');
  return { whereMock, selectMock, verifySignatureMock, createAppTokenMock };
});

function nextSelect(rows: unknown[]): void {
  const p = Promise.resolve(rows) as unknown as { limit: (n: number) => Promise<unknown[]> };
  p.limit = vi.fn().mockResolvedValue(rows);
  mocks.whereMock.mockImplementationOnce(() => p);
}

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
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
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { POST } from '../route';

const APP_DID = 'did:imajin:wjLjV7nSWNZLTUqnhKRUiBrnGG8mKK7q9WXpNEnV2SM';
const REAL_PUBLIC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
const SENTINEL_PUBLIC_KEY = 'agent_app_4MbCYrndTWiJjMPe';
const ATTESTATION_ID = 'att_test123';

const REGISTRY_APP_ROW = { publicKey: REAL_PUBLIC_KEY, status: 'active' };
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
