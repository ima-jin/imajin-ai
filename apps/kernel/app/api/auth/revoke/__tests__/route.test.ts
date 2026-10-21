/**
 * Tests for apps/kernel/app/api/auth/revoke/route.ts (#1795)
 *
 * The route itself only handles ownership/existence checks; the actual
 * revoke-exactly-once/survivor guarantee lives in revokeAppAuthorization(), which is
 * mocked here and covered by its own unit tests.
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
  const requireAuthMock = vi.fn();
  const revokeAttestationOnceMock = vi.fn();
  const revokeAppAuthorizationMock = vi.fn();
  return { whereMock, selectMock, requireAuthMock, revokeAttestationOnceMock, revokeAppAuthorizationMock };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.selectMock },
  attestations: {
    id: 'attestations.id',
    issuerDid: 'attestations.issuerDid',
    subjectDid: 'attestations.subjectDid',
    type: 'attestations.type',
    revokedAt: 'attestations.revokedAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuthMock,
}));

vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown) =>
      handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() }, correlationId: 'test-cor-id' }),
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/lib/auth/revoke-attestation', () => ({
  revokeAttestationOnce: mocks.revokeAttestationOnceMock,
}));

vi.mock('@/src/lib/auth/upsert-app-authorization', () => ({
  revokeAppAuthorization: mocks.revokeAppAuthorizationMock,
}));

import { POST } from '../route';

const USER_DID = 'did:imajin:user';
const APP_DID = 'did:imajin:agrifortress';
const ATTESTATION_ID = 'att_test123';

const ORIGINAL_ATTESTATION_ROW = {
  id: ATTESTATION_ID,
  issuerDid: USER_DID,
  subjectDid: APP_DID,
  type: 'app.authorized',
  revokedAt: null,
};

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/api/auth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_PRIVATE_KEY = 'test-private-key';
  mocks.requireAuthMock.mockResolvedValue({ identity: { id: USER_DID } });
  mocks.whereMock.mockResolvedValue([ORIGINAL_ATTESTATION_ROW]);
  mocks.revokeAttestationOnceMock.mockResolvedValue({ revoked: true, subjectDid: APP_DID });
  mocks.revokeAppAuthorizationMock.mockResolvedValue({ revoked: true, subjectDid: APP_DID });
});

describe('POST /api/auth/revoke (#1795)', () => {
  it('revokes an active authorization', async () => {
    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(200);
    expect(mocks.revokeAppAuthorizationMock).toHaveBeenCalledWith({
      attestationId: ATTESTATION_ID,
      ownerDid: USER_DID,
      appDid: APP_DID,
      privateKey: 'test-private-key',
    });
  });

  it('delegates projection decisions to the survivor-aware helper, never the raw revoke', async () => {
    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(200);
    expect(mocks.revokeAppAuthorizationMock).toHaveBeenCalledOnce();
    expect(mocks.revokeAttestationOnceMock).not.toHaveBeenCalled();
  });

  it('does not touch the channel_links grant when the revoke race is lost', async () => {
    mocks.revokeAppAuthorizationMock.mockResolvedValue({ revoked: false });

    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(409);
    expect(mocks.revokeAppAuthorizationMock).toHaveBeenCalledOnce();
  });

  it('returns 404 when the attestation does not belong to the caller or does not exist', async () => {
    mocks.whereMock.mockResolvedValue([]);

    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(404);
    expect(mocks.revokeAppAuthorizationMock).not.toHaveBeenCalled();
  });

  it('returns 409 without calling the shared helper when already marked revoked', async () => {
    mocks.whereMock.mockResolvedValue([{ ...ORIGINAL_ATTESTATION_ROW, revokedAt: new Date().toISOString() }]);

    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(409);
    expect(mocks.revokeAppAuthorizationMock).not.toHaveBeenCalled();
  });

  it('returns 409 (idempotent no-op) when a concurrent request already won the revoke race', async () => {
    mocks.revokeAppAuthorizationMock.mockResolvedValue({ revoked: false });

    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already revoked/i);
  });

  it('never invokes the shared helper more than once when later requests see a revoked row', async () => {
    // First call wins; subsequent calls see the already-revoked row and short-circuit.
    await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);
    mocks.whereMock.mockResolvedValue([{ ...ORIGINAL_ATTESTATION_ROW, revokedAt: new Date().toISOString() }]);

    for (let i = 0; i < 9; i++) {
      const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);
      expect(res.status).toBe(409);
    }

    expect(mocks.revokeAppAuthorizationMock).toHaveBeenCalledOnce();
  });

  it('rejects unauthenticated callers before reading or revoking a grant', async () => {
    mocks.requireAuthMock.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never)).status).toBe(401);
    expect(mocks.selectMock).not.toHaveBeenCalled();
    expect(mocks.revokeAppAuthorizationMock).not.toHaveBeenCalled();
  });

  it.each([{}, { attestationId: 42 }])('rejects malformed input %j before helper invocation', async (body) => {
    expect((await POST(makeRequest(body) as never)).status).toBe(400);
    expect(mocks.revokeAppAuthorizationMock).not.toHaveBeenCalled();
  });

  it('filters ownership using the session DID, even when acting for another identity', async () => {
    mocks.requireAuthMock.mockResolvedValue({ identity: { id: USER_DID, actingFor: 'business' } });
    await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);
    expect(mocks.whereMock).toHaveBeenCalledWith({
      and: [
        { eq: ['attestations.id', ATTESTATION_ID] },
        { eq: ['attestations.issuerDid', USER_DID] },
        { eq: ['attestations.type', 'app.authorized'] },
      ],
    });
    expect(mocks.revokeAppAuthorizationMock).toHaveBeenCalledWith(expect.objectContaining({ ownerDid: USER_DID }));
  });
});
