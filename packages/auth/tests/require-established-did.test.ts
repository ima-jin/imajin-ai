/**
 * Tests for `requireEstablishedDID` (#325) — only established-or-higher tiers
 * pass; missing or unknown tiers fail closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ requireAuthMock: vi.fn() }));
vi.mock('../src/require-auth', () => ({ requireAuth: mocks.requireAuthMock }));

import { requireEstablishedDID } from '../src/require-established-did';

const request = new Request('https://auth.kernel.test/api/thing');

function authResultWith(tier: unknown) {
  const identity: Record<string, unknown> = { id: 'did:imajin:user' };
  if (tier !== undefined) identity.tier = tier;
  return { identity };
}

const FORBIDDEN = { error: 'This action requires an established identity', status: 403 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireEstablishedDID', () => {
  it.each(['established', 'steward', 'operator'])('accepts the %s tier', async (tier) => {
    const auth = authResultWith(tier);
    mocks.requireAuthMock.mockResolvedValue(auth);
    expect(await requireEstablishedDID(request)).toBe(auth);
  });

  it.each(['soft', 'preliminary'])('rejects the %s tier', async (tier) => {
    mocks.requireAuthMock.mockResolvedValue(authResultWith(tier));
    expect(await requireEstablishedDID(request)).toEqual(FORBIDDEN);
  });

  it('rejects a missing tier (fail closed)', async () => {
    mocks.requireAuthMock.mockResolvedValue(authResultWith(undefined));
    expect(await requireEstablishedDID(request)).toEqual(FORBIDDEN);
  });

  it.each([null, '', 'hard', 'superuser', 'ESTABLISHED', 42])(
    'rejects an unknown tier value (%s)',
    async (tier) => {
      mocks.requireAuthMock.mockResolvedValue(authResultWith(tier));
      expect(await requireEstablishedDID(request)).toEqual(FORBIDDEN);
    }
  );

  it('passes through requireAuth errors unchanged', async () => {
    const error = { error: 'Unauthorized', status: 401 };
    mocks.requireAuthMock.mockResolvedValue(error);
    expect(await requireEstablishedDID(request)).toBe(error);
  });
});
