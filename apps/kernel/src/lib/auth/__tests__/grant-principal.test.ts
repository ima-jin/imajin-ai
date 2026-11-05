import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));

import { requireGrantPrincipal } from '../grant-principal';

const request = new Request('https://example.test');
const contexts = [
  {},
  { actingAs: 'did:imajin:org', actingAsRole: 'owner' },
  { actingAs: 'did:imajin:org', actingAsRole: 'admin' },
];

beforeEach(() => vi.resetAllMocks());

describe('grant principal human authority', () => {
  it.each(contexts)('rejects agents and presences in context %j', async (context) => {
    for (const subtype of ['agent', 'presence']) {
      mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:caller', subtype, ...context } });
      expect(await requireGrantPrincipal(request)).toEqual({
        error: 'Grants must be managed by the delegator principal directly, not while acting under agent delegation',
        status: 403,
      });
    }
  });

  it.each(contexts)('preserves a human principal in context %j', async (context) => {
    const auth = { identity: { id: 'did:imajin:human', subtype: 'human', ...context } };
    mocks.auth.mockResolvedValue(auth);
    expect(await requireGrantPrincipal(request)).toBe(auth);
    expect(mocks.auth).toHaveBeenCalledWith(request, { service: 'auth' });
  });

  it.each([
    { actingFor: 'did:imajin:principal' },
    { actingAsRole: 'agent' },
    { actingAs: 'did:imajin:org', actingAsRole: 'member' },
    { actingAs: 'did:imajin:org' },
  ])('retains existing delegation and org-role denials %j', async (context) => {
    mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:human', subtype: 'human', ...context } });
    expect(await requireGrantPrincipal(request)).toMatchObject({ status: 403 });
  });

  it('returns the canonical authentication error', async () => {
    const error = { error: 'Not authenticated', status: 401 };
    mocks.auth.mockResolvedValue(error);
    expect(await requireGrantPrincipal(request)).toBe(error);
  });
});
