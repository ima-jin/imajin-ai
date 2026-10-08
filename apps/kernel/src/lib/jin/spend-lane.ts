/**
 * Read model for the /jin Spend lane's provider block (#2725): today's cost
 * per provider, each provider's current-period spend next to its declared cap,
 * and the 7-day trend.
 *
 * Zero new backend. Everything is read from what #1923/#2030 already own:
 *   - `usage.incurred` — OUR meter (same table + same `SUM(cost_usd)` per
 *     provider that `GET /usage/api/summary` reports; USD).
 *   - `kernel.connectors.spend_cap` — the owner-declared cap
 *     (`GET /{provider}/api/spend-cap`), parsed by the same `parseSpendCap`.
 *   - `checkSpendCap` — the SAME accumulated-spend measurement the
 *     kernel enforces the cap with, so "close to cap" here means exactly
 *     "close to being refused" there.
 *
 * Providers are enumerated the way the connectors settings page does it: the
 * `CONNECTOR_REGISTRY` entries that expose a `/spend-cap` settings route. A
 * provider with no cap and no spend this week is omitted; a provider that
 * shows up in `usage.incurred` but has no cap route (e.g. an external
 * emitter's provider) is listed uncapped.
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, usageIncurred, type ConnectorRow } from '@/src/db';
import { CONNECTOR_REGISTRY } from '@/src/lib/kernel/connector-registry';
import { listConnectorRegistrations } from '@/src/lib/kernel/connector-registry-store';
import { checkSpendCap, parseSpendCap, type SpendCap } from '@/src/lib/inference/spend-cap';

export const TREND_DAYS = 7;
/** A provider at or above this share of its cap is flagged "near". */
export const NEAR_CAP_RATIO = 0.8;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CapStatus = 'ok' | 'near' | 'over' | 'uncapped' | 'unknown';

export interface ProviderSpend {
  provider: string;
  name: string;
  todayUsd: number;
  weekUsd: number;
  cap: SpendCap | null;
  /** Spend inside the cap's own period (what enforcement compares); null when it could not be measured. */
  periodSpentUsd: number | null;
  /** periodSpentUsd / cap.amountUsd; null when uncapped or unmeasured. */
  ratio: number | null;
  status: CapStatus;
}

export interface TrendDay {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  totalUsd: number;
}

export interface SpendLane {
  generatedAt: string;
  currency: 'USD';
  providers: ProviderSpend[];
  /** Oldest → newest; always `TREND_DAYS` entries, the last being today (UTC). */
  trend: TrendDay[];
  todayUsd: number;
  weekUsd: number;
}

export interface DailyProviderRow {
  day: string;
  provider: string;
  usd: number;
}

export interface CapProvider {
  id: string;
  name: string;
}

