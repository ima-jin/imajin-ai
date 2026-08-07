/**
 * Tests for POST /auth/api/groups/[groupDid]/controllers (#1680).
 *
 * Two things this route decides are load-bearing outside the Members tab:
 *
 *  - `agent` is the role the X-Acting-For delegation path checks for. Until it
 *    was accepted here the only way to create one was a direct DB insert, so
 *    the accepted-role list is asserted explicitly rather than left implicit.
 *  - `allowed_services` narrows what a delegated agent may touch. It is only
 *    consulted for agents, so storing it against a human member would record a
 *    restriction nothing enforces — the normalisation is pinned below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockSelect, mockInsert, mockUpdate, insertedValues, updatedValues, mockRequireAuth, mockPublish } =
  vi.hoisted(() => {
    const insertedValues: Record<string, unknown>[] = [];
    const updatedValues: Record<string, unknown>[] = [];
    return {
      mockSelect: vi.fn(),
      mockInsert: vi.fn(),
      mockUpdate: vi.fn(),
      insertedValues,
      updatedValues,
      mockRequireAuth: vi.fn(),
      mockPublish: vi.fn(),
    };
  });

vi.mock('@/src/db', () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
  identityMembers: {
    identityDid: 'identity_did',
    memberDid: 'member_did',
    role: 'role',
    removedAt: 'removed_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('@imajin/bus', () => ({ publish: mockPublish }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { POST } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GROUP = 'did:imajin:artifact';
const OWNER = 'did:imajin:ryan';
const NEW_MEMBER = 'did:imajin:jin';
const ENDPOINT = `http://localhost:3000/auth/api/groups/${encodeURIComponent(GROUP)}/controllers`;

/** Membership rows the mocked select returns, in call order. */
let selectResults: Record<string, unknown>[][] = [];

type RouteRequest = Parameters<typeof POST>[0];

function post(body: unknown): Promise<Response> {
  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as RouteRequest;
  return POST(request, { params: Promise.resolve({ groupDid: GROUP }) }) as unknown as Promise<Response>;
}

/** Add `NEW_MEMBER` with the given role and read back the row written. */
async function add(body: Record<string, unknown>) {
  const res = await post({ did: NEW_MEMBER, ...body });
  return { res, row: insertedValues.at(-1) };
}

/** The next queued query result, as a `.limit()`-terminated stage. */
function limited() {
  return { limit: () => Promise.resolve(selectResults.shift() ?? []) };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
  updatedValues.length = 0;

  // Caller is the owner; the target has no prior membership row.
  selectResults = [[{ role: 'owner' }], []];
  mockSelect.mockImplementation(() => ({ from: () => ({ where: () => limited() }) }));
  mockInsert.mockImplementation(() => ({
    values: (values: Record<string, unknown>) => {
      insertedValues.push(values);
      return Promise.resolve();
    },
  }));
  mockUpdate.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => {
      updatedValues.push(values);
      return { where: () => Promise.resolve() };
    },
  }));

  mockRequireAuth.mockResolvedValue({ identity: { id: OWNER, scope: 'actor' } });
  mockPublish.mockResolvedValue(undefined);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST controllers — role vocabulary', () => {
  it.each(['admin', 'maintainer', 'member', 'agent'])('accepts role=%s', async (role) => {
    const { res, row } = await add({ role });

    expect(res.status).toBe(201);
    expect(row).toMatchObject({ memberDid: NEW_MEMBER, role });
  });

  it('accepts agent — the role the X-Acting-For delegation check requires', async () => {
    const { res } = await add({ role: 'agent' });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ role: 'agent' });
  });

  it('rejects an unknown role', async () => {
    const res = await post({ did: NEW_MEMBER, role: 'superuser' });

    expect(res.status).toBe(400);
    expect(insertedValues).toHaveLength(0);
  });

  it('rejects owner — ownership is not granted from this endpoint', async () => {
    const res = await post({ did: NEW_MEMBER, role: 'owner' });

    expect(res.status).toBe(400);
    expect(insertedValues).toHaveLength(0);
  });

  it('lets only the owner add an admin', async () => {
    selectResults = [[{ role: 'admin' }], []];

    const res = await post({ did: NEW_MEMBER, role: 'admin' });

    expect(res.status).toBe(403);
    expect(insertedValues).toHaveLength(0);
  });
});

describe('POST controllers — service scoping', () => {
  it('stores allowed_services for an agent', async () => {
    const { row } = await add({ role: 'agent', allowedServices: ['media', 'chat'] });

    expect(row).toMatchObject({ allowedServices: ['media', 'chat'] });
  });

  it('stores null for an agent with an empty selection — no list means full access', async () => {
    const { row } = await add({ role: 'agent', allowedServices: [] });

    expect(row).toMatchObject({ allowedServices: null });
  });

  it.each(['admin', 'maintainer', 'member'])(
    'ignores allowed_services for role=%s — only the agent path enforces it',
    async (role) => {
      const { row } = await add({ role, allowedServices: ['media'] });

      expect(row).toMatchObject({ role, allowedServices: null });
    },
  );
});

describe('POST controllers — provenance', () => {
  it('records added_via=direct for a controller adding through the UI', async () => {
    const { row } = await add({ role: 'member' });

    expect(row).toMatchObject({ addedBy: OWNER, addedVia: 'direct' });
  });

  it('records added_via=agent when the caller is acting for the group', async () => {
    mockRequireAuth.mockResolvedValue({ identity: { id: OWNER, scope: 'actor', actingFor: GROUP } });

    const { row } = await add({ role: 'member' });

    expect(row).toMatchObject({ addedVia: 'agent' });
  });

  it('re-stamps provenance when reactivating a previously removed member', async () => {
    selectResults = [
      [{ role: 'owner' }],
      [{ removedAt: new Date('2026-01-01T00:00:00.000Z'), role: 'member' }],
    ];

    const res = await post({ did: NEW_MEMBER, role: 'agent', allowedServices: ['pay'] });

    expect(res.status).toBe(201);
    expect(insertedValues).toHaveLength(0);
    expect(updatedValues.at(-1)).toMatchObject({
      removedAt: null,
      role: 'agent',
      allowedServices: ['pay'],
      addedBy: OWNER,
      addedVia: 'direct',
    });
  });

  it('publishes the provenance alongside the role', async () => {
    await add({ role: 'agent' });

    expect(mockPublish).toHaveBeenCalledWith(
      'group.controller.added',
      expect.objectContaining({
        payload: expect.objectContaining({ role: 'agent', added_via: 'direct' }),
      }),
    );
  });
});
