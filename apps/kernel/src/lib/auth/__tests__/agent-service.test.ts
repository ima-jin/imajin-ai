/**
 * #2407 — the `actor/agent` DID and its `serviceOf` relation (RFC-31 Phase 1).
 *
 * Two jobs. First: the binding view returns exactly the active, non-suspended
 * `actor/agent` DIDs a principal has bound, and refuses every row that merely
 * looks like one. Second — the part that matters most — the AUTHORITY tests:
 * the `agent` subtype, and being listed in `serviceOf`, confer no capability.
 * `resolveAgentAuthority` (the one place delegation is decided) must answer
 * exactly as it did before this feature, whatever the subtype says.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Row } from './fake-drizzle';

const { stores, MEMBERS, IDENTITIES, GRANTS, mockConnectionStates } = vi.hoisted(() => ({
  stores: { members: [] as Row[], identities: [] as Row[], grants: [] as Row[] },
  MEMBERS: {} as Record<string, string>,
  IDENTITIES: {} as Record<string, string>,
  GRANTS: {} as Record<string, string>,
  mockConnectionStates: vi.fn(),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const fake = await import('./fake-drizzle');
  return { ...actual, eq: fake.fakeEq, and: fake.fakeAnd, isNull: fake.fakeIsNull, asc: fake.fakeAsc, gt: fake.fakeGt };
});

vi.mock('@/src/db', async () => {
  const { createFakeDb: make, defineTable: define } = await import('./fake-drizzle');
  Object.assign(MEMBERS, define('members', ['identityDid', 'memberDid', 'role', 'removedAt', 'addedAt']));
  Object.assign(IDENTITIES, define('identities', ['id', 'scope', 'subtype', 'handle', 'name', 'suspendedAt']));
  Object.assign(GRANTS, define('grants', ['id', 'agentDid', 'delegatorDid', 'status', 'expiresAt']));
  return { db: make(stores), identityMembers: MEMBERS, identities: IDENTITIES, delegationGrants: GRANTS };
});

vi.mock('../did-connections', () => ({ getDidConnectionStates: mockConnectionStates }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { listServingAgents, listServiceOf, resolveServingAgents } from '../agent-service';
import { resolveAgentAuthority } from '../agent-authority';

const RYAN = 'did:imajin:ryan';
const MOOI = 'did:imajin:mooi-community';
const JIN = 'did:imajin:jin';
const TRAVEL = 'did:imajin:jin-travel';
const HUMAN = 'did:imajin:a-human';
const STRANGER = 'did:imajin:self-registered-agent';

function identity(id: string, overrides: Row = {}): Row {
  return { id, scope: 'actor', subtype: 'agent', handle: null, name: null, suspendedAt: null, ...overrides };
}

function bind(principal: string, agent: string, overrides: Row = {}): Row {
  return { identityDid: principal, memberDid: agent, role: 'agent', removedAt: null, addedAt: new Date('2026-09-01T00:00:00Z'), ...overrides };
}

beforeEach(() => {
  stores.members.length = 0;
  stores.identities.length = 0;
  stores.grants.length = 0;
  mockConnectionStates.mockReset();
  delete process.env.AGENT_AUTHORITY_MODE;
});

afterEach(() => {
  delete process.env.AGENT_AUTHORITY_MODE;
});

describe('listServingAgents', () => {
  it("returns the principal's actor/agent DIDs with handle, name and binding time", async () => {
    stores.identities.push(identity(JIN, { handle: 'veteze-jin', name: 'Jin' }));
    stores.members.push(bind(RYAN, JIN));

    await expect(listServingAgents(RYAN)).resolves.toEqual([
      { did: JIN, handle: 'veteze-jin', name: 'Jin', servingSince: '2026-09-01T00:00:00.000Z' },
    ]);
  });

  it('supports many agents per principal, oldest binding first', async () => {
    stores.identities.push(identity(JIN), identity(TRAVEL));
    stores.members.push(
      bind(RYAN, TRAVEL, { addedAt: new Date('2026-09-20T00:00:00Z') }),
      bind(RYAN, JIN, { addedAt: new Date('2026-09-01T00:00:00Z') }),
    );

    const agents = await listServingAgents(RYAN);
    expect(agents.map((a) => a.did)).toEqual([JIN, TRAVEL]);
  });

  it("does not list another principal's agents", async () => {
    stores.identities.push(identity(JIN), identity(TRAVEL));
    stores.members.push(bind(RYAN, JIN), bind(MOOI, TRAVEL));

    expect((await listServingAgents(RYAN)).map((a) => a.did)).toEqual([JIN]);
    expect((await listServingAgents(MOOI)).map((a) => a.did)).toEqual([TRAVEL]);
  });

  it('excludes a removed binding', async () => {
    stores.identities.push(identity(JIN));
    stores.members.push(bind(RYAN, JIN, { removedAt: new Date() }));

    await expect(listServingAgents(RYAN)).resolves.toEqual([]);
  });

  it("excludes rows whose role is not 'agent' (an owner/member row is not a serviceOf binding)", async () => {
    stores.identities.push(identity(JIN));
    stores.members.push(bind(RYAN, JIN, { role: 'owner' }), bind(RYAN, JIN, { role: 'member' }));

    await expect(listServingAgents(RYAN)).resolves.toEqual([]);
  });

  it("excludes a role='agent' row whose member is NOT an actor/agent (the row alone does not make an agent)", async () => {
    stores.identities.push(
      identity(HUMAN, { subtype: 'human' }),
      identity('did:imajin:biz', { scope: 'business', subtype: 'agent' }),
      identity('did:imajin:untyped', { subtype: null }),
    );
    stores.members.push(bind(RYAN, HUMAN), bind(RYAN, 'did:imajin:biz'), bind(RYAN, 'did:imajin:untyped'));

    await expect(listServingAgents(RYAN)).resolves.toEqual([]);
  });

  it('excludes a suspended agent', async () => {
    stores.identities.push(identity(JIN, { suspendedAt: new Date() }));
    stores.members.push(bind(RYAN, JIN));

    await expect(listServingAgents(RYAN)).resolves.toEqual([]);
  });

  it('collapses duplicate membership rows and never lists a DID as its own agent', async () => {
    stores.identities.push(identity(JIN), identity(RYAN));
    stores.members.push(bind(RYAN, JIN), bind(RYAN, JIN), bind(RYAN, RYAN));

    expect((await listServingAgents(RYAN)).map((a) => a.did)).toEqual([JIN]);
  });

  it('reports servingSince as null when the row carries no timestamp', async () => {
    stores.identities.push(identity(JIN));
    stores.members.push(bind(RYAN, JIN, { addedAt: null }));

    const [agent] = await listServingAgents(RYAN);
    expect(agent.servingSince).toBeNull();
  });
});

describe('listServiceOf', () => {
  it('resolves an actor/agent to every principal it serves (one agent, many principals)', async () => {
    stores.identities.push(identity(JIN));
    stores.members.push(bind(RYAN, JIN), bind(MOOI, JIN));

    expect((await listServiceOf(JIN)).sort()).toEqual([MOOI, RYAN].sort());
  });

  it('is empty for a DID that is not an actor/agent, whatever rows name it', async () => {
    stores.identities.push(identity(HUMAN, { subtype: 'human' }));
    stores.members.push(bind(RYAN, HUMAN));

    await expect(listServiceOf(HUMAN)).resolves.toEqual([]);
  });

  it('is empty for an unknown DID and for an agent nobody has bound', async () => {
    stores.identities.push(identity(STRANGER));

    await expect(listServiceOf('did:imajin:nobody')).resolves.toEqual([]);
    await expect(listServiceOf(STRANGER)).resolves.toEqual([]);
  });

  it('drops removed bindings, suspended agents, non-agent roles and self-binding', async () => {
    stores.identities.push(identity(JIN), identity(TRAVEL, { suspendedAt: new Date() }));
    stores.members.push(
      bind(RYAN, JIN, { removedAt: new Date() }),
      bind(MOOI, JIN, { role: 'owner' }),
      bind(JIN, JIN),
      bind(RYAN, TRAVEL),
    );

    await expect(listServiceOf(JIN)).resolves.toEqual([]);
    await expect(listServiceOf(TRAVEL)).resolves.toEqual([]);
  });
});

describe('resolveServingAgents', () => {
  it("attaches each agent DID's own live connection state", async () => {
    stores.identities.push(identity(JIN), identity(TRAVEL));
    stores.members.push(bind(RYAN, JIN), bind(RYAN, TRAVEL, { addedAt: new Date('2026-09-20T00:00:00Z') }));
    mockConnectionStates.mockResolvedValue(new Map([[JIN, 'connected'], [TRAVEL, 'disconnected']]));

    const agents = await resolveServingAgents(RYAN);

    expect(mockConnectionStates).toHaveBeenCalledWith([JIN, TRAVEL]);
    expect(agents.map((a) => [a.did, a.scope, a.subtype, a.connection.state])).toEqual([
      [JIN, 'actor', 'agent', 'connected'],
      [TRAVEL, 'actor', 'agent', 'disconnected'],
    ]);
  });

  it("reports 'unknown' (never 'disconnected') when the connection check returned nothing for an agent", async () => {
    stores.identities.push(identity(JIN));
    stores.members.push(bind(RYAN, JIN));
    mockConnectionStates.mockResolvedValue(new Map());

    const [agent] = await resolveServingAgents(RYAN);
    expect(agent.connection.state).toBe('unknown');
  });

  it('returns an empty list for a principal with no agents', async () => {
    mockConnectionStates.mockResolvedValue(new Map());

    await expect(resolveServingAgents(RYAN)).resolves.toEqual([]);
  });
});

describe('authority: the actor/agent subtype and serviceOf grant nothing', () => {
  it('an actor/agent identity with no membership and no grant has no authority over anyone', async () => {
    stores.identities.push(identity(STRANGER));

    await expect(resolveAgentAuthority(STRANGER, RYAN)).resolves.toEqual({ allowed: false, via: 'none' });
    process.env.AGENT_AUTHORITY_MODE = 'membership-only';
    await expect(resolveAgentAuthority(STRANGER, RYAN)).resolves.toEqual({ allowed: false, via: 'none' });
  });

  it('a self-registered actor/agent serves no one and appears in no principal list', async () => {
    stores.identities.push(identity(STRANGER));

    await expect(listServiceOf(STRANGER)).resolves.toEqual([]);
    await expect(listServingAgents(RYAN)).resolves.toEqual([]);
    await expect(listServingAgents(STRANGER)).resolves.toEqual([]);
  });

  it('binding one principal does not extend authority to any other principal', async () => {
    stores.identities.push(identity(JIN));
    stores.members.push(bind(RYAN, JIN));

    await expect(resolveAgentAuthority(JIN, RYAN)).resolves.toMatchObject({ allowed: true, via: 'membership' });
    await expect(resolveAgentAuthority(JIN, MOOI)).resolves.toEqual({ allowed: false, via: 'none' });
  });

  it('a removed binding is gone from serviceOf AND from authority — the two agree', async () => {
    stores.identities.push(identity(JIN));
    stores.members.push(bind(RYAN, JIN, { removedAt: new Date() }));

    await expect(listServiceOf(JIN)).resolves.toEqual([]);
    await expect(resolveAgentAuthority(JIN, RYAN)).resolves.toEqual({ allowed: false, via: 'none' });
  });

  it('regression: authority never consults the subtype — a non-agent member row resolves exactly as before', async () => {
    stores.identities.push(identity(HUMAN, { subtype: 'human' }));
    stores.members.push(bind(RYAN, HUMAN));

    // Pre-#2407 behavior: the membership row is the authority, subtype irrelevant.
    await expect(resolveAgentAuthority(HUMAN, RYAN)).resolves.toMatchObject({ allowed: true, via: 'membership' });
    // ...while serviceOf refuses to call that DID an agent.
    await expect(listServiceOf(HUMAN)).resolves.toEqual([]);
  });

  it('regression: a grant-only agent (no membership row) is still authorized by its grant and is NOT in serviceOf', async () => {
    stores.identities.push(identity(JIN));
    stores.grants.push({
      id: 'grant_1',
      agentDid: JIN,
      delegatorDid: RYAN,
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(resolveAgentAuthority(JIN, RYAN)).resolves.toEqual({ allowed: true, via: 'grant', grantId: 'grant_1' });
    await expect(listServiceOf(JIN)).resolves.toEqual([]);
  });

  it('the read paths are strictly read-only (the fake db has no write methods, so any write would throw)', async () => {
    stores.identities.push(identity(JIN));
    stores.members.push(bind(RYAN, JIN));
    mockConnectionStates.mockResolvedValue(new Map([[JIN, 'connected']]));

    await expect(listServiceOf(JIN)).resolves.toEqual([RYAN]);
    await expect(resolveServingAgents(RYAN)).resolves.toHaveLength(1);
    expect(stores.members).toHaveLength(1);
    expect(stores.identities).toHaveLength(1);
  });
});
