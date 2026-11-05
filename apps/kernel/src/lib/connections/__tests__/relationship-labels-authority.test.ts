import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lock: vi.fn(), prepare: vi.fn() }));
vi.mock('@/src/db', () => {
  const tx = { select: () => ({ from: () => ({ where: () => ({ for: mocks.lock }) }) }) };
  return {
    db: { transaction: (callback: (value: typeof tx) => unknown) => callback(tx) },
    identities: {}, identityMembers: {}, connections: {}, attestations: {},
  };
});
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: mocks.prepare }));

import { canManageRelationshipLabels, setRelationshipLabel } from '../relationship-labels';

const org = 'did:imajin:org';
const human = 'did:imajin:human';
const contexts = [{ id: human }, { id: human, actingAs: org }];

beforeEach(() => vi.resetAllMocks());

function controller(subtype: string) {
  mocks.lock.mockReset()
    .mockResolvedValueOnce([{ scope: 'business', suspendedAt: null }])
    .mockResolvedValueOnce([{ scope: 'actor', subtype, suspendedAt: null }])
    .mockResolvedValueOnce([{ role: 'admin', allowedServices: null }]);
}

describe('relationship label human controller authority', () => {
  it.each(contexts)('rejects agents and presences even with admin membership in context %j', async (actor) => {
    for (const subtype of ['agent', 'presence']) {
      controller(subtype);
      expect(await canManageRelationshipLabels(org, actor)).toBe(false);
      expect(mocks.lock).toHaveBeenCalledTimes(2);
      controller(subtype);
      await expect(setRelationshipLabel(org, 'did:imajin:counterparty', actor, 'client'))
        .rejects.toMatchObject({ status: 403 });
      expect(mocks.prepare).not.toHaveBeenCalled();
    }
  });

  it.each(contexts)('allows the persisted human admin in context %j', async (actor) => {
    controller('human');
    expect(await canManageRelationshipLabels(org, actor)).toBe(true);
    expect(mocks.lock).toHaveBeenCalledTimes(3);
  });
});
