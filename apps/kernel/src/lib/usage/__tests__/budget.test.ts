import { describe, expect, it } from 'vitest';
import { buildUsageBudget, buildCostReport, parseBudgetQuery, parseCostReportQuery, type MeterRow } from '../budget';

const NOW = new Date('2026-10-26T16:13:00Z');
const SINCE = new Date('2026-10-19T16:13:00Z');
const query = { since: SINCE, now: NOW, cap: { amount: 400000, currency: 'USD' } };
function row(date: string, amount: string | null, provider = 'warp', status: string | null = null): MeterRow {
  return { createdAt: new Date(date), costUsd: amount, provider, status };
}

describe('parseBudgetQuery', () => {
  it('omits the optional block and parses exact USD Money without rounding', () => {
    expect(parseBudgetQuery(new URLSearchParams(), NOW)).toBeUndefined();
    expect(parseBudgetQuery(new URLSearchParams({ budgetSince: SINCE.toISOString(), budgetCap: '4000USD' }), NOW)).toEqual(query);
    expect(parseBudgetQuery(new URLSearchParams({ budgetSince: '2026-10-19T18:13:00+02:00', budgetCap: '0.01USD' }), NOW)?.cap.amount).toBe(1);
  });

  it.each([
    { budgetCap: '4000USD' }, { budgetSince: SINCE.toISOString() },
    ...['', '0USD', '-1USD', '01USD', 'NaNUSD', 'InfinityUSD', '1e3USD', '4000CAD', '4000usd', '4.001USD', '4000 USD', '1.USD', '9007199254740992USD']
      .map(budgetCap => ({ budgetSince: SINCE.toISOString(), budgetCap })),
    ...['2026-02-30T12:00:00Z', '2026-13-01T12:00:00Z', '2026-10-19', '2026-10-19T12:00:00', '2026-10-19T24:00:00Z', '2026-10-19T12:60:00Z', '2026-10-19T12:00:60Z', '2026-10-19T12:00:00+24:00', NOW.toISOString(), '2027-01-01T00:00:00Z']
      .map(budgetSince => ({ budgetSince, budgetCap: '4000USD' })),
  ])('rejects invalid or unpaired inputs %j', params => {
    expect(parseBudgetQuery(new URLSearchParams(params), NOW)).toBeNull();
  });

  it('rejects duplicate query parameters', () => {
    const params = new URLSearchParams({ budgetSince: SINCE.toISOString(), budgetCap: '4000USD' });
    params.append('budgetCap', '1USD');
    expect(parseBudgetQuery(params, NOW)).toBeNull();
    params.delete('budgetCap');
    params.set('budgetCap', '4000USD');
    params.append('budgetSince', SINCE.toISOString());
    expect(parseBudgetQuery(params, NOW)).toBeNull();
  });
});

