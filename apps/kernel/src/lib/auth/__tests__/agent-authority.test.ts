/**
 * Unit tests for the #1887 grants-first / membership-fallback dual-read
 * resolution (`resolveAgentAuthority`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eqPredicate, gtPredicate, isNullPredicate, andPredicate, type Row, type Predicate } from './drizzle-predicate-mocks';

const { membersStore, grantsStore, MEMBERS_TABLE, GRANTS_TABLE } = vi.hoisted(() => {
  const membersStore = new Map<string, Row>();
  const grantsStore = new Map<string, Row>();
  const MEMBERS_TABLE = {
    __table: 'members',
    identityDid: 'identityDid',
    memberDid: 'memberDid',
    role: 'role',
    removedAt: 'removedAt',
  };
  const GRANTS_TABLE = {
    __table: 'grants',
    id: 'id',
    agentDid: 'agentDid',
    delegatorDid: 'delegatorDid',
    status: 'status',
    expiresAt: 'expiresAt',
  };
  return { membersStore, grantsStore, MEMBERS_TABLE, GRANTS_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  return table.__table === 'members' ? membersStore : grantsStore;
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, eq: eqPredicate, gt: gtPredicate, isNull: isNullPredicate, and: andPredicate };
});

function projectRow(row: Row, projection: Record<string, string>): Row {
  const out: Row = {};
  for (const key of Object.keys(projection)) out[key] = row[projection[key]];
  return out;
}

function runLimit(table: { __table: string }, predicate: Predicate, n: number, projection?: Record<string, string>) {
  const rows = [...storeFor(table).values()].filter(predicate).slice(0, n);
  if (!projection) return Promise.resolve(rows);
  return Promise.resolve(rows.map((row) => projectRow(row, projection)));
}

function selectFrom(projection?: Record<string, string>) {
  return {
    from: (table: { __table: string }) => ({
      where: (predicate: Predicate) => ({
        limit: (n: number) => runLimit(table, predicate, n, projection),
      }),
    }),
  };
}

vi.mock('@/src/db', () => ({
  db: { select: selectFrom },
  identityMembers: MEMBERS_TABLE,
  delegationGrants: GRANTS_TABLE,
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { resolveAgentAuthority, agentAuthorityMode } from '../agent-authority';

const AGENT = 'did:imajin:jin';
const PRINCIPAL = 'did:imajin:ryan';

function membership(overrides: Row = {}): Row {
  return { identityDid: PRINCIPAL, memberDid: AGENT, role: 'agent', removedAt: null, ...overrides };
}

function grant(overrides: Row = {}): Row {
  return {
    id: 'grant_1',
    agentDid: AGENT,
    delegatorDid: PRINCIPAL,
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  membersStore.clear();
  grantsStore.clear();
  delete process.env.AGENT_AUTHORITY_MODE;
});

afterEach(() => {
  delete process.env.AGENT_AUTHORITY_MODE;
});

describe('agentAuthorityMode', () => {
  it('defaults to grants-first', () => {
    expect(agentAuthorityMode()).toBe('grants-first');
  });

  it('honors AGENT_AUTHORITY_MODE=membership-only as the rollback switch', () => {
    process.env.AGENT_AUTHORITY_MODE = 'membership-only';
    expect(agentAuthorityMode()).toBe('membership-only');
  });

  it('treats any other value as grants-first (fail safe toward the new behavior, not open toward typos)', () => {
    process.env.AGENT_AUTHORITY_MODE = 'bogus';
    expect(agentAuthorityMode()).toBe('grants-first');
  });
});

describe('resolveAgentAuthority — grants-first (default)', () => {
  it('allows via an active grant without consulting membership at all', async () => {
    grantsStore.set('grant_1', grant());

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({
      allowed: true,
      via: 'grant',
      grantId: 'grant_1',
    });
  });

  it('ignores an expired grant and falls back to membership', async () => {
    grantsStore.set('grant_1', grant({ expiresAt: new Date(Date.now() - 1000) }));
    membersStore.set('m1', membership());

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: true, via: 'membership' });
  });

  it('ignores a revoked grant and falls back to membership', async () => {
    grantsStore.set('grant_1', grant({ status: 'revoked' }));
    membersStore.set('m1', membership());

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: true, via: 'membership' });
  });

  it('falls back to an active role:agent membership when no grant exists, logged as a dual-read fallback', async () => {
    membersStore.set('m1', membership());

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: true, via: 'membership' });
  });

  it('denies when neither a grant nor a membership authorizes the agent', async () => {
    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: false, via: 'none' });
  });

  it('denies a revoked membership even with no grant present', async () => {
    membersStore.set('m1', membership({ removedAt: new Date() }));

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: false, via: 'none' });
  });

  it('denies a non-agent-role membership', async () => {
    membersStore.set('m1', membership({ role: 'member' }));

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: false, via: 'none' });
  });

  it('a grant issued in the opposite direction does not authorize the reverse relationship', async () => {
    // Ryan holding a grant issued by Jin does not let Jin act for Ryan.
    grantsStore.set('grant_1', grant({ agentDid: PRINCIPAL, delegatorDid: AGENT }));

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: false, via: 'none' });
  });

  it('#1887 acceptance case: revoking an agent\u2019s only (backfilled wide) grant cuts it off fail-closed once the legacy membership is also gone', async () => {
    // Mirrors the end state of the #1887 migration sketch (step 6, cleanup):
    // role:agent rows are gone and the backfilled wide grant is the only
    // authority record. Revoking it must deny outright, not fail open.
    grantsStore.set('grant_1', grant({ status: 'active' }));
    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toMatchObject({ allowed: true, via: 'grant' });

    grantsStore.set('grant_1', grant({ status: 'revoked' }));
    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: false, via: 'none' });
  });
});

describe('resolveAgentAuthority — membership-only (rollback flag)', () => {
  beforeEach(() => {
    process.env.AGENT_AUTHORITY_MODE = 'membership-only';
  });

  it('ignores an active grant entirely and resolves via membership', async () => {
    grantsStore.set('grant_1', grant());
    membersStore.set('m1', membership());

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: true, via: 'membership' });
  });

  it('denies when only a grant exists and membership does not (pre-#1887 behavior restored)', async () => {
    grantsStore.set('grant_1', grant());

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).resolves.toEqual({ allowed: false, via: 'none' });
  });
});

describe('resolveAgentAuthority — fail-closed on storage errors', () => {
  it('propagates a lookup failure rather than resolving to allowed', async () => {
    const { db } = await import('@/src/db');
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('connection terminated');
    });

    await expect(resolveAgentAuthority(AGENT, PRINCIPAL)).rejects.toThrow('connection terminated');
  });
});
