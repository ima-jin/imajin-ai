import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ limit: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }) },
  identities: {}, identityMembers: {}, attestations: {}, registryApps: {},
}));
vi.mock('@/src/lib/auth/agent-service', () => ({ listServiceOf: vi.fn() }));
vi.mock('@/src/lib/kernel/connection-principal', () => ({ resolveConnectionPrincipal: vi.fn() }));

import { mcpOAuthContext } from '../agent-binding';

const payload = {
  sub: 'did:imajin:caller', azp: 'did:imajin:app', scope: 'warp:read', attestationId: 'legacy',
};

beforeEach(() => vi.resetAllMocks());

describe('unbound MCP OAuth human authority', () => {
  it.each(['agent', 'presence'])('rejects an unbound %s token identically', async (subtype) => {
    mocks.limit.mockResolvedValue([{ id: payload.sub, scope: 'actor', subtype }]);
    await expect(mcpOAuthContext(payload)).rejects.toMatchObject({
      code: 'agent_authorization_required', status: 403,
    });
  });

  it('keeps legacy human OAuth bound to its own DID and app scopes', async () => {
    mocks.limit.mockResolvedValue([{ id: payload.sub, scope: 'actor', subtype: 'human' }]);
    expect(await mcpOAuthContext(payload)).toEqual({
      did: payload.sub, appDid: payload.azp, scopes: new Set(['warp:read']),
    });
  });
});