describe('cost reports', () => {
  it('accepts strict UTC ISO days and future calendar ends without changing exact budget timestamp rules', () => {
    expect(parseCostReportQuery(new URLSearchParams({ from: '2026-10-01', to: '2026-11-01' }), NOW))
      .toEqual({ from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), asOf: NOW });
    expect(parseBudgetQuery(new URLSearchParams({ budgetSince: '2026-10-01', budgetCap: '4000USD' }), NOW)).toBeNull();
    expect(parseCostReportQuery(new URLSearchParams({ from: '2028-02-29', to: '2028-03-01' }), NOW)).not.toBeNull();
    expect(parseCostReportQuery(new URLSearchParams({ from: '2026-02-29', to: '2026-03-01' }), NOW)).toBeNull();
  });

  it('counts UTC midnight inclusively, next midnight exclusively, and clips a future end at asOf', () => {
    const from = new Date('2026-10-20T00:00:00Z');
    const to = new Date('2026-10-21T00:00:00Z');
    const rows = [
      row('2026-10-19T23:59:59.999Z', '1000'), row(from.toISOString(), '1'),
      row('2026-10-20T23:59:59.999Z', '2'), row(to.toISOString(), '1000'),
    ];
    expect(buildCostReport({ from, to, asOf: NOW }, rows).total).toBe(3);
    const open = buildCostReport({ from: SINCE, to: new Date('2026-11-01T00:00:00Z'), asOf: NOW }, [
      row(SINCE.toISOString(), '1'), row('2026-10-26T16:12:59.999Z', '2'),
      row(NOW.toISOString(), '1000'), row('2026-10-27T00:00:00Z', '1000'),
    ]);
    expect(open.total).toBe(3);
    expect(open.to).toBe('2026-11-01T00:00:00.000Z');
    expect(open.asOf).toBe(NOW.toISOString());
  });
  it('validates a strictly paired independent interval', () => {
    expect(parseCostReportQuery(new URLSearchParams(), NOW)).toBeUndefined();
    expect(parseCostReportQuery(new URLSearchParams({ from: SINCE.toISOString(), to: NOW.toISOString() }), NOW))
      .toEqual({ from: SINCE, to: NOW, asOf: NOW });
  });

  it.each([
    'from=2026-10-19T00:00:00Z', 'to=2026-10-20T00:00:00Z',
    'from=2026-10-20T00:00:00Z&to=2026-10-19T00:00:00Z',
    'from=2026-10-20T00:00:00Z&to=2026-10-20T00:00:00Z',
    'from=2026-02-30T00:00:00Z&to=2026-10-20T00:00:00Z',
    'from=2026-02-30&to=2026-10-21',
    'from=2026-10-20T00:00&to=2027-10-21T00:00:00Z',
    'from=2026-10-20T00:00:00Z&from=2026-10-19T00:00:00Z&to=2026-10-21T00:00:00Z',
    'from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z&to=2026-10-22T00:00:00Z',
  ])('rejects invalid report query %s', params => {
    expect(parseCostReportQuery(new URLSearchParams(params), NOW)).toBeNull();
  });

  it('reports only priced non-error costs and separately counts unpriced observations', () => {
    expect(buildCostReport({ from: SINCE, to: NOW, asOf: NOW }, [
      row(SINCE.toISOString(), '12', 'anthropic'),
      row(SINCE.toISOString(), null, 'moonshot'),
      row(SINCE.toISOString(), '0', 'warp'),
      row(SINCE.toISOString(), '1000', 'warp', 'error'),
      row(NOW.toISOString(), '1000'),
      row('2026-10-19T16:12:59.999Z', '1000'),
    ])).toEqual({
      from: SINCE.toISOString(), to: NOW.toISOString(), asOf: NOW.toISOString(), currency: 'USD', basis: 'meter-estimate',
      total: 12, byProvider: { anthropic: 12, moonshot: 0, warp: 0 }, rowCount: 3, unpricedCount: 1,
    });
  });
});

