/**
 * Tests for the agent-facing grant fetch primitives (#2231 remote human ->
 * agent credential handoff):
 *   - fetchGrantSecret    — resolve/validate/decrypt one grant BY ID, for the
 *                           grantee it names, including one-time consumption.
 *   - listGrantsForGrantee — enumerate a grantee's own grants by purpose,
 *                            without any wrapped key material.
 *
 * DB is mocked with a stateful in-memory grant store, same convention as
 * static-secret-grant.test.ts, but this double actually evaluates the
 * drizzle-orm predicates (`eq`/`and`/`isNull`/`desc`, themselves mocked to
 * plain tagged objects) against the stored rows — fetchGrantSecret's exact
 * lookup-by-id and atomic one-time-claim semantics, and listGrantsForGrantee's
 * grantedTo/purpose filtering, are the behaviour under test, so unlike the
 * simplified "return the only active row" doubles used elsewhere, real
 * predicate matching is what makes these assertions meaningful.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unlink } from 'node:fs/promises';

type Row = Record<string, unknown>;
type Col = { name: string };
type Cond =
  | { __op: 'eq'; col: Col; val: unknown }
  | { __op: 'and' | 'or'; conds: Cond[] }
  | { __op: 'isNull'; col: Col }
  | { __op: 'gt'; col: Col; val: unknown }
  | { __op: 'like'; col: Col; val: unknown };

function evalCond(cond: Cond | undefined, row: Row): boolean {
  if (!cond) return true;
  switch (cond.__op) {
    case 'eq':
      return row[cond.col.name] === cond.val;
    case 'gt': {
      const v = row[cond.col.name] as number | Date | null | undefined;
      if (v === null || v === undefined) return false;
      const left = v instanceof Date ? v.getTime() : v;
      const right = cond.val instanceof Date ? cond.val.getTime() : (cond.val as number);
      return left > right;
    }
    case 'isNull':
      return row[cond.col.name] === null || row[cond.col.name] === undefined;
    case 'like': {
      const pattern = String(cond.val).replaceAll('%', '.*');
      return new RegExp(`^${pattern}$`).test(String(row[cond.col.name] ?? ''));
    }
    case 'and':
      return cond.conds.every((c) => evalCond(c, row));
    case 'or':
      return cond.conds.some((c) => evalCond(c, row));
    default:
      return true;
  }
}

// ── Hoisted setup ─────────────────────────────────────────────────────────────

const { tmpVaultPath, grantStore, envelopeStore } = vi.hoisted(() => {
  // vi.hoisted() runs before ESM imports are initialized, so `join` and
  // `tmpdir` from the top-level imports are not yet available. Use require().
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-grant-fetch-test-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;

  const grantStore = new Map<string, Row>();
  const envelopeStore = new Map<string, Row>();
  return { tmpVaultPath, grantStore, envelopeStore };
});

// ── drizzle-orm predicate mock ─────────────────────────────────────────────
//
// Real column/predicate evaluation without depending on drizzle-orm's actual
// SQL-builder internals: each mocked operator returns a small tagged object
// the fake db's `.where()` evaluates directly against a stored row.

vi.mock('drizzle-orm', () => ({
  eq: (col: Col, val: unknown): Cond => ({ __op: 'eq', col, val }),
  and: (...conds: Cond[]): Cond => ({ __op: 'and', conds }),
  or: (...conds: Cond[]): Cond => ({ __op: 'or', conds }),
  isNull: (col: Col): Cond => ({ __op: 'isNull', col }),
  gt: (col: Col, val: unknown): Cond => ({ __op: 'gt', col, val }),
  like: (col: Col, val: unknown): Cond => ({ __op: 'like', col, val }),
  desc: (col: Col) => ({ __op: 'desc', col }),
}));

// ── DB mock ─────────────────────────────────────────────────────────────────
//
// Helpers live at module scope (rather than nested inline inside the
// vi.mock() factory) purely to stay within the linter's nested-function depth
// budget; being named top-level functions (hoisted, like `evalCond` above)
// they are still safe to reference from the hoisted factory below.

function col(name: string): Col {
  return { name };
}

function insertEnvelope(data: Row): void {
  envelopeStore.set(`${String(data.field)}:${String(data.keyId)}`, data);
}

function sortRows(rows: Row[], sortCond: { __op: string; col: Col } | undefined): Row[] {
  if (!sortCond || sortCond.__op !== 'desc') return rows;
  return [...rows].sort((a, b) => compareByCol(a, b, sortCond.col));
}

function compareByCol(a: Row, b: Row, column: Col): number {
  const av = a[column.name];
  const bv = b[column.name];
  const at = av instanceof Date ? av.getTime() : (av as number);
  const bt = bv instanceof Date ? bv.getTime() : (bv as number);
  return bt - at;
}

function filterGrants(cond: Cond): Row[] {
  return [...grantStore.values()].filter((r) => evalCond(cond, r));
}

function filterEnvelopes(cond: Cond): Row[] {
  return [...envelopeStore.values()].filter((r) => evalCond(cond, r));
}

function settledArray(): { then: Promise<unknown[]>['then']; catch: Promise<unknown[]>['catch']; finally: Promise<unknown[]>['finally'] } {
  const p = Promise.resolve([] as unknown[]);
  return { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p) };
}

function insertValues(table: { __table?: string }, data: Row) {
  if (table.__table === 'envelopes') {
    insertEnvelope(data);
    return { ...settledArray(), onConflictDoUpdate: () => insertOnConflict(data) };
  }
  if (table.__table === 'requests') {
    return Promise.resolve([]);
  }
  grantStore.set(String(data.id), { purpose: null, oneTime: false, consumedAt: null, ...data });
  return Promise.resolve([]);
}

function insertOnConflict(data: Row): Promise<unknown[]> {
  insertEnvelope(data);
  return Promise.resolve([]);
}

function applyPatch(row: Row, patch: Row): Row {
  const next = { ...row, ...patch };
  grantStore.set(String(row.id), next);
  return next;
}

function updateWhere(patch: Row, cond: Cond) {
  const patched = filterGrants(cond).map((row) => applyPatch(row, patch));
  return { ...settledArray(), returning: () => Promise.resolve(patched) };
}

function selectEnvelopesWhere(cond: Cond) {
  const rows = filterEnvelopes(cond);
  return { limit: () => Promise.resolve(rows.slice(0, 1)) };
}

function selectGrantsWhere(cond: Cond) {
  const rows = filterGrants(cond);
  return {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    orderBy: (sortCond: { __op: string; col: Col }) => Promise.resolve(sortRows(rows, sortCond)),
  };
}

function selectWhere(table: { __table?: string }, cond: Cond) {
  return table.__table === 'envelopes' ? selectEnvelopesWhere(cond) : selectGrantsWhere(cond);
}

vi.mock('@/src/db', () => {
  const vaultDelegationGrants = {
    __table: 'grants',
    id: col('id'),
    field: col('field'),
    subject: col('subject'),
    grantedTo: col('grantedTo'),
    keyId: col('keyId'),
    status: col('status'),
    purpose: col('purpose'),
    oneTime: col('oneTime'),
    consumedAt: col('consumedAt'),
    expiresAt: col('expiresAt'),
    createdAt: col('createdAt'),
  };
  const vaultOwnerEnvelopes = { __table: 'envelopes', field: col('field'), keyId: col('keyId') };
  const vaultGrantRequests = { __table: 'requests' };

  return {
    db: {
      insert: (table: { __table?: string }) => ({ values: (data: Row) => insertValues(table, data) }),
      update: () => ({ set: (patch: Row) => ({ where: (cond: Cond) => updateWhere(patch, cond) }) }),
      select: () => ({ from: (table: { __table?: string }) => ({ where: (cond: Cond) => selectWhere(table, cond) }) }),
    },
    vaultDelegationGrants,
    vaultOwnerEnvelopes,
    vaultGrantRequests,
  };
});

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { sealAndGrantStaticSecret, fetchGrantSecret, listGrantsForGrantee } from '../index.js';
import { _resetSealingCache } from '../sealing.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const PRINCIPAL = 'did:imajin:chris';
const AGENT = 'did:imajin:gha-runner-agent';
const OTHER_AGENT = 'did:imajin:some-other-agent';
const SECRET = 'ghp_super-secret-runner-registration-token';
const FIELD = 'gha-runner-token:did:imajin:chris';

beforeEach(() => {
  grantStore.clear();
  envelopeStore.clear();
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
});

afterEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  delete process.env.VAULT_OWNER_X_PUB;
  delete process.env.VAULT_OWNER_ED_PUB;
  await unlink(tmpVaultPath).catch(() => undefined);
});

/**
 * Seal + grant a fresh field, returning its grantId, then tag it with #2231
 * metadata.
 *
 * `expiresAt` is threaded through `sealAndGrantStaticSecret` itself rather
 * than patched into the store afterwards like the other overrides: it is
 * part of the owner-signed canonical payload, so mutating it post-hoc would
 * desync the stored value from what was actually signed and fail signature
 * verification at decrypt time — which is the correct, intended behaviour,
 * not something a test should work around by tampering with the row.
 */
