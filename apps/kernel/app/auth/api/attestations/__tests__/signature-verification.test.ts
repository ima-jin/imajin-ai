/**
 * Core invariant tests for attestation signature verification (#325).
 *
 * `route.test.ts` stubs `@imajin/auth`'s `crypto.verifySync` to always return
 * true so it can focus on envelope/delegation behaviour. That leaves the one
 * property the whole attestation ledger rests on untested: POST
 * /auth/api/attestations only accepts a record whose Ed25519 signature really
 * was made by the issuer's registered key over the canonical payload.
 *
 * Here `@imajin/auth` is NOT mocked — real keys, real signatures, real
 * canonicalization. Only the database, session and bus edges are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';

const ISSUER = 'did:imajin:alice';
const SUBJECT = 'did:imajin:bob';
const TYPE = 'vouch.given';
const ISSUED_AT = 1_790_000_000_000;

const h = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockReturning: vi.fn(),
  mockInsertValues: vi.fn(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  verifySessionToken: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: h.mockSelectLimit }) }) }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        h.mockInsertValues(values);
        return { returning: h.mockReturning };
      },
    }),
  },
  identities: {},
  registryApps: {},
  attestations: {},
  tokens: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: h.verifySessionToken,
  verifySessionAppTokenLocal: vi.fn().mockResolvedValue(null),
  getSessionCookieOptions: () => ({ name: 'session' }),
}));

vi.mock('@/src/lib/kernel/app-registry', () => ({ resolveActiveAppByAudience: vi.fn().mockResolvedValue(null) }));
vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant: vi.fn().mockResolvedValue({ authorized: false }) }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@imajin/cid', () => ({ computeCid: vi.fn().mockResolvedValue('bafy-test') }));
vi.mock('@imajin/bus', () => ({ publish: h.mockPublish }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  withLogger: (_service: string, handler: (req: unknown, ctx: unknown) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));
vi.mock('@/src/lib/auth/attestation-type-registry', () => ({
  isRegisteredAttestationType: vi.fn().mockResolvedValue(false),
}));

import { POST } from '../route';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const issuerKeys = authCrypto.generateKeypair();

interface SignedFields {
  subject_did: string;
  type: string;
  context_id: string | null;
  context_type: string | null;
  payload: Record<string, unknown> | null;
  issued_at: number;
}

function canonicalFor(fields: SignedFields): string {
  return canonicalize(fields);
}

function baseFields(overrides: Partial<SignedFields> = {}): SignedFields {
  return {
    subject_did: SUBJECT,
    type: TYPE,
    context_id: null,
    context_type: null,
    payload: null,
    issued_at: ISSUED_AT,
    ...overrides,
  };
}

/** Build a POST body whose signature is made by `signerPrivateKey` over `signedFields`. */
function bodyFor(options: {
  signedFields?: SignedFields;
  submitted?: Partial<SignedFields>;
  signerPrivateKey?: string;
  signature?: string;
}) {
  const signedFields = options.signedFields ?? baseFields();
  const signature =
    options.signature ?? authCrypto.signSync(canonicalFor(signedFields), options.signerPrivateKey ?? issuerKeys.privateKey);
  return { issuer_did: ISSUER, ...signedFields, ...options.submitted, signature };
}

function makeReq(body: unknown): NextRequest {
  return {
    cookies: { get: () => ({ value: 'session-token' }) },
    headers: new Headers(),
    json: async () => body,
  } as unknown as NextRequest;
}

