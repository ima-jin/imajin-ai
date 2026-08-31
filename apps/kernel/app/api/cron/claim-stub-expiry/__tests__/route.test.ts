/**
 * Unit tests for GET /api/cron/claim-stub-expiry (#1841).
 *
 * Acceptance criteria verified (per the ratified proposal on #1841):
 *   - Only stubs with stub_status='active' and an elapsed stub_expires_at
 *     are candidates.
 *   - A candidate with a still-pending connections.invites row is skipped
 *     (design consideration 1 — never expire while reminders may be in
 *     flight).
 *   - A candidate whose identity tier is no longer 'soft' (already claimed)
 *     is skipped.
 *   - A swept stub: stub_status flips to 'expired', expired_at is stamped,
 *     pending/collecting attestations targeting the DID cascade to
 *     'lapsed' (lapsed_at stamped), pending invites targeting the DID
 *     cascade to 'lapsed' (lapsed_at stamped), and identity.stub.lapsed is
 *     published once per swept DID.
 *   - A lost CAS race (already expired by a concurrent sweep/claim) is a
 *     no-op for that DID.
 *   - Sweep is a no-op when there are no candidates.
 *   - CRON_SECRET auth works identically to other cron routes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock: @/src/db — drizzle select/update/transaction chains ──────────────

const {
  mockOuterSelect,
  mockTxSelect,
  mockTxUpdate,
  mockTransaction,
  queueOuterSelect,
  queueTxSelect,
  queueTxUpdate,
} = vi.hoisted(() => {
  function selectChain(result: unknown) {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => result);
    chain.then = (resolve: (v: unknown) => void) => resolve(result);
    return chain;
  }

  function updateChain(result: unknown[]) {
    const chain: Record<string, unknown> = {};
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(async () => result);
    return chain;
  }

  const mockOuterSelect = vi.fn();
  const mockTxSelect = vi.fn();
  const mockTxUpdate = vi.fn();

  function queueOuterSelect(result: unknown) {
    mockOuterSelect.mockImplementationOnce(() => selectChain(result));
  }
  function queueTxSelect(result: unknown) {
    mockTxSelect.mockImplementationOnce(() => selectChain(result));
  }
  function queueTxUpdate(result: unknown[]) {
    mockTxUpdate.mockImplementationOnce(() => updateChain(result));
  }

  const mockTransaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = { select: mockTxSelect, update: mockTxUpdate };
    return fn(tx);
  });

  return { mockOuterSelect, mockTxSelect, mockTxUpdate, mockTransaction, queueOuterSelect, queueTxSelect, queueTxUpdate };
});

vi.mock('@/src/db', () => ({
  db: { select: mockOuterSelect, transaction: mockTransaction },
  claimStubIndex: {
    did: 'claim_stub_index.did',
    id: 'claim_stub_index.id',
    stubStatus: 'claim_stub_index.stub_status',
    stubExpiresAt: 'claim_stub_index.stub_expires_at',
  },
  identities: { id: 'identities.id', tier: 'identities.tier' },
  attestations: { id: 'attestations.id', subjectDid: 'attestations.subject_did', attestationStatus: 'attestations.attestation_status' },
  invites: { id: 'invites.id', toDid: 'invites.to_did', status: 'invites.status' },
}));

// ── Mock: node identity ──────────────────────────────────────────────────────

vi.mock('@/src/lib/kernel/node-identity', () => ({
  getNodeDid: vi.fn(async () => 'did:imajin:testnode'),
}));

// ── Mock: bus publish ─────────────────────────────────────────────────────────

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn(() => Promise.resolve()) }));
vi.mock('@imajin/bus', () => ({ publish: mockPublish }));

// ── Mock: logger ──────────────────────────────────────────────────────────────

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { GET } from '../route.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/claim-stub-expiry', { headers });
}

/** Queue a full successful sweep for one candidate DID: no pending invite, soft tier, CAS wins. */
function queueSuccessfulSweep(opts: { lapsedAttestationIds?: string[]; lapsedInviteIds?: string[] } = {}) {
  queueTxSelect([]); // no pending invite
  queueTxSelect([{ tier: 'soft' }]); // still soft
  queueTxUpdate([{ id: 'cstub_swept' }]); // CAS wins
  queueTxUpdate((opts.lapsedAttestationIds ?? []).map((id) => ({ id }))); // attestations cascade
  queueTxUpdate((opts.lapsedInviteIds ?? []).map((id) => ({ id }))); // invites cascade
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/cron/claim-stub-expiry', () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` empties call history but does NOT drain any queued
    // `mockImplementationOnce` results — without an explicit `mockReset`,
    // leftover queued results from one test leak into the next test's calls.
    mockOuterSelect.mockReset();
    mockTxSelect.mockReset();
    mockTxUpdate.mockReset();
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = { select: mockTxSelect, update: mockTxUpdate };
      return fn(tx);
    });
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it('returns 401 when CRON_SECRET is set and Authorization header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';
    queueOuterSelect([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is set and Authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';
    queueOuterSelect([]);

    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }) as never);
    expect(response.status).toBe(401);
  });

  it('passes auth when CRON_SECRET matches Bearer token', async () => {
    process.env.CRON_SECRET = 'test-secret';
    queueOuterSelect([]);

    const response = await GET(makeRequest({ authorization: 'Bearer test-secret' }) as never);
    expect(response.status).toBe(200);
  });

  it('passes auth (dev mode) when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    queueOuterSelect([]);

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(200);
  });

  // ── No-op ─────────────────────────────────────────────────────────────────

  it('no-op: returns swept=0 and does not open a transaction when there are no candidates', async () => {
    delete process.env.CRON_SECRET;
    queueOuterSelect([]);

    const response = await GET(makeRequest() as never);
    const body = (await response.json()) as { ok: boolean; swept: number; dids: string[] };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.swept).toBe(0);
    expect(body.dids).toEqual([]);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // ── Sweep logic ─────────────────────────────────────────────────────────────

  it('sweeps a candidate stub: flips to expired, cascades attestations/invites to lapsed, publishes identity.stub.lapsed', async () => {
    delete process.env.CRON_SECRET;
    const did = 'did:imajin:stub-under-sweep';
    queueOuterSelect([{ did }]);
    queueSuccessfulSweep({ lapsedAttestationIds: ['att_1', 'att_2'], lapsedInviteIds: ['inv_1'] });

    const response = await GET(makeRequest() as never);
    const body = (await response.json()) as { ok: boolean; swept: number; dids: string[] };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.swept).toBe(1);
    expect(body.dids).toEqual([did]);

    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(mockPublish).toHaveBeenCalledOnce();
    expect(mockPublish).toHaveBeenCalledWith(
      'identity.stub.lapsed',
      expect.objectContaining({
        issuer: 'did:imajin:testnode',
        subject: did,
        scope: 'auth',
        payload: expect.objectContaining({
          did,
          lapsedAttestationIds: ['att_1', 'att_2'],
          lapsedInviteIds: ['inv_1'],
          context_id: did,
          context_type: 'identity.stub',
        }),
      }),
    );
  });

  it('skips a candidate with a still-pending invite (reminder-ladder guard, design consideration 1)', async () => {
    delete process.env.CRON_SECRET;
    const did = 'did:imajin:has-pending-invite';
    queueOuterSelect([{ did }]);
    queueTxSelect([{ id: 'inv_pending' }]); // pending invite exists — guard trips

    const response = await GET(makeRequest() as never);
    const body = (await response.json()) as { swept: number; dids: string[] };

    expect(body.swept).toBe(0);
    expect(body.dids).toEqual([]);
    expect(mockTxUpdate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('skips a candidate whose identity tier is no longer soft (already claimed)', async () => {
    delete process.env.CRON_SECRET;
    const did = 'did:imajin:already-claimed';
    queueOuterSelect([{ did }]);
    queueTxSelect([]); // no pending invite
    queueTxSelect([{ tier: 'preliminary' }]); // already claimed

    const response = await GET(makeRequest() as never);
    const body = (await response.json()) as { swept: number };

    expect(body.swept).toBe(0);
    expect(mockTxUpdate).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('is a no-op when the CAS update loses the race (already expired concurrently)', async () => {
    delete process.env.CRON_SECRET;
    const did = 'did:imajin:concurrently-expired';
    queueOuterSelect([{ did }]);
    queueTxSelect([]); // no pending invite
    queueTxSelect([{ tier: 'soft' }]); // still soft
    queueTxUpdate([]); // CAS: no row matched (lost the race)

    const response = await GET(makeRequest() as never);
    const body = (await response.json()) as { swept: number };

    expect(body.swept).toBe(0);
    // Only the CAS update ran — no cascade updates for a lost race.
    expect(mockTxUpdate).toHaveBeenCalledTimes(1);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('sweeps multiple candidates independently: guarded ones are skipped, eligible ones are swept', async () => {
    delete process.env.CRON_SECRET;
    const skippedDid = 'did:imajin:skip-me';
    const sweptDid = 'did:imajin:sweep-me';
    queueOuterSelect([{ did: skippedDid }, { did: sweptDid }]);

    queueTxSelect([{ id: 'inv_pending' }]); // skippedDid: pending invite guard trips
    queueSuccessfulSweep(); // sweptDid: clean sweep

    const response = await GET(makeRequest() as never);
    const body = (await response.json()) as { swept: number; dids: string[] };

    expect(body.swept).toBe(1);
    expect(body.dids).toEqual([sweptDid]);
    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(mockPublish).toHaveBeenCalledOnce();
  });

  it('defensively cascades a pending invite even when the reminder-ladder guard already should have excluded it', async () => {
    delete process.env.CRON_SECRET;
    const did = 'did:imajin:race-window';
    queueOuterSelect([{ did }]);
    queueSuccessfulSweep({ lapsedInviteIds: ['inv_race'] });

    const response = await GET(makeRequest() as never);
    const body = (await response.json()) as { swept: number };

    expect(body.swept).toBe(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'identity.stub.lapsed',
      expect.objectContaining({ payload: expect.objectContaining({ lapsedInviteIds: ['inv_race'] }) }),
    );
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('returns 500 when the initial candidate scan throws', async () => {
    delete process.env.CRON_SECRET;
    mockOuterSelect.mockImplementationOnce(() => {
      throw new Error('DB connection lost');
    });

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });

  it('returns 500 when a per-DID transaction throws', async () => {
    delete process.env.CRON_SECRET;
    queueOuterSelect([{ did: 'did:imajin:boom' }]);
    mockTransaction.mockImplementationOnce(async () => {
      throw new Error('transaction failed');
    });

    const response = await GET(makeRequest() as never);
    expect(response.status).toBe(500);
  });
});
