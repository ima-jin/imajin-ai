import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { IDENTITY_CATEGORIES } from '@imajin/config';

const { insert, profileValues, identityValues, profiles, identities } = vi.hoisted(() => ({
  insert: vi.fn(),
  profileValues: vi.fn(),
  identityValues: vi.fn(),
  profiles: { did: 'profile_did' },
  identities: { id: 'identity_id' },
}));

vi.mock('@/src/db', () => ({
  db: { insert },
  profiles,
  identities,
  storedKeys: {},
  identityMembers: {},
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ identity: { id: 'did:imajin:owner' } }),
  generateKeypair: () => ({ publicKey: 'test-public-key', privateKey: 'test-private-key' }),
}));
vi.mock('@/src/lib/auth/crypto', () => ({
  didFromPublicKey: () => 'did:imajin:business',
  encryptPrivateKey: async () => ({ encryptedKey: 'encrypted-test-key', salt: 'test-salt' }),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));

import { POST } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  profileValues.mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) });
  insert.mockImplementation(table => ({
    values: table === profiles ? profileValues : identityValues,
  }));
});

describe('organization category persistence', () => {
  it.each([...IDENTITY_CATEGORIES, 'legacy custom category'])(
    'persists %s in profile metadata without rewriting historical values',
    async (category) => {
      const response = await POST(new NextRequest('http://localhost/auth/api/groups', {
        method: 'POST',
        body: JSON.stringify({ scope: 'business', name: 'GBS Contracting', category }),
      }));

      expect(response.status).toBe(201);
      expect(profileValues).toHaveBeenCalledWith(expect.objectContaining({
        did: 'did:imajin:business',
        displayName: 'GBS Contracting',
        metadata: { category },
      }));
      expect(identityValues).toHaveBeenCalledWith(expect.objectContaining({
        id: 'did:imajin:business', scope: 'business',
      }));
    },
  );
});