/** Flip the low bit of the first byte of a hex signature — a one-byte corruption. */
function flipFirstByte(hexSignature: string): string {
  const flipped = (Number.parseInt(hexSignature.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, '0');
  return flipped + hexSignature.slice(2);
}

function expectNothingPersisted() {
  expect(h.mockInsertValues).not.toHaveBeenCalled();
  expect(h.mockPublish).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifySessionToken.mockResolvedValue({ sub: ISSUER });
  h.mockSelectLimit.mockResolvedValue([{ publicKey: issuerKeys.publicKey }]);
  h.mockReturning.mockResolvedValue([{ id: 'att_real_sig' }]);
  h.mockPublish.mockResolvedValue(undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('POST /auth/api/attestations — real Ed25519 verification (#325)', () => {
  it('accepts a valid signature made by the issuer key (201) and persists it verbatim', async () => {
    const body = bodyFor({});

    const res = await POST(makeReq(body));

    expect(res.status).toBe(201);
    expect(h.mockInsertValues).toHaveBeenCalledTimes(1);
    expect(h.mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ issuerDid: ISSUER, subjectDid: SUBJECT, type: TYPE, signature: body.signature }),
    );
  });

  it('accepts a valid signature over a payload and context', async () => {
    const signedFields = baseFields({
      context_id: 'ctx_1',
      context_type: 'event',
      payload: { note: 'great host', nested: { b: 2, a: 1 } },
    });

    const res = await POST(makeReq(bodyFor({ signedFields })));

    expect(res.status).toBe(201);
  });

  it('accepts a signature regardless of payload key order (canonicalization is order-independent)', async () => {
    const signed = baseFields({ payload: { a: 1, b: 2 } });

    const res = await POST(makeReq(bodyFor({ signedFields: signed, submitted: { payload: { b: 2, a: 1 } } })));

    expect(res.status).toBe(201);
  });

  it('rejects a signature with one flipped byte (400 Invalid signature) and persists nothing', async () => {
    const good = bodyFor({});

    const res = await POST(makeReq({ ...good, signature: flipFirstByte(good.signature) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expectNothingPersisted();
  });

  it.each([
    ['not hex at all', 'not-a-hex-signature'],
    ['an all-zero 64-byte signature', '0'.repeat(128)],
    ['a truncated signature', 'ab'.repeat(32)],
    ['odd-length hex', 'a'.repeat(127)],
  ])('rejects a malformed signature: %s (400)', async (_label, signature) => {
    const res = await POST(makeReq(bodyFor({ signature })));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expectNothingPersisted();
  });

  it('rejects a signature made by the wrong key — the issuer’s registered key is a different one (400)', async () => {
    const attacker = authCrypto.generateKeypair();

    const res = await POST(makeReq(bodyFor({ signerPrivateKey: attacker.privateKey })));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expectNothingPersisted();
  });

  it('rejects when the registry resolves the issuer to a different public key than the signer used (wrong issuer key)', async () => {
    const otherIdentity = authCrypto.generateKeypair();
    h.mockSelectLimit.mockResolvedValue([{ publicKey: otherIdentity.publicKey }]);

    const res = await POST(makeReq(bodyFor({})));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expectNothingPersisted();
  });

  it.each([
    ['subject_did', { subject_did: 'did:imajin:mallory' }],
    ['type', { type: 'vouch.received' }],
    ['context_id', { context_id: 'ctx_other' }],
    ['context_type', { context_type: 'swap' }],
    ['payload', { payload: { note: 'edited after signing' } }],
    ['issued_at', { issued_at: ISSUED_AT + 1 }],
  ] as const)('rejects when %s is altered after signing (400)', async (_field, submitted) => {
    const res = await POST(makeReq(bodyFor({ submitted })));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid signature' });
    expectNothingPersisted();
  });

  it('rejects an unknown issuer DID before any signature check (400 Issuer DID not found)', async () => {
    h.mockSelectLimit.mockResolvedValue([]);

    const res = await POST(makeReq(bodyFor({})));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Issuer DID not found' });
    expectNothingPersisted();
  });

  it('rejects a request with no signature at all (400 signature required)', async () => {
    const unsigned: Record<string, unknown> = { ...bodyFor({}) };
    delete unsigned.signature;

    const res = await POST(makeReq(unsigned));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'signature required' });
    expectNothingPersisted();
  });

  it('judges the signature, not the caller: a different authenticated session cannot launder a forged signature', async () => {
    h.verifySessionToken.mockResolvedValue({ sub: 'did:imajin:some-other-caller' });
    const attacker = authCrypto.generateKeypair();

    const res = await POST(makeReq(bodyFor({ signerPrivateKey: attacker.privateKey })));

    expect(res.status).toBe(400);
    expectNothingPersisted();
  });
});