async function seedGrant(overrides: Partial<Row> = {}, field = FIELD, secret = SECRET) {
  const { expiresAt, ...metadataOverrides } = overrides;
  const { grantId } = await sealAndGrantStaticSecret(field, secret, {
    principalDid: PRINCIPAL,
    granteeDid: AGENT,
    expiresAt: (expiresAt as Date | null | undefined) ?? null,
  });
  const id = grantId!;
  grantStore.set(id, { ...grantStore.get(id), ...metadataOverrides });
  return id;
}

// ── fetchGrantSecret ──────────────────────────────────────────────────────────

describe('fetchGrantSecret', () => {
  it('decrypts and returns the sealed plaintext for the correct grantee', async () => {
    const grantId = await seedGrant();
    const outcome = await fetchGrantSecret({ grantId, granteeDid: AGENT });

    expect(outcome.status).toBe('ok');
    expect(outcome.status === 'ok' && outcome.value).toBe(SECRET);
  });

  it('returns not_found for an unknown grantId', async () => {
    const outcome = await fetchGrantSecret({ grantId: 'vdg_nonexistent', granteeDid: AGENT });
    expect(outcome.status).toBe('not_found');
  });

  it('returns not_grantee when the caller does not match grantedTo', async () => {
    const grantId = await seedGrant();
    const outcome = await fetchGrantSecret({ grantId, granteeDid: OTHER_AGENT });
    expect(outcome.status).toBe('not_grantee');
  });

  it('returns inactive for a revoked grant', async () => {
    const grantId = await seedGrant({ status: 'revoked' });
    const outcome = await fetchGrantSecret({ grantId, granteeDid: AGENT });
    expect(outcome.status).toBe('inactive');
  });

  it('returns expired for a grant past its expiresAt', async () => {
    const grantId = await seedGrant({ expiresAt: new Date(Date.now() - 1000) });
    const outcome = await fetchGrantSecret({ grantId, granteeDid: AGENT });
    expect(outcome.status).toBe('expired');
  });

  it('does not treat a future expiresAt as expired', async () => {
    const grantId = await seedGrant({ expiresAt: new Date(Date.now() + 86_400_000) });
    const outcome = await fetchGrantSecret({ grantId, granteeDid: AGENT });
    expect(outcome.status).toBe('ok');
  });

  describe('one-time grants', () => {
    it('succeeds on the first fetch and marks the grant consumed', async () => {
      const grantId = await seedGrant({ oneTime: true });

      const first = await fetchGrantSecret({ grantId, granteeDid: AGENT });
      expect(first.status).toBe('ok');
      expect(first.status === 'ok' && first.value).toBe(SECRET);
      expect(grantStore.get(grantId)!.consumedAt).toBeInstanceOf(Date);
    });

    it('refuses a second fetch with consumed', async () => {
      const grantId = await seedGrant({ oneTime: true });

      await fetchGrantSecret({ grantId, granteeDid: AGENT });
      const second = await fetchGrantSecret({ grantId, granteeDid: AGENT });

      expect(second.status).toBe('consumed');
    });

    it('reports consumed immediately when consumedAt is already set', async () => {
      const grantId = await seedGrant({ oneTime: true, consumedAt: new Date() });
      const outcome = await fetchGrantSecret({ grantId, granteeDid: AGENT });
      expect(outcome.status).toBe('consumed');
    });

    it('never marks a non-oneTime grant consumed', async () => {
      const grantId = await seedGrant({ oneTime: false });

      await fetchGrantSecret({ grantId, granteeDid: AGENT });
      const second = await fetchGrantSecret({ grantId, granteeDid: AGENT });

      expect(second.status).toBe('ok');
      expect(grantStore.get(grantId)!.consumedAt).toBeNull();
    });
  });
});

