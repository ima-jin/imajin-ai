/**
 * Unit tests for `findPendingAppsProvisionProposal` (#2375) — the
 * `operator.approvals` lookup `POST /api/apps/provision` uses to reuse an
 * already-pending proposal for a slug instead of raising a duplicate card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { whereMock, limitMock } = vi.hoisted(() => ({
  whereMock: vi.fn(),
  limitMock: vi.fn(),
}));

// drizzle-orm is an ESM package; mock the query-builder helpers this module
// uses so the query shape can be asserted without a real database.
vi.mock('drizzle-orm', () => ({
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', raw: strings.join('?'), values }),
    { mapWith: (fn: unknown) => fn },
  ),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: whereMock }) }),
  },
  operatorApprovals: {
    source: 'source', kind: 'kind', status: 'status', detail: 'detail',
  },
}));

vi.mock('../approvals-execution', () => ({
  APPS_SOURCE: 'apps',
  APPS_PROVISION_KIND: 'apps:provision',
}));

import { findPendingAppsProvisionProposal } from '../provision-proposals';

beforeEach(() => {
  vi.clearAllMocks();
  whereMock.mockReturnValue({ limit: limitMock });
});

describe('findPendingAppsProvisionProposal', () => {
  it('queries operator.approvals for a pending apps:provision proposal scoped to the slug, and returns the match', async () => {
    const row = { proposalId: 'appprov_1', source: 'apps', kind: 'apps:provision', status: 'pending' };
    limitMock.mockResolvedValue([row]);

    const result = await findPendingAppsProvisionProposal('dykil');

    expect(result).toBe(row);
    expect(limitMock).toHaveBeenCalledWith(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
    const [condition] = whereMock.mock.calls[0] as [{ op: string; conds: unknown[] }];
    expect(condition.op).toBe('and');
    expect(condition.conds).toEqual([
      { op: 'eq', col: 'source', val: 'apps' },
      { op: 'eq', col: 'kind', val: 'apps:provision' },
      { op: 'eq', col: 'status', val: 'pending' },
      { op: 'sql', raw: "?->>'slug' = ?", values: ['detail', 'dykil'] },
    ]);
  });

  it('returns undefined when no pending proposal exists for the slug', async () => {
    limitMock.mockResolvedValue([]);

    const result = await findPendingAppsProvisionProposal('unclaimed-slug');

    expect(result).toBeUndefined();
  });
});
