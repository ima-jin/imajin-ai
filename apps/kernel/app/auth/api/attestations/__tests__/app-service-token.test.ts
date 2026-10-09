/**
 * #2747 acceptance (ima-jin/dykil#16, `import-legacy --commit`): the token an
 * app mints for ITSELF — `POST /auth/api/apps/token/service`, proof of
 * possession of its registered signing key, `typ: app-service+jwt` — passes
 * the media write and the attestation create + list.
 *
 * The whole token path is real: the service route verifies a real Ed25519
 * proof-of-possession and mints with the real `createAppServiceToken`; the
 * consuming routes verify it with the real verify path (`verifyAppServiceToken`
 * + the live registry check) and `@imajin/auth`'s real crypto. Only the DB
 * rows, the bus and the asset pipeline are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';

const APP_DID = 'did:imajin:dykil-app';
const SUBJECT = 'did:imajin:legacy-survey-owner';
const appKeys = authCrypto.generateKeypair();

const h = vi.hoisted(() => ({
  /** Every awaited DB read pops the next queued result; an empty queue reads as no rows. */
  queue: [] as unknown[][],
  insertValues: vi.fn(),
  returning: vi.fn(),
}));

const next = () => Promise.resolve(h.queue.shift() ?? []);

/** `where(...)` result: awaitable as-is, or continued with `.limit(...)` / `.orderBy(...).limit(...)`. */
function whereResult() {
  const awaitable = (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) => next().then(resolve, reject);
  return { limit: next, orderBy: () => ({ limit: next }), then: awaitable };
}

/** `insert(...).values(...)`: records the row, resolves `.returning()`. */
function insertValues(values: Record<string, unknown>) {
  h.insertValues(values);
  return { returning: h.returning };
}

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: whereResult }) }),
    insert: () => ({ values: insertValues }),
  },
  identities: {},
  registryApps: {},
  attestations: {},
  attestationTypeRegistry: {},
  tokens: {},
  operatorApprovals: {},
}));

vi.mock('drizzle-orm', () => {
  const fn = () => vi.fn();
  return { eq: fn(), and: fn(), isNull: fn(), gt: fn(), ne: fn(), desc: fn(), notInArray: fn(), inArray: fn(), arrayContains: fn(), sql: fn() };
});

vi.mock('@/src/lib/kernel/app-registry', () => ({ resolveActiveAppByAudience: vi.fn().mockResolvedValue(null) }));
vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant: vi.fn().mockResolvedValue({ authorized: false }) }));
vi.mock('@/src/lib/auth/attestation-type-registry', () => ({ isRegisteredAttestationType: vi.fn().mockResolvedValue(false) }));
vi.mock('@/src/lib/vault/authorization', () => ({ resolveVaultAuthorization: vi.fn() }));
vi.mock('@/src/lib/apps/approvals-execution', () => ({ APPS_SOURCE: 'apps' }));
vi.mock('@imajin/trust-graph', () => ({ trustRadius: vi.fn().mockResolvedValue(new Set()) }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}), getSessionCookieOptions: () => ({ name: 'session' }) }));
vi.mock('@imajin/cid', () => ({ computeCid: vi.fn().mockResolvedValue('bafy-test') }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));

import { POST as mintServiceToken } from '@/app/auth/api/apps/token/service/route';
import { POST as createAttestation, GET as listAttestations } from '../route';
import { resolveCallerDid } from '../caller-did';
import { requireMediaAuth } from '@/src/lib/media/require-media-auth';

/** The registry row dykil's app registration leaves behind, with `media:write` operator-approved (#2711). */
function dykilRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app_dykil',
    appDid: APP_DID,
    publicKey: appKeys.publicKey,
    status: 'active',
    requestedScopes: ['media:write'],
    approvedServiceScopes: ['media:write'],
    ...overrides,
  };
}

/** What dykil's `getAppServiceToken` does: sign `${appDid}:${nonce}:${timestamp}` and POST it. */
async function mintLikeDykil(row = dykilRow()): Promise<{ token: string; scopes: string[] }> {
  h.queue.push([row]);
  const nonce = 'n'.repeat(24);
  const timestamp = new Date().toISOString();
  const signature = authCrypto.signSync(`${APP_DID}:${nonce}:${timestamp}`, appKeys.privateKey);
  const res = await mintServiceToken({
    json: async () => ({ appDid: APP_DID, nonce, timestamp, signature }),
    headers: new Headers(),
  } as unknown as NextRequest);
  expect(res.status).toBe(200);
  return res.json();
}

