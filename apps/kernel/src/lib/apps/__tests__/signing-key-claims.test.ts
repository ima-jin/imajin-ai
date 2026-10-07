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
  eq: (col: string, val: unknown) => ({ col, val, op: 'eq' as const }),
  ne: (col: string, val: unknown) => ({ col, val, op: 'ne' as const }),
  isNull: (col: string) => ({ col, val: null, op: 'isNull' as const }),
  isNotNull: (col: string) => ({ col, val: null, op: 'isNotNull' as const }),
  and: (...conds: FakeCond[]) => conds,
  desc: (col: string) => col,
}));

interface FakeCond { col: string; val: unknown; op?: 'eq' | 'ne' | 'isNull' | 'isNotNull' }
type FakeWhere = FakeCond | FakeCond[];

function matchesCond(row: Record<string, unknown>, cond: FakeCond): boolean {
  switch (cond.op) {
    case 'ne':
      return row[cond.col] !== cond.val;
    case 'isNull':
      return row[cond.col] === null || row[cond.col] === undefined;
    case 'isNotNull':
      return row[cond.col] !== null && row[cond.col] !== undefined;
    default:
      return row[cond.col] === cond.val;
  }
}

function matches(row: Record<string, unknown>, where: FakeWhere | undefined): boolean {
  if (!where) return true;
  const conds = Array.isArray(where) ? where : [where];
  return conds.every((cond) => matchesCond(row, cond));
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
  orderBy(_col: unknown): this {
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

import { issueSigningKeyClaim, claimSigningKey, resolveActiveBootstrapBinding, revokeBootstrapBindingsForAppDid } from '../signing-key-claims';

const BOOTSTRAP_PUBLIC_KEY_1 = 'a'.repeat(64);
const BOOTSTRAP_PUBLIC_KEY_2 = 'b'.repeat(64);

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

  it('#2707: never logs the plaintext code (hash-only persistence, nothing in any log call)', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });

    expect(logMock.info).toHaveBeenCalled();
    for (const spy of [logMock.info, logMock.warn, logMock.error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(code);
    }
    // The only persisted column that can relate to the code is its SHA-256 digest.
    const [row] = [...claimsStore.values()];
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
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
    const outcome = await claimSigningKey({ code: firstCode, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });
    expect(outcome.status).toBe('expired');
    // The fresh code redeems fine.
    expect((await claimSigningKey({ code: secondCode, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 })).status).toBe('ok');
  });
});

