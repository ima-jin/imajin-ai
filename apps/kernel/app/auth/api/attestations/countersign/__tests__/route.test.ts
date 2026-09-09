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
 *
 * #2083: `witnessJws` is now really verified (real EdDSA signature by the
 * witness's resolved DID key, over a payload binding to this exact
 * attestation's id + CID) before anything is persisted. Every test that
 * expects the countersign to succeed must therefore mint a real JWS with
 * `signWitnessJws()` — a bare string like the old `'witness-jws-token'`
 * fixture no longer clears verification.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, base64url } from 'jose';
import type { CryptoKey } from 'jose';

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
  // #2083: verifyWitnessJws resolves the witness's public key via
  // createDbResolver(db, identities) — the mock only needs to be a
  // distinct, importable value; `db.select` above is what's actually
  // exercised (shared across every select() call, attestation or identity).
  attestations: {},
  identities: {},
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
const ATTESTATION_CID = 'bafy-test';
const ISSUER_DID_V2 = 'did:imajin:agrifortress-issuer';

let witnessPrivateKey: CryptoKey;
let witnessPublicKeyHex: string;

function witnessIdentityRow(publicKey: string = witnessPublicKeyHex) {
  return [{ id: SUBJECT_DID, publicKey, type: 'actor', tier: 'soft' }];
}

async function signWitnessJws(payload: Record<string, unknown>, key: CryptoKey = witnessPrivateKey): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA' }).sign(key);
}

/** Hand-assembled JWS with `alg: none` and an empty signature segment — jose's signers refuse to produce this on purpose. */
function noneAlgJws(payload: Record<string, unknown>): string {
  const header = base64url.encode(JSON.stringify({ alg: 'none' }));
  const body = base64url.encode(JSON.stringify(payload));
  return `${header}.${body}.`;
}

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
    cid: ATTESTATION_CID,
    ...overrides,
  };
}

/** Queue the attestation row, then the witness identity row `verifyWitnessJws` resolves next. */
function queueValidCountersignReads(attestationOverrides: Record<string, unknown> = {}) {
  h.mockSelectLimit.mockResolvedValueOnce([pendingAttestation(attestationOverrides)]);
  h.mockSelectLimit.mockResolvedValueOnce(witnessIdentityRow());
}

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  witnessPrivateKey = privateKey;
  const jwk = await exportJWK(publicKey);
  witnessPublicKeyHex = Buffer.from(jwk.x as string, 'base64url').toString('hex');
});

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
    queueValidCountersignReads();
    const token = await mintAppToken('attestations:write');
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await POST(
      countersignRequest({ authorization: `Bearer ${token}` }, { attestationId: ATTESTATION_ID, witnessJws }) as never,
    );

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody).toMatchObject({ id: ATTESTATION_ID, cid: ATTESTATION_CID, status: 'bilateral' });
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

describe('POST /auth/api/attestations/countersign — witnessJws verification (#2083)', () => {
  async function countersignWithJws(witnessJws: string): Promise<Response> {
    const token = await mintAppToken('attestations:write');
    return POST(
      countersignRequest({ authorization: `Bearer ${token}` }, { attestationId: ATTESTATION_ID, witnessJws }) as never,
    );
  }

  it("accepts a validly signed witnessJws bound to this attestation's id + cid", async () => {
    queueValidCountersignReads();
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignWithJws(witnessJws);

    expect(res.status).toBe(200);
    expect(h.mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it("rejects a bad signature (signed by a key other than the witness's resolved key) with 422, nothing stored", async () => {
    queueValidCountersignReads();
    const { privateKey: attackerKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID }, attackerKey);

    const res = await countersignWithJws(witnessJws);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid witnessJws signature/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects a witnessJws whose payload names the wrong CID with 422, nothing stored', async () => {
    queueValidCountersignReads();
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: 'bafy-wrong-cid' });

    const res = await countersignWithJws(witnessJws);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/does not bind to this attestation/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects a witnessJws whose payload names the wrong attestationId with 422, nothing stored', async () => {
    queueValidCountersignReads();
    const witnessJws = await signWitnessJws({ attestationId: 'att_some_other_one', cid: ATTESTATION_CID });

    const res = await countersignWithJws(witnessJws);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/does not bind to this attestation/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects alg=none with 422 before ever resolving the witness key, nothing stored', async () => {
    // Only the attestation read is queued — an unsupported `alg` is
    // rejected from the decoded header alone, before the witness DID's
    // public key is ever resolved.
    h.mockSelectLimit.mockResolvedValueOnce([pendingAttestation()]);
    const witnessJws = noneAlgJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignWithJws(witnessJws);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/alg "none" is not allowed/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects an unresolvable witness DID with 422, nothing stored', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAttestation()]);
    h.mockSelectLimit.mockResolvedValueOnce([]); // identities lookup finds no row
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignWithJws(witnessJws);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Could not resolve witness DID/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-JWS) witnessJws with 422, nothing stored', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAttestation()]);

    const res = await countersignWithJws('not-a-jws-at-all');

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/not a well-formed JWS/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });

  it('rejects countersigning an attestation with no CID (nothing to bind witnessJws to) with 422', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAttestation({ cid: null })]);
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignWithJws(witnessJws);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/no CID/);
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
  });
});

