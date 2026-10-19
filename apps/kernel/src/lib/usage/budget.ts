import { fromDecimalString, type Money } from '@imajin/money';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface BudgetQuery {
  since: Date;
  cap: Money;
  now: Date;
}

export interface BudgetBilledRow {
  provider: string;
  source: string;
  granularity: string;
  billedUsd: string | null;
  periodStart: Date;
}

/** API month buckets overlap settled days; run lines are independently billed. */
export function countsTowardBilledTotal(row: { source: string; granularity: string }): boolean {
  return row.source !== 'api' || row.granularity === 'day' || row.granularity === 'run';
}

function parseTimestamp(value: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const calendar = new Date(`${match[1]}T00:00:00Z`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(calendar.getTime())) return null;
  if (calendar.toISOString().slice(0, 10) !== match[1]) return null;
  if (match[5] !== 'Z' && (Number(match[5].slice(1, 3)) > 23 || Number(match[5].slice(4)) > 59)) return null;
  return date;
}

/** Undefined means no budget requested; null means invalid paired inputs. */
export function parseBudgetQuery(params: URLSearchParams, now = new Date()): BudgetQuery | null | undefined {
  if (!params.has('budgetSince') && !params.has('budgetCap')) return undefined;
  if (params.getAll('budgetSince').length !== 1 || params.getAll('budgetCap').length !== 1) return null;
  const since = parseTimestamp(params.get('budgetSince') ?? '');
  const capText = params.get('budgetCap') ?? '';
  if (!since || since >= now || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?USD$/.test(capText)) return null;
  try {
    const cap = fromDecimalString(capText.slice(0, -3), 'USD');
    return cap.amount > 0 ? { since, cap, now } : null;
  } catch {
    return null;
  }
}

function monday(date: Date): Date {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCDate(result.getUTCDate() - (result.getUTCDay() + 6) % 7);
  return result;
}

function isoWeek(start: Date): string {
  const thursday = new Date(start.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const january4 = new Date(0);
  january4.setUTCFullYear(year, 0, 4);
  const week = Math.round((start.getTime() - monday(january4).getTime()) / WEEK_MS) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function zeroVendors(vendors: string[]): Record<string, number> {
  return Object.fromEntries(vendors.map(vendor => [vendor, 0]));
}

function capDate(now: Date, remaining: number, dailyRate: number): string | null {
  if (remaining <= 0 || dailyRate <= 0) return null;
  const date = new Date(now.getTime() + remaining / dailyRate * DAY_MS);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** USD ledger precision is retained; the cap is integer-minor-unit Money. */
export function buildUsageBudget(query: BudgetQuery, rows: BudgetBilledRow[]) {
  const { since, now, cap } = query;
  const included = rows.filter(row => countsTowardBilledTotal(row) && row.periodStart >= since && row.periodStart < now);
  const vendors = [...new Set(['warp', 'anthropic', 'moonshot', ...included.map(row => row.provider)])].sort();
  const byVendor = zeroVendors(vendors);
  const trailingByVendor = zeroVendors(vendors);
  const weeks = [];
  const firstMonday = monday(since).getTime();
  for (let start = firstMonday; start < now.getTime(); start += WEEK_MS) {
    weeks.push({
      week: isoWeek(new Date(start)),
      from: new Date(Math.max(start, since.getTime())).toISOString(),
      to: new Date(Math.min(start + WEEK_MS, now.getTime())).toISOString(),
      billed: { total: 0, byVendor: zeroVendors(vendors) },
      cumulative: { total: 0, byVendor: zeroVendors(vendors) },
    });
  }
  const trailingFrom = new Date(Math.max(since.getTime(), now.getTime() - WEEK_MS));
  for (const row of included) {
    const amount = Number(row.billedUsd ?? 0);
    if (!Number.isFinite(amount)) throw new Error('Invalid billed amount');
    const index = Math.floor((monday(row.periodStart).getTime() - firstMonday) / WEEK_MS);
    weeks[index].billed.byVendor[row.provider] += amount;
    weeks[index].billed.total += amount;
    if (row.periodStart >= trailingFrom) trailingByVendor[row.provider] += amount;
  }
  let total = 0;
  for (const week of weeks) {
    total += week.billed.total;
    for (const vendor of vendors) byVendor[vendor] += week.billed.byVendor[vendor];
    week.cumulative = { total, byVendor: { ...byVendor } };
  }
  const trailingTotal = Object.values(trailingByVendor).reduce((sum, amount) => sum + amount, 0);
  const remaining = cap.amount / 100 - total;
  return {
    since: since.toISOString(),
    asOf: now.toISOString(),
    currency: 'USD' as const,
    cap,
    billed: { total, byVendor },
    remaining,
    weeks,
    sources: {
      warp: { billed: 'api', grant: 'warp:dispatch' },
      anthropic: { billed: 'api', grant: 'anthropic:billing' },
      moonshot: { billed: 'manual-only', path: '/usage/api/billed', note: 'Balance snapshots are not spend; record top-up receipts manually.' },
    },
    projection: {
      basis: 'trailing-7-days' as const,
      from: trailingFrom.toISOString(),
      to: now.toISOString(),
      denominatorDays: 7,
      billed: { total: trailingTotal, byVendor: trailingByVendor },
      dailyRate: trailingTotal / 7,
      next7Days: trailingTotal,
      projectedTotalIn7Days: total + trailingTotal,
      projectedCapDate: capDate(now, remaining, trailingTotal / 7),
      capReached: remaining <= 0,
    },
  };
}

export type UsageBudgetResult = ReturnType<typeof buildUsageBudget>;