describe('buildUsageBudget', () => {
  it('retains unknown-cost observations rather than implying complete zero spend', () => {
    const result = buildUsageBudget(query, [row(SINCE.toISOString(), null, 'moonshot')]);
    expect(result.incurred).toMatchObject({ total: 0, rowCount: 1, unpricedCount: 1 });
    expect(result.weeks[0].incurred.unpricedCount).toBe(1);
    expect(result.weeks[1].cumulative.unpricedCount).toBe(1);
    expect(result.projection.incurred.unpricedCount).toBe(1);
  });
  it('uses exact [since, now) incurred instants and excludes failed attempts', () => {
    const result = buildUsageBudget(query, [
      row('2026-10-19T16:12:59.999Z', '999'),
      row(SINCE.toISOString(), '7'),
      row('2026-10-20T00:00:00Z', '14', 'anthropic'),
      row('2026-10-01T00:00:00Z', '999', 'anthropic'),
      row('2026-10-20T00:00:00Z', '999', 'anthropic', 'error'),
      row('2026-10-21T00:00:00Z', '21', 'moonshot'),
      row('2026-10-22T00:00:00Z', '28', 'other'),
      row(NOW.toISOString(), '999'),
    ]);
    expect(result.incurred).toEqual({ total: 70, byProvider: { warp: 7, anthropic: 14, moonshot: 21, other: 28 }, rowCount: 4, unpricedCount: 0 });
    expect(result.remaining).toBe(3930);
    expect(result.weeks.map(week => week.week)).toEqual(['2026-W43', '2026-W44']);
    expect(result.weeks[1].incurred.total).toBe(0);
    expect(result.weeks[1].cumulative).toEqual(result.incurred);
    expect(result.projection).toMatchObject({
      dailyRate: 10, next7Days: 70, projectedTotalIn7Days: 140, denominatorDays: 7,
      projectedCapDate: '2027-11-23T16:13:00.000Z', capReached: false,
    });
    expect(result.sources.moonshot.meter).toBe('tokens-times-rate-card');
  });

  it('retains zero ISO weeks and correct ISO week-years over New Year', () => {
    const result = buildUsageBudget({
      ...query, since: new Date('2020-12-31T12:00:00Z'), now: new Date('2021-01-18T00:00:00Z'),
    }, [row('2021-01-03T23:59:59Z', '1'), row('2021-01-04T00:00:00Z', '2')]);
    expect(result.weeks.map(week => week.week)).toEqual(['2020-W53', '2021-W01', '2021-W02']);
    expect(result.weeks.map(week => week.incurred.total)).toEqual([1, 2, 0]);
    expect(result.weeks.map(week => week.cumulative.total)).toEqual([1, 3, 3]);
    expect(result.weeks[0].cumulative.byProvider.warp).toBe(1);
    expect(result.projection.dailyRate).toBe(0);
    expect(result.projection.projectedCapDate).toBeNull();
    expect(result.weeks[0].from).toBe('2020-12-31T12:00:00.000Z');
  });

  it('recognizes dates in late December that belong to next ISO year', () => {
    const result = buildUsageBudget({ ...query, since: new Date('2024-12-30T00:00:00Z'), now: new Date('2025-01-01T00:00:00Z') }, []);
    expect(result.weeks[0].week).toBe('2025-W01');
  });

  it('uses a fixed seven-day denominator even for a new budget', () => {
    const result = buildUsageBudget({ ...query, since: new Date('2026-10-26T00:00:00Z') }, [row('2026-10-26T01:00:00Z', '7')]);
    expect(result.projection.dailyRate).toBe(1);
    expect(result.projection.from).toBe('2026-10-26T00:00:00.000Z');
  });

  it.each([4000, 4100])('makes reached/overspent caps legible without a fictional future cap date (%i)', amount => {
    const result = buildUsageBudget(query, [row(SINCE.toISOString(), String(amount))]);
    expect(result.remaining).toBe(4000 - amount);
    expect(result.projection.capReached).toBe(true);
    expect(result.projection.projectedCapDate).toBeNull();
  });

  it('uses only the trailing seven days for projection, inclusive lower/exclusive upper', () => {
    const result = buildUsageBudget({ ...query, since: new Date('2026-10-01T00:00:00Z') }, [
      row('2026-10-19T16:12:59.999Z', '70'), row(SINCE.toISOString(), '7'), row(NOW.toISOString(), '1000'),
    ]);
    expect(result.incurred.total).toBe(77);
    expect(result.projection.next7Days).toBe(7);
  });

  it('handles missing amounts and refuses non-finite ledger data', () => {
    expect(buildUsageBudget(query, [row(SINCE.toISOString(), null)]).incurred.total).toBe(0);
    expect(() => buildUsageBudget(query, [row(SINCE.toISOString(), 'NaN')])).toThrow('Invalid metered cost');
  });

  it('returns null rather than throwing for an unrepresentable projected date', () => {
    expect(buildUsageBudget(query, [row(SINCE.toISOString(), '0.00000001')]).projection.projectedCapDate).toBeNull();
  });
});
