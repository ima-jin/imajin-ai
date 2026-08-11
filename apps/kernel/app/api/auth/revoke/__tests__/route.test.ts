/**
 * Tests for apps/kernel/app/api/auth/revoke/route.ts (#1795)
 *
 * The route itself only handles ownership/existence checks; the actual
 * revoke-exactly-once guarantee lives in revokeAttestationOnce(), which is
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
  return { whereMock, selectMock, requireAuthMock, revokeAttestationOnceMock };
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
});

describe('POST /api/auth/revoke (#1795)', () => {
  it('revokes an active authorization', async () => {
    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(200);
    expect(mocks.revokeAttestationOnceMock).toHaveBeenCalledWith({
      attestationId: ATTESTATION_ID,
      revokedByDid: USER_DID,
      privateKey: 'test-private-key',
    });
  });

  it('returns 404 when the attestation does not belong to the caller or does not exist', async () => {
    mocks.whereMock.mockResolvedValue([]);

    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(404);
    expect(mocks.revokeAttestationOnceMock).not.toHaveBeenCalled();
  });

  it('returns 409 without calling revokeAttestationOnce when already marked revoked', async () => {
    mocks.whereMock.mockResolvedValue([{ ...ORIGINAL_ATTESTATION_ROW, revokedAt: new Date().toISOString() }]);

    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);

    expect(res.status).toBe(409);
    expect(mocks.revokeAttestationOnceMock).not.toHaveBeenCalled();
  });

  it('returns 409 (idempotent no-op) when a concurrent request already won the revoke race', async () => {
    mocks.revokeAttestationOnceMock.mockResolvedValue({ revoked: false });

    const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already revoked/i);
  });

  it('never invokes revokeAttestationOnce more than once even if called repeatedly for the same attestation', async () => {
    // First call wins; subsequent calls see the already-revoked row and short-circuit.
    await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);
    mocks.whereMock.mockResolvedValue([{ ...ORIGINAL_ATTESTATION_ROW, revokedAt: new Date().toISOString() }]);

    for (let i = 0; i < 9; i++) {
      const res = await POST(makeRequest({ attestationId: ATTESTATION_ID }) as never);
      expect(res.status).toBe(409);
    }

    expect(mocks.revokeAttestationOnceMock).toHaveBeenCalledOnce();
  });
});
