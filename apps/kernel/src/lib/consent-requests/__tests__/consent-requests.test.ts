/**
 * Tests for the generic consent-request primitive (#1817).
 *
 * Covers: raising a request (+ card payload + bus publish), approve/reject
 * attestation minting (+ bus publish), expiry resolution (never silent), and
 * ownership/status fail-closed checks. `@/src/db` is doubled with a small
 * in-memory store so the drizzle query shapes exercised by
 * consent-requests.ts are covered without a real database, mirroring the
 * pattern in vault/__tests__/static-secret-grant.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

type Cond =
  | { type: 'eq'; col: string; val: unknown }
  | { type: 'and'; conds: Cond[] }
  | { type: 'inArray'; col: string; vals: unknown[] }
  | undefined;

function matches(row: Row, cond: Cond): boolean {
  if (!cond) return true;
  if (cond.type === 'eq') return row[cond.col] === cond.val;
  if (cond.type === 'and') return cond.conds.every((c) => matches(row, c));
  if (cond.type === 'inArray') return cond.vals.includes(row[cond.col]);
  return true;
}

function sortByCreatedAtDesc(rows: readonly Row[]): Row[] {
  return [...rows].sort(compareCreatedAtDesc);
}

function compareCreatedAtDesc(a: Row, b: Row): number {
  return (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
}

function makeWhereResult(rows: Row[]) {
  return {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: () => Promise.resolve(sortByCreatedAtDesc(rows)),
  };
}

const { requestsStore, decisionsStore, mockPublish, mockSignSync, mockGetIdentity } = vi.hoisted(() => ({
  requestsStore: new Map<string, Row>(),
  decisionsStore: new Map<string, Row>(),
  mockPublish: vi.fn().mockResolvedValue(undefined),
  mockSignSync: vi.fn(() => 'fake-signature'),
  mockGetIdentity: vi.fn(() => ({
    privateKeyHex: 'a'.repeat(64),
    senderPubkey: 'b'.repeat(64),
    senderDid: 'did:imajin:node',
  })),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (x: unknown) => JSON.stringify(x),
  crypto: { signSync: mockSignSync },
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: mockGetIdentity,
}));

vi.mock('nanoid', () => {
  let counter = 0;
  return { nanoid: () => `fixedid${++counter}` };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: unknown) => ({ type: 'eq', col, val }),
  and: (...conds: Cond[]) => ({ type: 'and', conds }),
  inArray: (col: string, vals: unknown[]) => ({ type: 'inArray', col, vals }),
  desc: (col: string) => col,
}));

// Self-contained: vi.mock factories may only reference vi.hoisted() bindings
// (requestsStore/decisionsStore below), so every helper the double needs lives
// as a sibling declaration inside the factory rather than at module scope.
vi.mock('@/src/db', () => {
  function makeColumnMap(columns: string): Record<string, string> {
    return columns.split(' ').reduce<Record<string, string>>((acc, k) => ({ ...acc, [k]: k }), {});
  }

  const consentRequests = makeColumnMap('id approverDid requesterDid status createdAt');
  const consentDecisions = makeColumnMap('id requestId approverDid requesterDid');

  function storeFor(table: unknown): Map<string, Row> {
    return table === consentRequests ? requestsStore : decisionsStore;
  }

  function filterRows(table: unknown, cond: Cond): Row[] {
    return [...storeFor(table).values()].filter((r) => matches(r, cond));
  }

  function insertRow(table: unknown, data: Row) {
    const now = new Date();
    const row: Row = { createdAt: now, updatedAt: now, resolvedAt: null, decisionId: null, ...data };
    storeFor(table).set(row.id as string, row);
    return { returning: () => Promise.resolve([row]) };
  }

  function whereForSelect(table: unknown, cond: Cond) {
    return makeWhereResult(filterRows(table, cond));
  }

  function whereForUpdate(table: unknown, patch: Row, cond: Cond) {
    for (const [id, row] of storeFor(table)) {
      if (matches(row, cond)) storeFor(table).set(id, { ...row, ...patch });
    }
    return Promise.resolve();
  }

  const db = {
    insert: (table: unknown) => ({ values: (data: Row) => insertRow(table, data) }),
    select: () => ({ from: (table: unknown) => ({ where: (cond: Cond) => whereForSelect(table, cond) }) }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({ where: (cond: Cond) => whereForUpdate(table, patch, cond) }),
    }),
  };

  return { db, consentRequests, consentDecisions };
});

// ─── Subject ──────────────────────────────────────────────────────────────────

import {
  raiseConsentRequest,
  getConsentRequestCard,
  listConsentRequestCards,
  decideConsentRequest,
  resolveTtlMs,
  DEFAULT_TTL_MS,
  MIN_TTL_MS,
  MAX_TTL_MS,
} from '../consent-requests';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REQUESTER_DID = 'did:imajin:openclaw-plugin';
const APPROVER_DID = 'did:imajin:human';

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
  mockSignSync.mockReturnValue('fake-signature');
  requestsStore.clear();
  decisionsStore.clear();
});

describe('resolveTtlMs', () => {
  it('defaults when unset or invalid', () => {
    expect(resolveTtlMs(undefined)).toBe(DEFAULT_TTL_MS);
    expect(resolveTtlMs('not-a-number')).toBe(DEFAULT_TTL_MS);
    expect(resolveTtlMs(-5)).toBe(DEFAULT_TTL_MS);
    expect(resolveTtlMs(0)).toBe(DEFAULT_TTL_MS);
  });

  it('clamps below the floor and above the ceiling', () => {
    expect(resolveTtlMs(1)).toBe(MIN_TTL_MS);
    expect(resolveTtlMs(MAX_TTL_MS * 10)).toBe(MAX_TTL_MS);
  });

  it('passes through an in-range value', () => {
    expect(resolveTtlMs(5 * 60 * 1000)).toBe(5 * 60 * 1000);
  });
});

describe('raiseConsentRequest', () => {
  it('persists a pending request and returns the full card payload', async () => {
    const card = await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.exec_command',
      summary: 'Run `rm -rf /tmp/build` on the build host',
      detail: { command: 'rm -rf /tmp/build' },
      requesterScope: 'consent:write',
    });

    expect(card.status).toBe('pending');
    expect(card.requesterDid).toBe(REQUESTER_DID);
    expect(card.approverDid).toBe(APPROVER_DID);
    expect(card.kind).toBe('openclaw.exec_command');
    expect(card.summary).toBe('Run `rm -rf /tmp/build` on the build host');
    expect(card.detail).toEqual({ command: 'rm -rf /tmp/build' });
    expect(card.id).toMatch(/^creq_/);
    expect(new Date(card.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('publishes consent.requested with issuer=requester, subject=approver', async () => {
    await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.skill_proposal',
      summary: 'Install the weather skill',
      requesterScope: 'consent:write',
    });

    expect(mockPublish).toHaveBeenCalledOnce();
    const [eventType, event] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventType).toBe('consent.requested');
    expect(event.issuer).toBe(REQUESTER_DID);
    expect(event.subject).toBe(APPROVER_DID);
    expect((event.payload as Record<string, unknown>).summary).toBe('Install the weather skill');
    expect((event.payload as Record<string, unknown>).kind).toBe('openclaw.skill_proposal');
  });

  it('does not throw when the bus publish fails (non-fatal)', async () => {
    mockPublish.mockRejectedValueOnce(new Error('bus down'));
    const card = await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.exec_command',
      summary: 'do the thing',
      requesterScope: 'consent:write',
    });
    expect(card.status).toBe('pending');
  });
});

describe('expiry (#1817: never silent)', () => {
  it('resolves a lapsed pending request to expired on read', async () => {
    const card = await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.exec_command',
      summary: 'expire me',
      requesterScope: 'consent:write',
      ttlMs: MIN_TTL_MS,
    });

    // Force the row's expiry into the past directly in the store.
    const row = requestsStore.get(card.id)!;
    requestsStore.set(card.id, { ...row, expiresAt: new Date(Date.now() - 1000) });

    const reread = await getConsentRequestCard(card.id);
    expect(reread?.status).toBe('expired');
    expect(reread?.resolvedAt).not.toBeNull();
  });

  it('rejects a decision on an expired request with 409, minting no attestation', async () => {
    const card = await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.exec_command',
      summary: 'expire me',
      requesterScope: 'consent:write',
    });
    const row = requestsStore.get(card.id)!;
    requestsStore.set(card.id, { ...row, expiresAt: new Date(Date.now() - 1000) });

    const result = await decideConsentRequest({
      requestId: card.id,
      approverDid: APPROVER_DID,
      decision: 'approve',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/expired/);
    }
    expect(decisionsStore.size).toBe(0);
    expect(mockPublish).toHaveBeenCalledTimes(1); // only the original consent.requested
  });

  it('surfaces expired status through the list endpoint too', async () => {
    const card = await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.exec_command',
      summary: 'expire me',
      requesterScope: 'consent:write',
    });
    const row = requestsStore.get(card.id)!;
    requestsStore.set(card.id, { ...row, expiresAt: new Date(Date.now() - 1000) });

    const listed = await listConsentRequestCards(APPROVER_DID, 'approver', ['pending', 'approved', 'rejected', 'expired']);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('expired');
  });
});

describe('decideConsentRequest', () => {
  async function raisePending() {
    return raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.exec_command',
      summary: 'Deploy build #42 to production',
      requesterScope: 'consent:write',
    });
  }

  it('approve mints a kernel-witnessed attestation referencing the request', async () => {
    const card = await raisePending();

    const result = await decideConsentRequest({
      requestId: card.id,
      approverDid: APPROVER_DID,
      decision: 'approve',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe('approved');
    expect(result.request.decisionId).toBe(result.decision.id);
    expect(result.decision.requestId).toBe(card.id);
    expect(result.decision.decision).toBe('approve');
    expect(result.decision.senderPubkey).toBe('b'.repeat(64));
    expect(result.decision.signature).toBe('fake-signature');
    expect(mockSignSync).toHaveBeenCalledOnce();

    // Persisted attestation row references the request id.
    expect(decisionsStore.get(result.decision.id)).toMatchObject({ requestId: card.id, decision: 'approve' });
  });

  it('reject mints an attestation and resolves the request as rejected', async () => {
    const card = await raisePending();

    const result = await decideConsentRequest({
      requestId: card.id,
      approverDid: APPROVER_DID,
      decision: 'reject',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe('rejected');
    expect(result.decision.decision).toBe('reject');
  });

  it('publishes approval.decision with issuer=approver, subject=requester', async () => {
    const card = await raisePending();
    await decideConsentRequest({ requestId: card.id, approverDid: APPROVER_DID, decision: 'approve' });

    expect(mockPublish).toHaveBeenCalledTimes(2); // consent.requested + approval.decision
    const [eventType, event] = mockPublish.mock.calls[1] as [string, Record<string, unknown>];
    expect(eventType).toBe('approval.decision');
    expect(event.issuer).toBe(APPROVER_DID);
    expect(event.subject).toBe(REQUESTER_DID);
    expect((event.payload as Record<string, unknown>).requestId).toBe(card.id);
  });

  it('rejects with 404 for an unknown request', async () => {
    const result = await decideConsentRequest({
      requestId: 'creq_missing',
      approverDid: APPROVER_DID,
      decision: 'approve',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('rejects with 403 when the caller is not the addressed approver', async () => {
    const card = await raisePending();
    const result = await decideConsentRequest({
      requestId: card.id,
      approverDid: 'did:imajin:someone-else',
      decision: 'approve',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    expect(decisionsStore.size).toBe(0);
  });

  it('rejects with 400 when the request already has a decision (no double-decide)', async () => {
    const card = await raisePending();
    await decideConsentRequest({ requestId: card.id, approverDid: APPROVER_DID, decision: 'approve' });

    const second = await decideConsentRequest({ requestId: card.id, approverDid: APPROVER_DID, decision: 'reject' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(400);
      expect(second.error).toMatch(/not awaiting a decision/);
    }
    // Only the first decision was persisted.
    expect(decisionsStore.size).toBe(1);
  });
});

describe('listConsentRequestCards', () => {
  it('lists by approver role by default statuses', async () => {
    await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.exec_command',
      summary: 'one',
      requesterScope: 'consent:write',
    });
    await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: 'did:imajin:someone-else',
      kind: 'openclaw.exec_command',
      summary: 'two',
      requesterScope: 'consent:write',
    });

    const listed = await listConsentRequestCards(APPROVER_DID, 'approver', ['pending', 'approved', 'rejected']);
    expect(listed).toHaveLength(1);
    expect(listed[0].summary).toBe('one');
  });

  it('lists by requester role', async () => {
    const card = await raiseConsentRequest({
      requesterDid: REQUESTER_DID,
      approverDid: APPROVER_DID,
      kind: 'openclaw.exec_command',
      summary: 'mine',
      requesterScope: 'consent:write',
    });

    const listed = await listConsentRequestCards(REQUESTER_DID, 'requester', ['pending']);
    expect(listed.map((c) => c.id)).toContain(card.id);
  });
});