describe('POST /auth/api/attestations/countersign — amendment-by-supersession (#1790)', () => {
  const V1_ID = 'att_v1_bilateral';

  function pendingAmendment(overrides: Record<string, unknown> = {}) {
    return pendingAttestation({ supersedes: V1_ID, ...overrides });
  }

  async function countersignAsIssuer(witnessJws: string): Promise<Response> {
    const token = await mintAppToken('attestations:write');
    return POST(
      countersignRequest({ authorization: `Bearer ${token}` }, { attestationId: ATTESTATION_ID, witnessJws }) as never,
    );
  }

  it('atomically flips v1 -> superseded and v2 -> bilateral inside one transaction', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.mockSelectLimit.mockResolvedValueOnce(witnessIdentityRow());
    h.mockTxSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: ISSUER_DID_V2, subjectDid: 'did:imajin:someone-else', attestationStatus: 'bilateral' },
    ]);
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignAsIssuer(witnessJws);

    expect(res.status).toBe(200);
    // The non-transactional single-update path must be skipped entirely.
    expect(h.mockUpdateWhere).not.toHaveBeenCalled();
    expect(h.mockTxUpdateSet).toHaveBeenCalledTimes(2);
    expect(h.mockTxUpdateSet.mock.calls[0][0]).toEqual({ attestationStatus: 'superseded' });
    expect(h.mockTxUpdateSet.mock.calls[1][0]).toMatchObject({
      attestationStatus: 'bilateral',
      witnessJws,
    });
    expect(h.mockTxUpdateWhere).toHaveBeenCalledTimes(2);
  });

  it('rolls back and returns 404 when the supersedes target does not exist', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.mockSelectLimit.mockResolvedValueOnce(witnessIdentityRow());
    h.mockTxSelectLimit.mockResolvedValueOnce([]);
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignAsIssuer(witnessJws);

    expect(res.status).toBe(404);
    expect(h.mockTxUpdateSet).not.toHaveBeenCalled();
  });

  it('rolls back and returns 409 when v1 is no longer bilateral by countersign time (TOCTOU re-check)', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.mockSelectLimit.mockResolvedValueOnce(witnessIdentityRow());
    h.mockTxSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: ISSUER_DID_V2, subjectDid: 'did:imajin:someone-else', attestationStatus: 'superseded' },
    ]);
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignAsIssuer(witnessJws);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/bilateral/);
    expect(h.mockTxUpdateSet).not.toHaveBeenCalled();
  });

  it('rolls back and returns 409 when the proposer is not a party to v1', async () => {
    h.mockSelectLimit.mockResolvedValueOnce([pendingAmendment()]);
    h.mockSelectLimit.mockResolvedValueOnce(witnessIdentityRow());
    h.mockTxSelectLimit.mockResolvedValueOnce([
      { id: V1_ID, issuerDid: 'did:imajin:unrelated', subjectDid: 'did:imajin:also-unrelated', attestationStatus: 'bilateral' },
    ]);
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignAsIssuer(witnessJws);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/party to/);
    expect(h.mockTxUpdateSet).not.toHaveBeenCalled();
  });

  it('does not open a transaction for a plain countersign with no supersedes', async () => {
    queueValidCountersignReads();
    const witnessJws = await signWitnessJws({ attestationId: ATTESTATION_ID, cid: ATTESTATION_CID });

    const res = await countersignAsIssuer(witnessJws);

    expect(res.status).toBe(200);
    expect(h.mockTxUpdateSet).not.toHaveBeenCalled();
    expect(h.mockUpdateWhere).toHaveBeenCalledTimes(1);
  });
});
