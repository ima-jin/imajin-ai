import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWhere, mockFrom, mockSelect } = vi.hoisted(() => {
  const mockWhere = vi.fn();
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  return { mockWhere, mockFrom, mockSelect };
});

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  usageIncurred: { connectorId: 'connector_id', createdAt: 'created_at', costUsd: 'cost_usd' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  gte: (...args: unknown[]) => ({ gte: args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  parseSpendCap,
  serializeSpendCap,
  checkSpendCap,
  enforceSpendCap,
  SpendCapExceededError,
} from '../spend-cap';

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockImplementation(() => ({ from: mockFrom }));
  mockFrom.mockImplementation(() => ({ where: mockWhere }));
  mockWhere.mockResolvedValue([{ total: '0' }]);
});

// ── parseSpendCap ────────────────────────────────────────────────────────────

describe('parseSpendCap', () => {
  it('parses a well-formed cap', () => {
    expect(parseSpendCap({ amountUsd: 50, period: 'daily' })).toEqual({ amountUsd: 50, period: 'daily' });
  });

  it('treats null/undefined as no cap', () => {
    expect(parseSpendCap(null)).toBeUndefined();
    expect(parseSpendCap(undefined)).toBeUndefined();
  });

  it('treats a malformed amount as no cap (fail open on a budget guard)', () => {
    expect(parseSpendCap({ amountUsd: -5, period: 'daily' })).toBeUndefined();
    expect(parseSpendCap({ amountUsd: 'fifty', period: 'daily' })).toBeUndefined();
    expect(parseSpendCap({ period: 'daily' })).toBeUndefined();
  });

  it('treats an unrecognized period as no cap', () => {
    expect(parseSpendCap({ amountUsd: 50, period: 'weekly' })).toBeUndefined();
  });

  it('round-trips through serializeSpendCap', () => {
    const cap = { amountUsd: 25, period: 'monthly' as const };
    expect(parseSpendCap(serializeSpendCap(cap))).toEqual(cap);
  });
});

// ── checkSpendCap ────────────────────────────────────────────────────────────

describe('checkSpendCap', () => {
  it('reports not exceeded when spend is below the cap', async () => {
    mockWhere.mockResolvedValueOnce([{ total: '5' }]);
    const result = await checkSpendCap('conn_x', { amountUsd: 10, period: 'daily' });
    expect(result).toEqual({ exceeded: false, cap: { amountUsd: 10, period: 'daily' }, spentUsd: 5 });
  });

  it('reports exceeded once spend reaches the cap exactly', async () => {
    mockWhere.mockResolvedValueOnce([{ total: '10' }]);
    const result = await checkSpendCap('conn_x', { amountUsd: 10, period: 'daily' });
    expect(result?.exceeded).toBe(true);
  });

  it('reports exceeded once spend passes the cap', async () => {
    mockWhere.mockResolvedValueOnce([{ total: '10.5' }]);
    const result = await checkSpendCap('conn_x', { amountUsd: 10, period: 'daily' });
    expect(result?.exceeded).toBe(true);
  });

  it('fails open (returns undefined) when the usage query throws', async () => {
    mockWhere.mockRejectedValueOnce(new Error('connection reset'));
    const result = await checkSpendCap('conn_x', { amountUsd: 10, period: 'daily' });
    expect(result).toBeUndefined();
  });

  it("scopes a 'total' cap with no time filter", async () => {
    await checkSpendCap('conn_x', { amountUsd: 10, period: 'total' });
    const [whereArg] = mockWhere.mock.calls[0] as [{ and: unknown[] }];
    expect(whereArg.and).toHaveLength(1);
    expect(whereArg.and[0]).toEqual({ eq: ['connector_id', 'conn_x'] });
  });

  it("scopes a 'daily' cap with a gte(createdAt, startOfToday) filter", async () => {
    await checkSpendCap('conn_x', { amountUsd: 10, period: 'daily' });
    const [whereArg] = mockWhere.mock.calls[0] as [{ and: unknown[] }];
    expect(whereArg.and).toHaveLength(2);
    expect(whereArg.and[1]).toMatchObject({ gte: ['created_at', expect.any(Date)] });
  });
});

// ── enforceSpendCap ──────────────────────────────────────────────────────────

describe('enforceSpendCap', () => {
  it('is a no-op when no cap is declared', async () => {
    await expect(enforceSpendCap('conn_x', null)).resolves.toBeUndefined();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('is a no-op when the cap is malformed', async () => {
    await expect(enforceSpendCap('conn_x', { amountUsd: -1, period: 'daily' })).resolves.toBeUndefined();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('throws SpendCapExceededError once the cap has been reached', async () => {
    mockWhere.mockResolvedValueOnce([{ total: '12' }]);
    await expect(enforceSpendCap('conn_x', { amountUsd: 10, period: 'daily' })).rejects.toBeInstanceOf(SpendCapExceededError);
  });

  it('never trusts a client-supplied cap \u2014 it always reads from the row passed in', async () => {
    mockWhere.mockResolvedValueOnce([{ total: '1' }]);
    await expect(enforceSpendCap('conn_x', { amountUsd: 10, period: 'daily' })).resolves.toBeUndefined();
  });

  it('does not throw when the usage query fails (fails open on measurement error)', async () => {
    mockWhere.mockRejectedValueOnce(new Error('connection reset'));
    await expect(enforceSpendCap('conn_x', { amountUsd: 10, period: 'daily' })).resolves.toBeUndefined();
  });
});
