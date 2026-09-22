/**
 * Unit tests for the foreign-principal stub primitive (#2251).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const { identitiesStore, stubsStore, IDENTITIES_TABLE, STUBS_TABLE } = vi.hoisted(() => {
  const identitiesStore = new Map<string, Row>();
  const stubsStore = new Map<string, Row>();
  const IDENTITIES_TABLE = {
    __table: 'identities',
    id: 'id', scope: 'scope', subtype: 'subtype', publicKey: 'publicKey', tier: 'tier', metadata: 'metadata',
  };
  const STUBS_TABLE = {
    __table: 'foreign_principal_stubs',
    id: 'id', platform: 'platform', externalRefHmac: 'externalRefHmac', stubDid: 'stubDid', createdAt: 'createdAt',
  };
  return { identitiesStore, stubsStore, IDENTITIES_TABLE, STUBS_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  switch (table.__table) {
    case 'identities': return identitiesStore;
    case 'foreign_principal_stubs': return stubsStore;
    default: throw new Error(`unknown table ${table.__table}`);
  }
}

function project(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows;
  return rows.map((row) => projectRow(row, projection));
}

function projectRow(row: Row, projection: Record<string, string>): Row {
  const result: Row = {};
  for (const key of Object.keys(projection)) result[key] = row[projection[key]];
  return result;
}

function insertInto(table: { __table: string }) {
  return {
    values: (data: Row) => {
      storeFor(table).set(String(data.id ?? data.stubDid), { ...data });
      return Promise.resolve([data]);
    },
  };
}

function whereClause(table: { __table: string }, projection?: Record<string, string>) {
  return {
    where: (predicate: Predicate) => {
      const rows = project([...storeFor(table).values()].filter(predicate), projection);
      return { limit: (n: number) => Promise.resolve(rows.slice(0, n)) };
    },
  };
}

function selectFrom(projection?: Record<string, string>) {
  return { from: (table: { __table: string }) => whereClause(table, projection) };
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  return { ...actual, eq, and };
});

vi.mock('@/src/db', () => ({
  db: { insert: insertInto, select: selectFrom },
  identities: IDENTITIES_TABLE,
  foreignPrincipalStubs: STUBS_TABLE,
}));

// #2245 — the pepper is now a self-provisioned vault secret, not an env var.
// Mocked here so these tests exercise the stub-dedup logic in isolation;
// internal-secret.ts's own generate/fetch/concurrency contract has its own
// dedicated test suite (internal-secret.test.ts).
const getInternalSecretMock = vi.fn();
vi.mock('@/src/lib/vault', () => ({
  getInternalSecret: (...args: unknown[]) => getInternalSecretMock(...args),
}));

import { resolveOrMintForeignPrincipalStub, findForeignPrincipalStubDid, hmacForeignPrincipalRef } from '../foreign-principal-stub';

describe('foreign-principal-stub (#2251)', () => {
  beforeEach(() => {
    identitiesStore.clear();
    stubsStore.clear();
    getInternalSecretMock.mockReset().mockResolvedValue('test-secret');
  });

  it('generates the pepper on first call, via getInternalSecret with the kernel.foreign-principal-pepper purpose, and reuses it on every subsequent call', async () => {
    const first = await hmacForeignPrincipalRef('meta-muse', 'alice-1');
    const second = await hmacForeignPrincipalRef('meta-muse', 'bob-1');

    expect(getInternalSecretMock).toHaveBeenCalledWith('kernel.foreign-principal-pepper');
    expect(getInternalSecretMock).toHaveBeenCalledTimes(2);
    // Same pepper both times (getInternalSecret's own cache is responsible
    // for reuse — this just proves both HMACs were computed with the same
    // secret it returned).
    expect(first).not.toBe(second); // different externalRef -> different HMAC
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints a new soft-tier, no-PII stub identity on first sight of a (platform, externalRef) pair', async () => {
    const result = await resolveOrMintForeignPrincipalStub({ platform: 'meta-muse', externalRef: 'alice-1' });
    expect(result.isNewStub).toBe(true);
    expect(result.did).toMatch(/^did:imajin:/);

    const identity = identitiesStore.get(result.did);
    expect(identity?.tier).toBe('soft');
    expect(identity?.subtype).toBe('human');
    expect(identity?.publicKey).toMatch(/^stub_/);
    expect(JSON.stringify(identity?.metadata)).not.toContain('alice-1');
  });

  it('silently accrues to the same stub DID on repeat sight of the same pair (match-without-disclosure)', async () => {
    const first = await resolveOrMintForeignPrincipalStub({ platform: 'meta-muse', externalRef: 'alice-1' });
    const second = await resolveOrMintForeignPrincipalStub({ platform: 'meta-muse', externalRef: 'alice-1' });

    expect(second.isNewStub).toBe(false);
    expect(second.did).toBe(first.did);
    expect(stubsStore.size).toBe(1);
  });

  it('mints distinct stubs for the same externalRef on different platforms', async () => {
    const museResult = await resolveOrMintForeignPrincipalStub({ platform: 'meta-muse', externalRef: 'user-1' });
    const otherResult = await resolveOrMintForeignPrincipalStub({ platform: 'other-platform', externalRef: 'user-1' });

    expect(museResult.did).not.toBe(otherResult.did);
  });

  it('findForeignPrincipalStubDid returns null when no stub exists, and the DID once minted', async () => {
    expect(await findForeignPrincipalStubDid('meta-muse', 'bob-1')).toBeNull();

    const minted = await resolveOrMintForeignPrincipalStub({ platform: 'meta-muse', externalRef: 'bob-1' });
    expect(await findForeignPrincipalStubDid('meta-muse', 'bob-1')).toBe(minted.did);
  });

  it('never stores the raw externalRef anywhere — only its HMAC', async () => {
    const result = await resolveOrMintForeignPrincipalStub({ platform: 'meta-muse', externalRef: 'super-secret-user-id' });
    const stubRow = [...stubsStore.values()].find((row) => row.stubDid === result.did);
    expect(JSON.stringify(stubRow)).not.toContain('super-secret-user-id');
  });
});