// ── listGrantsForGrantee ──────────────────────────────────────────────────────

describe('listGrantsForGrantee', () => {
  beforeEach(() => {
    grantStore.set('vdg_a1', {
      id: 'vdg_a1', subject: PRINCIPAL, grantedTo: AGENT, field: 'GH_TOKEN',
      purpose: 'gha-runner-registration', oneTime: true, status: 'active',
      expiresAt: null, consumedAt: null, createdAt: new Date('2025-01-01T00:00:00Z'),
    });
    grantStore.set('vdg_a2', {
      id: 'vdg_a2', subject: PRINCIPAL, grantedTo: AGENT, field: 'OTHER_FIELD',
      purpose: 'unrelated-task', oneTime: false, status: 'active',
      expiresAt: null, consumedAt: null, createdAt: new Date('2025-01-02T00:00:00Z'),
    });
    grantStore.set('vdg_b1', {
      id: 'vdg_b1', subject: PRINCIPAL, grantedTo: OTHER_AGENT, field: 'GH_TOKEN',
      purpose: 'gha-runner-registration', oneTime: false, status: 'active',
      expiresAt: null, consumedAt: null, createdAt: new Date('2025-01-03T00:00:00Z'),
    });
  });

  it('returns only the grants issued to the requesting grantee', async () => {
    const rows = await listGrantsForGrantee({ granteeDid: AGENT });
    expect(rows.map((r) => r.grantId).sort()).toEqual(['vdg_a1', 'vdg_a2']);
  });

  it('never includes another grantee\'s grants, even sharing a purpose', async () => {
    const rows = await listGrantsForGrantee({ granteeDid: AGENT });
    expect(rows.some((r) => r.grantId === 'vdg_b1')).toBe(false);
  });

  it('narrows to a single purpose when provided', async () => {
    const rows = await listGrantsForGrantee({ granteeDid: AGENT, purpose: 'gha-runner-registration' });
    expect(rows.map((r) => r.grantId)).toEqual(['vdg_a1']);
  });

  it('orders results newest first', async () => {
    const rows = await listGrantsForGrantee({ granteeDid: AGENT });
    expect(rows.map((r) => r.grantId)).toEqual(['vdg_a2', 'vdg_a1']);
  });

  it('never exposes wrapped key material', async () => {
    const rows = await listGrantsForGrantee({ granteeDid: AGENT });
    for (const row of rows) {
      expect(row).not.toHaveProperty('wrappedKey');
      expect(row).not.toHaveProperty('wrappedNonce');
    }
  });
});