function bearerRequest(token: string, init: { body?: unknown; url?: string } = {}): NextRequest {
  return {
    cookies: { get: () => undefined },
    headers: new Headers({ authorization: `Bearer ${token}` }),
    url: init.url ?? 'https://dev-jin.imajin.ai/auth/api/attestations',
    json: async () => init.body,
  } as unknown as NextRequest;
}

function signedAttestationBody() {
  const type = 'vouch.given';
  const issued_at = 1_790_000_000_000;
  const fields = { subject_did: SUBJECT, type, context_id: null, context_type: null, payload: null, issued_at };
  return {
    issuer_did: APP_DID,
    ...fields,
    signature: authCrypto.signSync(canonicalize(fields), appKeys.privateKey),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.queue.length = 0;
  h.returning.mockResolvedValue([{ id: 'att_app_issued', issuerDid: APP_DID }]);
});

describe('minting an app-service token (the dykil side)', () => {
  it('carries media:write only because the operator approved it for the app', async () => {
    expect((await mintLikeDykil()).scopes).toEqual(['media:write']);
    expect((await mintLikeDykil(dykilRow({ approvedServiceScopes: [] }))).scopes).toEqual([]);
  });
});

describe('media write with the app’s own token (#2747)', () => {
  it('authenticates as the app DID, never a user', async () => {
    const { token } = await mintLikeDykil();
    h.queue.push([{ status: 'active' }]);

    const result = await requireMediaAuth(bearerRequest(token), 'media:write');

    expect(result).toEqual({ auth: { did: APP_DID, identity: null } });
  });

  it('is a 403 when the minted token has no media:write', async () => {
    const { token } = await mintLikeDykil(dykilRow({ approvedServiceScopes: [] }));
    h.queue.push([{ status: 'active' }]);

    expect(await requireMediaAuth(bearerRequest(token), 'media:write')).toEqual({
      error: 'Missing required scope: media:write',
      status: 403,
    });
  });
});

describe('attestations with the app’s own token (#2747)', () => {
  it('resolves the caller to the app DID', async () => {
    const { token } = await mintLikeDykil();
    h.queue.push([], [{ status: 'active' }]); // legacy auth.tokens miss, then the live registry check

    expect(await resolveCallerDid(bearerRequest(token))).toBe(APP_DID);
  });

  it('does not resolve once the app is no longer active', async () => {
    const { token } = await mintLikeDykil();
    h.queue.push([], [{ status: 'revoked' }]);

    expect(await resolveCallerDid(bearerRequest(token))).toBeNull();
  });

  it('creates an attestation issued by the app (201)', async () => {
    const { token } = await mintLikeDykil();
    // legacy token miss, registry check, issuer lookup: no identity row, then the registered app's key
    h.queue.push([], [{ status: 'active' }], [], [{ id: 'app_dykil', publicKey: appKeys.publicKey, status: 'active' }]);

    const res = await createAttestation(bearerRequest(token, { body: signedAttestationBody() }));

    expect(res.status).toBe(201);
    expect(h.insertValues).toHaveBeenCalledWith(expect.objectContaining({ issuerDid: APP_DID, subjectDid: SUBJECT }));
  });

  it('is 401 without a usable credential', async () => {
    const res = await createAttestation(bearerRequest('not-a-token', { body: signedAttestationBody() }));

    expect(res.status).toBe(401);
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it('lists with the app as the viewer: a network-scoped row is visible to it, and only to a signed-in caller', async () => {
    const row = { id: 'att_1', type: 'vouch.given', issuerDid: APP_DID, subjectDid: SUBJECT, delegatorDid: null, disclosureScope: 'network', attestationStatus: null };
    const listUrl = `https://dev-jin.imajin.ai/auth/api/attestations?subject_did=${SUBJECT}`;
    const { token } = await mintLikeDykil();
    // page rows, registry-gated types, then the viewer resolution: legacy token miss + registry check
    h.queue.push([row], [{ typeName: 'vouch.given' }], [], [{ status: 'active' }]);

    const withToken = await listAttestations(bearerRequest(token, { url: listUrl }));
    expect(withToken.status).toBe(200);
    expect(await withToken.json()).toEqual([expect.objectContaining({ id: 'att_1' })]);

    h.queue.push([row], [{ typeName: 'vouch.given' }]);
    const anonymous = await listAttestations(bearerRequest('not-a-token', { url: listUrl }));
    expect(await anonymous.json()).toEqual([]);
  });
});
