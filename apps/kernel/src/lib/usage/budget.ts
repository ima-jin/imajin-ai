import { fromDecimalString, type Money } from '@imajin/money';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export interface BudgetQuery {
  since: Date;
  cap: Money;
  now: Date;
}
function parseReportBound(value: string): Date | null {
  return parseTimestamp(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}
/** Optional independent report interval, never silently normalizing dates. */
export function parseCostReportQuery(params: URLSearchParams, now = new Date()): CostReportQuery | null | undefined {
  if (!params.has('from') && !params.has('to')) return undefined;
  if (params.getAll('from').length !== 1 || params.getAll('to').length !== 1) return null;
  const from = parseReportBound(params.get('from') ?? '');
  const to = parseReportBound(params.get('to') ?? '');
  return from && to && from < to ? { from, to, asOf: now } : null;
}

export interface MeterRow {
  provider: string;
  costUsd: string | null;
  createdAt: Date;
  status: string | null;
}

export interface CostReportQuery {
  from: Date;
  to: Date;
  asOf: Date;
}

export function parseTimestamp(value: string): Date | null {
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

function emptyTotals(providers: string[]) {
  return { total: 0, byProvider: Object.fromEntries(providers.map(provider => [provider, 0])) as Record<string, number>, rowCount: 0, unpricedCount: 0 };
}

type CostTotals = ReturnType<typeof emptyTotals>;

function addRow(totals: CostTotals, row: MeterRow): void {
  totals.rowCount++;
  if (row.costUsd === null) {
    totals.unpricedCount++;
    return;
  }
  const amount = Number(row.costUsd);
  if (!Number.isFinite(amount)) throw new Error('Invalid metered cost');
  totals.total += amount;
  totals.byProvider[row.provider] += amount;
}

function includedRows(rows: MeterRow[], from: Date, to: Date): MeterRow[] {
  return rows.filter(row => row.status !== 'error' && row.createdAt >= from && row.createdAt < to);
}

function providerNames(rows: MeterRow[]): string[] {
  return [...new Set(['warp', 'anthropic', 'moonshot', ...rows.map(row => row.provider)])]
    .sort((left, right) => left.localeCompare(right));
}

export function buildCostReport(query: CostReportQuery, rows: MeterRow[]) {
  const included = includedRows(rows, query.from, new Date(Math.min(query.to.getTime(), query.asOf.getTime())));
  const totals = emptyTotals(providerNames(included));
  for (const row of included) addRow(totals, row);
  return { from: query.from.toISOString(), to: query.to.toISOString(), asOf: query.asOf.toISOString(), currency: 'USD' as const, basis: 'meter-estimate' as const, ...totals };
}

function capDate(now: Date, remaining: number, dailyRate: number): string | null {
  if (remaining <= 0 || dailyRate <= 0) return null;
  const date = new Date(now.getTime() + remaining / dailyRate * DAY_MS);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** USD ledger precision is retained; the cap is integer-minor-unit Money. */
export function buildUsageBudget(query: BudgetQuery, rows: MeterRow[]) {
  const { since, now, cap } = query;
  const included = includedRows(rows, since, now);
  const providers = providerNames(included);
  const cumulative = emptyTotals(providers);
  const trailing = emptyTotals(providers);
  const weeks = [];
  const firstMonday = monday(since).getTime();
  for (let start = firstMonday; start < now.getTime(); start += WEEK_MS) {
    weeks.push({
      week: isoWeek(new Date(start)),
      from: new Date(Math.max(start, since.getTime())).toISOString(),
      to: new Date(Math.min(start + WEEK_MS, now.getTime())).toISOString(),
      incurred: emptyTotals(providers),
      cumulative: emptyTotals(providers),
    });
  }
  const trailingFrom = new Date(Math.max(since.getTime(), now.getTime() - WEEK_MS));
  for (const row of included) {
    const index = Math.floor((monday(row.createdAt).getTime() - firstMonday) / WEEK_MS);
    addRow(weeks[index].incurred, row);
    if (row.createdAt >= trailingFrom) addRow(trailing, row);
  }
  for (const week of weeks) {
    cumulative.total += week.incurred.total;
    cumulative.rowCount += week.incurred.rowCount;
    cumulative.unpricedCount += week.incurred.unpricedCount;
    for (const provider of providers) cumulative.byProvider[provider] += week.incurred.byProvider[provider];
    week.cumulative = { ...cumulative, byProvider: { ...cumulative.byProvider } };
  }
  const remaining = cap.amount / 100 - cumulative.total;
  return {
    since: since.toISOString(),
    asOf: now.toISOString(),
    currency: 'USD' as const,
    basis: 'meter-estimate' as const,
    cap,
    incurred: cumulative,
    remaining,
    weeks,
    sources: {
      warp: { meter: 'own-run-watch', note: 'Kernel-observed run usage; not the account-wide provider bill.' },
      anthropic: { meter: 'tokens-times-rate-card', note: 'Observed inference tokens at the kernel rate card.' },
      moonshot: { meter: 'tokens-times-rate-card', note: 'Observed inference tokens at the kernel rate card.' },
    },
    projection: {
      basis: 'trailing-7-days' as const,
      from: trailingFrom.toISOString(),
      to: now.toISOString(),
      denominatorDays: 7,
      incurred: trailing,
      dailyRate: trailing.total / 7,
      next7Days: trailing.total,
      projectedTotalIn7Days: cumulative.total + trailing.total,
      projectedCapDate: capDate(now, remaining, trailing.total / 7),
      capReached: remaining <= 0,
    },
  };
}

export type UsageBudgetResult = ReturnType<typeof buildUsageBudget>;
