/**
 * Regression tests for #1824: `POST /auth/api/attestations/countersign` used
 * to gate on the kernel-local, cookie-only `requireAuth`
 * (`@/src/lib/auth/middleware`), which never even inspected an
 * `Authorization: Bearer` header. Every app-delegated call — e.g. AgriFortress
 * countersigning an attestation on behalf of its delegating user — 401'd
 * before the route body ran, regardless of scope.
 *
 * The route now uses `resolveEffectiveDid` (the same dual-guard shape
 * `connections:read` / `connections:write` already use, #1812/#1814). These
 * tests wire the *real* `resolveEffectiveDid` -> `requireAppAuth` ->
 * app-token-verify chain together (only `fetch` is stubbed, to route the
 * bearer-verification round trip to the in-process verify handler instead of
 * the network) through the *real* route handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextRequest: Request,
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      }),
  },
}));

const h = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockTxSelectLimit: vi.fn(),
  mockTxUpdateSet: vi.fn(),
  mockTxUpdateWhere: vi.fn(),
}));

// Amendment-by-supersession (#1790): the countersign route wraps its v1<->v2
// flip in db.transaction() when `supersedes` is set. `tx` mirrors `db`'s
// select/update chain shape against separate mock hooks so tests can assert
// on the two updates issued inside the transaction. Named helpers (rather
// than inline nested arrows) keep the mock chain under sonarjs's
// nested-function-depth budget.
function txSelectWhere() {
  return { limit: h.mockTxSelectLimit };
}
function txSelectFrom() {
  return { where: txSelectWhere };
}
function txSelect() {
  return { from: txSelectFrom };
}
function txUpdateSet(setArg: unknown) {
  h.mockTxUpdateSet(setArg);
  return { where: h.mockTxUpdateWhere };
}
function txUpdate() {
  return { set: txUpdateSet };
}

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: h.mockSelectLimit }) }) }),
    update: () => ({ set: () => ({ where: h.mockUpdateWhere }) }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ select: txSelect, update: txUpdate }),
  },
  attestations: {},
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => args }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

import { createAppToken } from '@/src/lib/auth/jwt';
import { POST as verifyAppTokenRoute } from '@/app/auth/api/apps/token/verify/route';
import { POST } from '../route';

const AUTH_SERVICE_URL = 'https://auth.kernel.test/auth';
const APP_DID = 'did:imajin:agrifortress-webhook';
const SUBJECT_DID = 'did:imajin:agrifortress-recipient';
const ATTESTATION_ID = 'att_pending_123';
const ISSUER_DID_V2 = 'did:imajin:agrifortress-issuer';

function countersignRequest(headers: Record<string, string>, body: Record<string, unknown>): Request {
  return new Request('https://kernel.test/auth/api/attestations/countersign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function mintAppToken(scope: string, sub = SUBJECT_DID): Promise<string> {
  return createAppToken({ sub, azp: APP_DID, scope, attestationId: 'att_consent' });
}

function pendingAttestation(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTESTATION_ID,
    subjectDid: SUBJECT_DID,
    issuerDid: ISSUER_DID_V2,
    attestationStatus: 'pending',
    cid: 'bafy-test',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mockSelectLimit.mockReset();
  h.mockUpdateWhere.mockReset();
  h.mockTxSelectLimit.mockReset();
  h.mockTxUpdateSet.mockReset();
  h.mockTxUpdateWhere.mockReset();
  process.env.AUTH_SERVICE_URL = AUTH_SERVICE_URL;
  h.mockUpdateWhere.mockResolvedValue(undefined);
  h.mockTxUpdateWhere.mockResolvedValue(undefined);

  // The bearer path round-trips through HTTP in production (#1069); here we
  // stub `fetch` to hand the request straight to the real verify handler
  // in-process, so the resolveEffectiveDid -> requireAppAuth -> verify chain
  // runs on real code end to end.
  global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) === `${AUTH_SERVICE_URL}/api/apps/token/verify`) {
      const req = new Request(String(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: init?.body,
      });
      return verifyAppTokenRoute(req as never);
    }
    throw new Error(`Unexpected fetch to ${String(url)}`);
  }) as unknown as typeof fetch;
});

describe('POST /auth/api/attestations/countersign — app-delegated token (#1824)', () => {
  it('countersigns a pending attestation for a bearer app token with attestations:write, no x-app-did', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAttestation()]);
    const token = await mintAppToken('attestations:write');

    const res = await POST(
      countersignRequest(
        { authorization: `Bearer ${token}` },
        { attestationId: ATTESTATION_ID, witnessJws: 'witness-jws-token' },
      ) as never,
    );

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody).toMatchObject({ id: ATTESTATION_ID, cid: 'bafy-test', status: 'bilateral' });
    expect(h.mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('rejects a bearer app token missing the attestations:write scope with 403, not a generic 401', async () => {
    // Auth fails before the route ever reads the attestation, so no db mock
    // value is queued here — queuing one would leak into the next test's
    // `.limit()` call (never consumed by this one, since resolveEffectiveDid
    // short-circuits first).
    const token = await mintAppToken('connections:write');

    const res = await POST(
      countersignRequest(
        { authorization: `Bearer ${token}` },
        { attestationId: ATTESTATION_ID, witnessJws: 'witness-jws-token' },
      ) as never,
    );

    expect(res.status).toBe(403);
    const responseBody = await res.json();
    expect(responseBody.error).toMatch(/attestations:write/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects an app-delegated caller who is not the attestation subject', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAttestation({ subjectDid: 'did:imajin:someone-else' })]);
    const token = await mintAppToken('attestations:write');

    const res = await POST(
      countersignRequest(
        { authorization: `Bearer ${token}` },
        { attestationId: ATTESTATION_ID, witnessJws: 'witness-jws-token' },
      ) as never,
    );

    expect(res.status).toBe(403);
    const responseBody = await res.json();
    expect(responseBody.error).toMatch(/Only the attestation subject can countersign/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request (no cookie, no bearer) with 401', async () => {
    const res = await POST(
      countersignRequest({}, { attestationId: ATTESTATION_ID, witnessJws: 'witness-jws-token' }) as never,
    );

    expect(res.status).toBe(401);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/attestations/countersign — amendment-by-supersession (#1790)', () => {
  const V1_ID = 'att_v1_bilateral';

  function pendingAmendment(overrides: Record<string, unknown> = {}) {
    return pendingAttestation({ supersedes: V1_ID, ...overrides });
  }

  async function countersignAsIssuer(): Promise<Response> {
    const token = await mintAppToken('attestations:write');
    return POST(
      countersignRequest(
        { authorization: `Bearer ${token}` },
        { attestationId: ATTESTATION_ID, witnessJws: 'witness-jws-token' },
      ) as never,
    );
  }

  it('atomically flips v1 -> superseded and v2 -> bilateral inside one transaction', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.mockTxSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: ISSUER_DID_V2, subjectDid: 'did:imajin:someone-else', attestationStatus: 'bilateral' },
    ]);

    const res = await countersignAsIssuer();

    expect(res.status).toBe(200);
    // The non-transactional single-update path must be skipped entirely.
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
    expect(h.mockTxUpdateSet).toHaveBeenCalledTimes(2);
    expect(h.mockTxUpdateSet.mock.calls[0][0]).toEqual({ attestationStatus: 'superseded' });
    expect(h.mockTxUpdateSet.mock.calls[1][0]).toMatchObject({
      attestationStatus: 'bilateral',
      witnessJws: 'witness-jws-token',
    });
    expect(h.mockTxUpdateWhere).toHaveBeenCalledTimes(2);
  });

  it('rolls back and returns 404 when the supersedes target does not exist', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.mockTxSelectLimit.mockResolvedValueOnce([]);

    const res = await countersignAsIssuer();

    expect(res.status).toBe(404);
    expect(h.mockTxUpdateSet).not.toHaveBeenCalled();
  });

  it('rolls back and returns 409 when v1 is no longer bilateral by countersign time (TOCTOU re-check)', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.mockTxSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: ISSUER_DID_V2, subjectDid: 'did:imajin:someone-else', attestationStatus: 'superseded' },
    ]);

    const res = await countersignAsIssuer();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/bilateral/);
    expect(h.mockTxUpdateSet).not.toHaveBeenCalled();
  });

  it('rolls back and returns 409 when the proposer is not a party to v1', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.mockTxSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: 'did:imajin:unrelated', subjectDid: 'did:imajin:also-unrelated', attestationStatus: 'bilateral' },
    ]);

    const res = await countersignAsIssuer();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/party to/);
    expect(h.mockTxUpdateSet).not.toHaveBeenCalled();
  });

  it('does not open a transaction for a plain countersign with no supersedes', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAttestation()]);

    const res = await countersignAsIssuer();

    expect(res.status).toBe(200);
    expect(h.mockTxUpdateSet).not.toHaveBeenCalled();
    expect(h.mockUpdateWhere).toHaveBeenCalledTimes(1);
  });
});
