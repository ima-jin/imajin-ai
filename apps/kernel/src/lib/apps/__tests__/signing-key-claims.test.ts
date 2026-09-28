/**
 * Unit tests for the app signing-key claim code primitives (#2411):
 * issuance, redemption, single-use enforcement, expiry, and re-issuance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const NODE_DID = 'did:imajin:node';
const APP_DID = 'did:imajin:app-under-test';
const GRANT_ID = 'vdg_app_self_1';
const SLUG = 'dykil';

const { claimsRef, claimsStore, publishMock, logMock, idCounterRef } = vi.hoisted(() => {
  return {
    claimsRef: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? prop : undefined) }) as Record<string, unknown>,
    claimsStore: new Map<string, Record<string, unknown>>(),
    publishMock: vi.fn().mockResolvedValue(undefined),
    logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    idCounterRef: { current: 0 },
  };
});

vi.mock('@imajin/logger', () => ({ createLogger: () => logMock }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: (prefix: string) => `${prefix}_testid_${idCounterRef.current++}` }));

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: unknown) => ({ col, val }),
  and: (...conds: Array<{ col: string; val: unknown }>) => conds,
}));

interface FakeCond { col: string; val: unknown }
type FakeWhere = FakeCond | FakeCond[];

function matches(row: Record<string, unknown>, where: FakeWhere | undefined): boolean {
  if (!where) return true;
  const conds = Array.isArray(where) ? where : [where];
  return conds.every((cond) => row[cond.col] === cond.val);
}

class FakeSelectChain {
  private cond: FakeWhere | undefined;
  from(_table: unknown): this {
    return this;
  }
  where(cond: FakeWhere): this {
    this.cond = cond;
    return this;
  }
  limit(n: number): Promise<Record<string, unknown>[]> {
    return Promise.resolve([...claimsStore.values()].filter((r) => matches(r, this.cond)).slice(0, n));
  }
}

class FakeUpdateChain {
  private patch: Record<string, unknown> = {};
  set(patch: Record<string, unknown>): this {
    this.patch = patch;
    return this;
  }
  where(cond: FakeWhere): { returning: (proj: Record<string, unknown>) => Promise<Record<string, unknown>[]> } & Promise<void> {
    const touched: Record<string, unknown>[] = [];
    for (const row of claimsStore.values()) {
      if (matches(row, cond)) {
        Object.assign(row, this.patch);
        touched.push(row);
      }
    }
    const promise = Promise.resolve() as unknown as { returning: (proj: Record<string, unknown>) => Promise<Record<string, unknown>[]> } & Promise<void>;
    promise.returning = (proj: Record<string, unknown>) =>
      Promise.resolve(touched.map((row) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(proj)) out[key] = row[key];
        return out;
      }));
    return promise;
  }
}

class FakeInsertChain {
  values(row: Record<string, unknown>): Promise<void> {
    claimsStore.set(row.id as string, { ...row });
    return Promise.resolve();
  }
}

vi.mock('@/src/db', () => ({
  appSigningKeyClaims: claimsRef,
  db: {
    select: () => new FakeSelectChain(),
    update: () => new FakeUpdateChain(),
    insert: () => new FakeInsertChain(),
  },
}));

import { issueSigningKeyClaim, claimSigningKey } from '../signing-key-claims';

beforeEach(() => {
  vi.clearAllMocks();
  claimsStore.clear();
});

describe('issueSigningKeyClaim', () => {
  it('returns a plaintext code and persists only its hash', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });

    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(10);

    const rows = [...claimsStore.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].codeHash).not.toBe(code);
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].grantId).toBe(GRANT_ID);
  });

  it('emits apps.signing-key.claim.issued without the plaintext code', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });

    expect(publishMock).toHaveBeenCalledWith('apps.signing-key.claim.issued', expect.objectContaining({
      issuer: NODE_DID,
      subject: APP_DID,
      payload: expect.objectContaining({ slug: SLUG, appDid: APP_DID, grantId: GRANT_ID }),
    }));
    for (const call of publishMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(code);
    }
  });

  it('expires a still-pending prior code for the same app before issuing a fresh one (re-issuance)', async () => {
    const firstCode = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    const secondCode = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });

    expect(secondCode).not.toBe(firstCode);
    expect(claimsStore.size).toBe(2);
    const rows = [...claimsStore.values()];
    const firstRow = rows.find((r) => r.status !== 'pending');
    expect(firstRow?.status).toBe('expired');

    // The old code no longer redeems.
    const outcome = await claimSigningKey({ code: firstCode });
    expect(outcome.status).toBe('expired');
    // The fresh code redeems fine.
    expect((await claimSigningKey({ code: secondCode })).status).toBe('ok');
  });
});

describe('claimSigningKey', () => {
  it('redeems a fresh, valid code exactly once', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });

    const outcome = await claimSigningKey({ code, hostHint: 'dykil-standalone' });

    expect(outcome).toEqual({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    const row = [...claimsStore.values()][0];
    expect(row.status).toBe('claimed');
    expect(row.claimedByHost).toBe('dykil-standalone');
    expect(row.claimedAt).toBeInstanceOf(Date);
  });

  it('refuses an unrecognized code with not_found', async () => {
    const outcome = await claimSigningKey({ code: 'claim_never_issued' });
    expect(outcome).toEqual({ status: 'not_found' });
  });

  // #2411 required test: claim code reused.
  it('refuses a SECOND redemption of an already-claimed code (claim code reused)', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    await claimSigningKey({ code });

    const secondAttempt = await claimSigningKey({ code });

    expect(secondAttempt).toEqual({ status: 'already_claimed' });
  });

  // #2411 required test: claim code expired.
  it('refuses a redemption after the code has expired', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    const row = [...claimsStore.values()][0];
    row.expiresAt = new Date(Date.now() - 1000); // force past expiry

    const outcome = await claimSigningKey({ code });

    expect(outcome).toEqual({ status: 'expired' });
    expect(row.status).toBe('expired');
  });

  it('treats a lazily-flipped expired row as expired on a later attempt too', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    const row = [...claimsStore.values()][0];
    row.expiresAt = new Date(Date.now() - 1000);
    await claimSigningKey({ code }); // first attempt lazily flips status -> 'expired'

    const secondAttempt = await claimSigningKey({ code });

    expect(secondAttempt).toEqual({ status: 'expired' });
  });

  it('never reveals whether a code is unknown vs. already-claimed vs. expired through timing-independent shape (each is a distinct closed status)', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    await claimSigningKey({ code });

    expect((await claimSigningKey({ code: 'unknown' })).status).toBe('not_found');
    expect((await claimSigningKey({ code })).status).toBe('already_claimed');
  });
});
