import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), limit: vi.fn(), where: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('drizzle-orm', () => ({
  eq: (column: string, value: string) => ({ eq: [column, value] }),
  isNull: (column: string) => ({ isNull: column }),
  and: (...conditions: unknown[]) => conditions,
}));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: mocks.where }) }) },
  identities: { id: 'id', scope: 'scope', subtype: 'subtype', suspendedAt: 'suspendedAt' },
  identityMembers: { identityDid: 'identityDid', memberDid: 'memberDid', removedAt: 'removedAt', role: 'role' },
}));

import { canManageIdentityDomains, requireDomainManager } from '../access';

const owner = 'did:imajin:owner';
const group = 'did:imajin:group';
const request = new Request('https://example.test');
const mutation = { action: 'add-domain', class: 'value-moving' as const };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.where.mockReturnValue({ limit: mocks.limit });
  mocks.auth.mockResolvedValue({ identity: { id: owner, scope: 'actor', subtype: 'human' } });
});

describe('persisted domain management authority', () => {
  it('allows an individual to manage their own active identity', async () => {
    mocks.limit.mockResolvedValue([{ scope: 'actor', subtype: 'human' }]);
    expect(await canManageIdentityDomains(owner, owner)).toBe(true);
    expect(mocks.where).toHaveBeenCalledWith([{ eq: ['id', owner] }, { isNull: 'suspendedAt' }]);
  });

  it('does not let membership on a personal identity elevate another caller', async () => {
    mocks.limit.mockResolvedValue([{ scope: 'actor' }]);
    expect(await canManageIdentityDomains(owner, 'did:imajin:stranger')).toBe(false);
    expect(mocks.limit).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'admin'])('accepts a persisted active %s membership', async (role) => {
    mocks.limit.mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([{ role }]);
    expect(await canManageIdentityDomains(group, owner)).toBe(true);
    expect(mocks.where).toHaveBeenLastCalledWith([
      { eq: ['identityDid', group] }, { eq: ['memberDid', owner] }, { isNull: 'removedAt' },
    ]);
  });

  it.each(['member', 'maintainer', 'agent', null])('rejects non-owner/admin role %s', async (role) => {
    mocks.limit.mockResolvedValueOnce([{ scope: 'community' }])
      .mockResolvedValueOnce(role ? [{ role }] : []);
    expect(await canManageIdentityDomains(group, owner)).toBe(false);
  });

  it.each([{ rows: [] }, { rows: [{ scope: 'actor', subtype: 'agent' }] }])('rejects absent/suspended or agent targets', async ({ rows }) => {
    mocks.limit.mockResolvedValue(rows);
    expect(await canManageIdentityDomains(owner, owner)).toBe(false);
  });
});

describe('domain API authentication and delegation', () => {
  it('returns canonical authentication failures without database reads', async () => {
    mocks.auth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
    const response = await requireDomainManager(request, owner) as Response;
    expect(response.status).toBe(401);
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it('uses auth service restrictions and permits an authenticated owner', async () => {
    mocks.limit.mockResolvedValueOnce([{ subtype: 'human' }]).mockResolvedValueOnce([{ scope: 'actor' }]);
    expect(await requireDomainManager(request, owner, mutation)).toMatchObject({ id: owner });
    expect(mocks.auth).toHaveBeenCalledWith(request, { service: 'auth' });
  });

  it('does not trust actingAsRole when the actual membership was removed', async () => {
    mocks.auth.mockResolvedValue({ identity: { id: owner, actingAs: group, actingAsRole: 'owner' } });
    mocks.limit.mockResolvedValueOnce([{ subtype: 'human' }])
      .mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([]);
    const response = await requireDomainManager(request, group, mutation) as Response;
    expect(response.status).toBe(403);
  });

  it('allows an acting-as admin only after checking the original caller membership', async () => {
    mocks.auth.mockResolvedValue({ identity: { id: owner, actingAs: group, actingAsRole: 'admin' } });
    mocks.limit.mockResolvedValueOnce([{ subtype: 'human' }])
      .mockResolvedValueOnce([{ scope: 'business' }]).mockResolvedValueOnce([{ role: 'admin' }]);
    expect(await requireDomainManager(request, group, mutation)).toMatchObject({ id: owner });
    expect(mocks.where).toHaveBeenLastCalledWith([
      { eq: ['identityDid', group] }, { eq: ['memberDid', owner] }, { isNull: 'removedAt' },
    ]);
  });

  it.each(['value-moving', 'irreversible'] as const)('blocks delegated %s via shared #2360 policy', async (classification) => {
    mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingFor: owner } });
    const response = await requireDomainManager(request, owner, { ...mutation, class: classification }) as Response;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', ownerDid: owner });
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it('does not promote an acting-for delegate to the owner on private reads', async () => {
    mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:agent', actingFor: owner } });
    mocks.limit.mockResolvedValue([{ subtype: 'agent' }]);
    expect((await requireDomainManager(request, owner) as Response).status).toBe(403);
  });

  it.each([{ actingAs: group }, { actingFor: group }])('rejects a conflicting identity overlay', async (overlay) => {
    mocks.auth.mockResolvedValue({ identity: { id: owner, ...overlay } });
    expect((await requireDomainManager(request, owner) as Response).status).toBe(403);
  });

  it.each([{ rows: [] }, { rows: [{ subtype: 'agent' }] }])('rejects suspended/missing callers and agent self-mutations', async ({ rows }) => {
    mocks.limit.mockResolvedValue(rows);
    expect((await requireDomainManager(request, owner, mutation) as Response).status).toBe(403);
  });
});
