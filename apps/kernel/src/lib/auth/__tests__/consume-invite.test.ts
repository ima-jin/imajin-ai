import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { invitesInConnections, connections } from '@/src/db/schemas/connections';

const mocks = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn(), publish: vi.fn(), conditions: [] as unknown[] }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/connections'),
  ...await import('@/src/db/schemas/profile'),
  db: { select: mocks.select, insert: mocks.insert, update: mocks.update },
}));

function selectResult(result: unknown[]) {
  return { then: (resolve: (rows: unknown) => void) => resolve(result), limit: async () => result };
}
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@/src/lib/kernel/verification', () => ({
  checkPreliminaryEligibility: async () => undefined, checkHardEligibility: async () => undefined,
}));

import { consumePendingInvites } from '../consume-invite';

const did = 'did:imajin:existing-hard-recipient';
const pending = ['direct', 'email', 'link'].map((delivery) => ({
  id: `inv_${delivery}`, code: `code_${delivery}`, delivery,
  fromDid: `did:imajin:sender-${delivery}`, toDid: did, toEmail: 'existing@example.com',
  fromHandle: null, usedCount: 0, maxUses: 1, status: 'pending', expiresAt: null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.conditions.length = 0;
  mocks.publish.mockResolvedValue(undefined);
  mocks.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: (condition: unknown) => {
        mocks.conditions.push(condition);
        // Deliberately return direct too, exercising the defensive loop guard
        // even if a future adapter/query refactor weakens the SQL predicate.
        const result = table === invitesInConnections ? pending : [];
        return selectResult(result);
      },
    }),
  }));
  mocks.insert.mockImplementation(() => ({
    values: () => ({ onConflictDoUpdate: async () => undefined }),
  }));
  mocks.update.mockReturnValue({ set: vi.fn(() => ({ where: async () => undefined })) });
});

describe('consumePendingInvites direct consent boundary', () => {
  it('excludes direct requests in SQL and defensively skips them while consuming legitimate email/link invitations', async () => {
    await consumePendingInvites({ did, email: 'Existing@Example.com', handle: 'existing' });
    const query = new PgDialect().sqlToQuery(mocks.conditions[0] as SQL);
    expect(query.sql).toContain('"delivery" <>');
    expect(query.params).toContain('direct');
    expect(mocks.insert.mock.calls.filter(([table]) => table === connections)).toHaveLength(2);
    const acceptedEvents = mocks.publish.mock.calls.filter(([type]) => type === 'connection.accepted');
    expect(acceptedEvents.map(([, event]) => event.payload.invite_code).sort()).toEqual(['code_email', 'code_link']);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.publish.mock.calls.some(([, event]) => event.payload.invite_code === 'code_direct')).toBe(false);
  });
});