export interface SpendLaneDeps {
  capProviders(): CapProvider[];
  listRegistrations(ownerDid: string): Promise<Pick<ConnectorRow, 'id' | 'provider' | 'spendCap'>[]>;
  measureCap(connectorId: string, cap: SpendCap): Promise<number | null>;
  dailySpend(principalDid: string, from: Date, to: Date): Promise<DailyProviderRow[]>;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` (UTC) for each of the `days` days ending at `now`'s UTC day, oldest first. */
export function trendDates(now: Date, days: number = TREND_DAYS): string[] {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(todayStart - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/** Where a provider's measured spend sits against its cap. */
export function capStatus(cap: SpendCap | null, spentUsd: number | null): { ratio: number | null; status: CapStatus } {
  if (!cap) return { ratio: null, status: 'uncapped' };
  if (spentUsd === null) return { ratio: null, status: 'unknown' };
  const ratio = spentUsd / cap.amountUsd;
  if (ratio >= 1) return { ratio, status: 'over' };
  if (ratio >= NEAR_CAP_RATIO) return { ratio, status: 'near' };
  return { ratio, status: 'ok' };
}

const STATUS_RANK: Record<CapStatus, number> = { over: 0, near: 1, unknown: 2, ok: 3, uncapped: 4 };

function compareProviders(a: ProviderSpend, b: ProviderSpend): number {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.todayUsd - a.todayUsd || a.provider.localeCompare(b.provider);
}

interface Totals {
  today: number;
  week: number;
}

function totalsByProvider(rows: DailyProviderRow[], today: string): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const row of rows) {
    const t = out.get(row.provider) ?? { today: 0, week: 0 };
    t.week += row.usd;
    if (row.day === today) t.today += row.usd;
    out.set(row.provider, t);
  }
  return out;
}

function trendOf(rows: DailyProviderRow[], dates: string[]): TrendDay[] {
  const perDay = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const row of rows) {
    if (perDay.has(row.day)) perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.usd);
  }
  return dates.map((date) => ({ date, totalUsd: perDay.get(date) ?? 0 }));
}

// ── Read ──────────────────────────────────────────────────────────────────────

/** Build the provider block + 7-day trend for one principal (the node operator). */
export async function buildSpendLane(
  principalDid: string,
  deps: SpendLaneDeps,
  now: Date = new Date(),
): Promise<SpendLane> {
  const dates = trendDates(now);
  const today = dates.at(-1) ?? dates[0];
  const from = new Date(`${dates[0]}T00:00:00.000Z`);
  const to = new Date(Date.parse(`${today}T00:00:00.000Z`) + DAY_MS);

  const [rows, registrations] = await Promise.all([
    deps.dailySpend(principalDid, from, to),
    deps.listRegistrations(principalDid),
  ]);

  const totals = totalsByProvider(rows, today);
  const names = new Map(deps.capProviders().map((p) => [p.id, p.name]));
  const caps = new Map<string, { connectorId: string; cap: SpendCap }>();
  for (const reg of registrations) {
    const cap = parseSpendCap(reg.spendCap);
    if (cap && names.has(reg.provider)) caps.set(reg.provider, { connectorId: reg.id, cap });
  }

  const providerIds = new Set<string>([...caps.keys(), ...totals.keys()]);
  const providers = await Promise.all(
    [...providerIds].map(async (provider): Promise<ProviderSpend> => {
      const declared = caps.get(provider);
      const periodSpentUsd = declared ? await deps.measureCap(declared.connectorId, declared.cap) : null;
      const { ratio, status } = capStatus(declared?.cap ?? null, periodSpentUsd);
      const t = totals.get(provider) ?? { today: 0, week: 0 };
      return {
        provider,
        name: names.get(provider) ?? provider,
        todayUsd: t.today,
        weekUsd: t.week,
        cap: declared?.cap ?? null,
        periodSpentUsd,
        ratio,
        status,
      };
    }),
  );

  const trend = trendOf(rows, dates);
  const sortedProviders = [...providers].sort(compareProviders);
  return {
    generatedAt: now.toISOString(),
    currency: 'USD',
    providers: sortedProviders,
    trend,
    todayUsd: trend.at(-1)?.totalUsd ?? 0,
    weekUsd: trend.reduce((sum, d) => sum + d.totalUsd, 0),
  };
}

// ── Default readers ───────────────────────────────────────────────────────────

async function dailySpend(principalDid: string, from: Date, to: Date): Promise<DailyProviderRow[]> {
  const day = sql<string>`to_char(${usageIncurred.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      provider: usageIncurred.provider,
      usd: sql<string | null>`SUM(${usageIncurred.costUsd})`,
    })
    .from(usageIncurred)
    .where(and(eq(usageIncurred.principalDid, principalDid), gte(usageIncurred.createdAt, from), lt(usageIncurred.createdAt, to)))
    .groupBy(day, usageIncurred.provider);

  return rows.map((row) => ({ day: row.day, provider: row.provider, usd: row.usd === null ? 0 : Number(row.usd) }));
}

/** The registry entries that expose a `/spend-cap` settings route — the connectors settings page's own filter. */
function capProviders(): CapProvider[] {
  return CONNECTOR_REGISTRY.filter((entry) => entry.settings?.route.endsWith('/spend-cap')).map((entry) => ({
    id: entry.id,
    name: entry.name,
  }));
}

export const defaultSpendLaneDeps: SpendLaneDeps = {
  capProviders,
  listRegistrations: listConnectorRegistrations,
  async measureCap(connectorId, cap) {
    const check = await checkSpendCap(connectorId, cap);
    return check ? check.spentUsd : null;
  },
  dailySpend,
};

/** Entry point for the route. */
export function readSpendLane(principalDid: string): Promise<SpendLane> {
  return buildSpendLane(principalDid, defaultSpendLaneDeps);
}
