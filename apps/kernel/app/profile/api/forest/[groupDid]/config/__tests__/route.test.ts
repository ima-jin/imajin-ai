import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  registryWhere: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn(async () => ({ identity: { id: 'did:caller' } })),
}));
vi.mock('@/src/db', () => ({
  forestConfig: { groupDid: 'groupDid' },
  identityMembers: { role: 'role', identityDid: 'identityDid', memberDid: 'memberDid', removedAt: 'removedAt' },
  registryApps: { slug: 'slug', status: 'status' },
  db: {
    select: () => ({
      from: (table: { slug?: string }) => ({
        where: table.slug
          ? mocks.registryWhere
          : () => ({ limit: async () => [{ role: 'owner' }] }),
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: mocks.upsert }) }),
  },
}));

import { PATCH } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registryWhere.mockResolvedValue([{ slug: 'registry-only' }]);
});

async function patch(body: unknown) {
  return PATCH(new NextRequest('https://node.test/profile/api/forest/did:group/config', {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }), { params: Promise.resolve({ groupDid: 'did:group' }) });
}

describe('forest config service validation', () => {
  it('accepts an active registry-only app alongside an allowed kernel service', async () => {
    expect((await patch({ enabledServices: ['registry-only', 'chat'], landingService: 'registry-only' })).status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledOnce();
  });

  it('rejects unknown/deleted apps, internal services, and static-only app hints', async () => {
    for (const name of ['coffee', 'not-registered', 'vault', 'learn']) {
      const response = await patch({ enabledServices: [name] });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('Unknown services');
    }
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('requires the landing app to be enabled', async () => {
    expect((await patch({ enabledServices: ['registry-only'], landingService: 'chat' })).status).toBe(400);
  });

  it('still accepts non-service config updates without changing the enabled set', async () => {
    expect((await patch({ joinVisibility: 'invite' })).status).toBe(200);
    expect(mocks.registryWhere).not.toHaveBeenCalled();
  });
});