describe('claimSigningKey', () => {
  it('redeems a fresh, valid code exactly once and binds the bootstrap public key', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });

    const outcome = await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1, hostHint: 'dykil-standalone' });

    expect(outcome).toEqual({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    const row = [...claimsStore.values()][0];
    expect(row.status).toBe('claimed');
    expect(row.claimedByHost).toBe('dykil-standalone');
    expect(row.claimedAt).toBeInstanceOf(Date);
    expect(row.bootstrapPublicKey).toBe(BOOTSTRAP_PUBLIC_KEY_1);
  });

  it('refuses an unrecognized code with not_found', async () => {
    const outcome = await claimSigningKey({ code: 'claim_never_issued', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });
    expect(outcome).toEqual({ status: 'not_found' });
  });

  // #2444 required test: a foreign code is refused before it is spent.
  describe('expectedAppDid binding (#2444)', () => {
    const OTHER_APP_DID = 'did:imajin:some-other-app';

    it('refuses a code issued for a different app with app_mismatch, without spending or binding anything', async () => {
      const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });

      const outcome = await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1, hostHint: 'wrong-box', expectedAppDid: OTHER_APP_DID });

      expect(outcome).toEqual({ status: 'app_mismatch' });
      const row = [...claimsStore.values()][0];
      expect(row.status).toBe('pending');
      expect(row.claimedAt).toBeUndefined();
      expect(row.claimedByHost).toBeUndefined();
      expect(row.bootstrapPublicKey).toBeUndefined();
      expect(await resolveActiveBootstrapBinding(APP_DID)).toBeNull();
    });

    it('leaves the code claimable by the right app after a mismatch', async () => {
      const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
      await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_2, expectedAppDid: OTHER_APP_DID });

      const outcome = await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1, expectedAppDid: APP_DID });

      expect(outcome).toEqual({ status: 'ok', slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
      expect(await resolveActiveBootstrapBinding(APP_DID)).toMatchObject({ boundPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });
    });

    it('redeems normally when expectedAppDid matches', async () => {
      const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });

      const outcome = await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1, expectedAppDid: APP_DID });

      expect(outcome.status).toBe('ok');
    });

    it('reports a mismatch before any lifecycle state — an expired or already-claimed foreign code is neither disclosed nor mutated', async () => {
      const expiredCode = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
      const expiredRow = [...claimsStore.values()][0];
      expiredRow.expiresAt = new Date(Date.now() - 1000);

      expect(await claimSigningKey({ code: expiredCode, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1, expectedAppDid: OTHER_APP_DID })).toEqual({ status: 'app_mismatch' });
      expect(expiredRow.status).toBe('pending'); // not lazily flipped to 'expired' by the wrong caller

      const claimedCode = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: 'did:imajin:second-app', grantId: GRANT_ID });
      await claimSigningKey({ code: claimedCode, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });

      expect(await claimSigningKey({ code: claimedCode, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_2, expectedAppDid: OTHER_APP_DID })).toEqual({ status: 'app_mismatch' });
    });

    it('still reports not_found for an unknown code even when expectedAppDid is given', async () => {
      const outcome = await claimSigningKey({ code: 'claim_never_issued', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1, expectedAppDid: APP_DID });
      expect(outcome).toEqual({ status: 'not_found' });
    });
  });

  // #2411 required test: claim code reused.
  it('refuses a SECOND redemption of an already-claimed code (claim code reused)', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });

    const secondAttempt = await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_2 });

    expect(secondAttempt).toEqual({ status: 'already_claimed' });
  });

  // #2411 required test: claim code expired.
  it('refuses a redemption after the code has expired', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    const row = [...claimsStore.values()][0];
    row.expiresAt = new Date(Date.now() - 1000); // force past expiry

    const outcome = await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });

    expect(outcome).toEqual({ status: 'expired' });
    expect(row.status).toBe('expired');
  });

  it('treats a lazily-flipped expired row as expired on a later attempt too', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    const row = [...claimsStore.values()][0];
    row.expiresAt = new Date(Date.now() - 1000);
    await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 }); // first attempt lazily flips status -> 'expired'

    const secondAttempt = await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });

    expect(secondAttempt).toEqual({ status: 'expired' });
  });

  it('never reveals whether a code is unknown vs. already-claimed vs. expired through timing-independent shape (each is a distinct closed status)', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });

    expect((await claimSigningKey({ code: 'unknown', bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 })).status).toBe('not_found');
    expect((await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 })).status).toBe('already_claimed');
  });
});

describe('resolveActiveBootstrapBinding', () => {
  it('returns null when the app has never completed a claim exchange', async () => {
    expect(await resolveActiveBootstrapBinding(APP_DID)).toBeNull();
  });

  it('resolves the bound public key after a successful claim', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });

    const binding = await resolveActiveBootstrapBinding(APP_DID);

    expect(binding).toEqual({ slug: SLUG, appDid: APP_DID, grantId: GRANT_ID, boundPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });
  });

  // #2411 required test: rebinding via reissueClaim revokes the old key.
  it('a second claim (reissueClaim rebinding) revokes the previous bootstrap key binding', async () => {
    const firstCode = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    await claimSigningKey({ code: firstCode, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });
    expect(await resolveActiveBootstrapBinding(APP_DID)).toMatchObject({ boundPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });

    // Operator re-approves apps.provision with reissueClaim: true -> a fresh
    // code is issued and redeemed with a NEW bootstrap keypair (lost keystore).
    const secondCode = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    await claimSigningKey({ code: secondCode, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_2 });

    const binding = await resolveActiveBootstrapBinding(APP_DID);
    expect(binding?.boundPublicKey).toBe(BOOTSTRAP_PUBLIC_KEY_2);

    const rows = [...claimsStore.values()];
    const firstRow = rows.find((r) => r.bootstrapPublicKey === BOOTSTRAP_PUBLIC_KEY_1);
    expect(firstRow?.bootstrapKeyRevokedAt).toBeInstanceOf(Date);
  });

  it('revokeBootstrapBindingsForAppDid revokes every active binding except the excluded row', async () => {
    const code = await issueSigningKeyClaim({ nodeDid: NODE_DID, slug: SLUG, appDid: APP_DID, grantId: GRANT_ID });
    await claimSigningKey({ code, bootstrapPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });
    const row = [...claimsStore.values()][0];

    await revokeBootstrapBindingsForAppDid(APP_DID, row.id as string);
    expect(await resolveActiveBootstrapBinding(APP_DID)).toMatchObject({ boundPublicKey: BOOTSTRAP_PUBLIC_KEY_1 });

    await revokeBootstrapBindingsForAppDid(APP_DID);
    expect(await resolveActiveBootstrapBinding(APP_DID)).toBeNull();
  });
});
