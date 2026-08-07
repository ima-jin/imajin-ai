/**
 * Tests for GET /auth/api/groups/[groupDid] (#1680).
 *
 * The Members tab used to render bare `did:imajin:88kPYWwv5YFrQwAte…` strings
 * because the endpoint returned nothing but DIDs. Resolution happens here
 * rather than in the client so the tab does not fan out one lookup request per
 * row, which means the shape of `controllers[]` — and its behaviour when a DID
 * has no identity row — is part of the contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockSelect, mockRequireAuth } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockRequireAuth: vi.fn(),
}));

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  identities: { id: 'id', name: 'name', handle: 'handle', avatarUrl: 'avatar_url', scope: 'scope', subtype: 'subtype', createdAt: 'created_at' },
  identityMembers: {
    identityDid: 'identity_did',
    memberDid: 'member_did',
    role: 'role',
    addedBy: 'added_by',
    addedVia: 'added_via',
    addedAt: 'added_at',
    allowedServices: 'allowed_services',
    removedAt: 'removed_at',
  },
  profiles: { did: 'did' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (col: unknown) => ({ isNull: col }),
  inArray: (col: unknown, values: unknown[]) => ({ inArray: [col, values] }),
}));

vi.mock('@imajin/auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// ─── Subject ─────────────────────────────────────────────────────────────────

import { GET } from '../route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GROUP = 'did:imajin:artifact';
const RYAN = 'did:imajin:88kPYWwv5YFrQwAteXXXXXXXXXXXXXXXXX';
const JIN = 'did:imajin:jin';
const ADDED_AT = new Date('2026-08-07T12:00:00.000Z');

interface MemberRow {
  controllerDid: string;
  role: string;
  addedBy: string | null;
  addedVia: string | null;
  addedAt: Date;
  allowedServices: string[] | null;
}

interface IdentityRow {
  did: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  scope: string | null;
  subtype: string | null;
}

/** Rows the route reads, in the order it issues its queries. */
let members: MemberRow[] = [];
let directory: IdentityRow[] = [];

function member(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    controllerDid: RYAN,
    role: 'owner',
    addedBy: RYAN,
    addedVia: 'direct',
    addedAt: ADDED_AT,
    allowedServices: null,
    ...overrides,
  };
}

function identity(overrides: Partial<IdentityRow> = {}): IdentityRow {
  return {
    did: RYAN,
    name: 'Ryan Veteze',
    handle: 'veteze',
    avatarUrl: null,
    scope: 'actor',
    subtype: 'human',
    ...overrides,
  };
}

type RouteRequest = Parameters<typeof GET>[0];

interface ControllerResponse {
  controllerDid: string;
  role: string;
  addedVia: string | null;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
  subtype: string | null;
  addedByName: string | null;
  addedByHandle: string | null;
}

async function fetchControllers(): Promise<ControllerResponse[]> {
  const request = new Request(`http://localhost:3000/auth/api/groups/${encodeURIComponent(GROUP)}`) as unknown as RouteRequest;
  const res = (await GET(request, { params: Promise.resolve({ groupDid: GROUP }) })) as unknown as Response;
  expect(res.status).toBe(200);
  return ((await res.json()) as { controllers: ControllerResponse[] }).controllers;
}

/** One `.limit()`-terminated query stage. */
function limited(rows: unknown[]) {
  return { limit: () => Promise.resolve(rows) };
}

/**
 * The route's queries, in the order it issues them: caller membership, owner
 * row, group, members, then the identity directory (the only one that is not
 * `.limit()`-terminated).
 */
function stage(index: number): unknown {
  if (index === 0) return limited([{ role: 'owner' }]);
  if (index === 1) return limited([{ controllerDid: RYAN, addedAt: ADDED_AT }]);
  if (index === 2) {
    return limited([
      { groupDid: GROUP, scope: 'business', createdAt: ADDED_AT, name: 'Artifact', handle: 'artifact' },
    ]);
  }
  if (index === 3) return Promise.resolve(members);
  return Promise.resolve(directory);
}

beforeEach(() => {
  vi.clearAllMocks();
  members = [member()];
  directory = [identity()];
  mockRequireAuth.mockResolvedValue({ identity: { id: RYAN, scope: 'actor' } });

  let call = 0;
  mockSelect.mockImplementation(() => ({ from: () => ({ where: stage.bind(null, call++) }) }));
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET group — member name resolution', () => {
  it('returns the resolved name, handle and avatar for each member', async () => {
    directory = [identity({ avatarUrl: 'https://cdn.example/ryan.png' })];

    const [ctrl] = await fetchControllers();

    expect(ctrl).toMatchObject({
      controllerDid: RYAN,
      name: 'Ryan Veteze',
      handle: 'veteze',
      avatarUrl: 'https://cdn.example/ryan.png',
    });
  });

  it('returns nulls rather than omitting a member with no identity row', async () => {
    // A soft/stub DID can hold a membership before an identity exists for it;
    // dropping the row would silently hide a controller from the tab.
    directory = [];

    const [ctrl] = await fetchControllers();

    expect(ctrl).toMatchObject({ controllerDid: RYAN, name: null, handle: null });
  });

  it('surfaces the member subtype so an agent can be shown as one', async () => {
    members = [member({ controllerDid: JIN, role: 'agent', addedBy: RYAN })];
    directory = [identity(), identity({ did: JIN, name: 'Jin', handle: 'jin', subtype: 'agent' })];

    const [ctrl] = await fetchControllers();

    expect(ctrl).toMatchObject({ role: 'agent', subtype: 'agent' });
  });
});

describe('GET group — provenance', () => {
  it('resolves added_by to a name and handle', async () => {
    members = [member({ controllerDid: JIN, role: 'member', addedBy: RYAN })];
    directory = [identity(), identity({ did: JIN, name: 'Jin', handle: 'jin' })];

    const [ctrl] = await fetchControllers();

    expect(ctrl).toMatchObject({ addedByName: 'Ryan Veteze', addedByHandle: 'veteze' });
  });

  it('passes through a known added_via value', async () => {
    members = [member({ addedVia: 'invite' })];

    const [ctrl] = await fetchControllers();

    expect(ctrl.addedVia).toBe('invite');
  });

  it('nulls an unrecognised added_via rather than passing it to the client', async () => {
    // The column is free-form TEXT; the tab can only explain the values it knows.
    members = [member({ addedVia: 'teleportation' })];

    const [ctrl] = await fetchControllers();

    expect(ctrl.addedVia).toBeNull();
  });

  it('nulls added_via for rows written before the column existed', async () => {
    members = [member({ addedVia: null })];

    const [ctrl] = await fetchControllers();

    expect(ctrl.addedVia).toBeNull();
  });

  it('leaves the adder unresolved when added_by is null', async () => {
    members = [member({ addedBy: null, addedVia: null })];

    const [ctrl] = await fetchControllers();

    expect(ctrl).toMatchObject({ addedByName: null, addedByHandle: null });
  });
});
