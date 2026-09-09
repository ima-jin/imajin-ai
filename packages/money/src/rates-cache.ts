/**
 * `getRate` — table-first, ECB-fetch-on-miss cache-through for FX rates.
 *
 * Queries `money.fx_rates` via raw parameterized SQL (rather than the
 * `fxRates` drizzle table object in schema.ts) so it works against any
 * caller's `AnyDatabase` handle without requiring them to register this
 * package's schema first.
 */

import { sql } from 'drizzle-orm';
import type { AnyDatabase } from '@imajin/db';

import type { FxSnapshot } from './fx-snapshot';
import { triangulate } from './convert';
import { fractionToDecimalString, invertRational, parseDecimalToFraction } from './decimal';
import { EcbParseError } from './errors';
import { type EcbDailyRates, fetchEcbDailyRates } from './ecb';

export interface GetRateOptions {
  /** Injectable ECB fetcher — tests supply a fixture-backed fake instead of hitting the network. */
  readonly fetchRates?: () => Promise<EcbDailyRates>;
}

interface CachedRateRow {
  rate: string;
  source: string;
}

async function readCachedRate(
  db: AnyDatabase,
  base: string,
  quote: string,
  date: string,
): Promise<FxSnapshot | null> {
  const rows = (await db.execute(sql`
    SELECT rate, source FROM money.fx_rates
    WHERE base = ${base} AND quote = ${quote} AND date = ${date}
    LIMIT 1
  `)) as unknown as CachedRateRow[];
  const row = rows[0];
  return row ? { base, quote, rate: row.rate, source: row.source, asOf: date } : null;
}

async function writeCachedRate(db: AnyDatabase, snapshot: FxSnapshot, date: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO money.fx_rates (base, quote, date, rate, source)
    VALUES (${snapshot.base}, ${snapshot.quote}, ${date}, ${snapshot.rate}, ${snapshot.source})
    ON CONFLICT (base, quote, date) DO NOTHING
  `);
}

function eurLegFromDaily(quote: string, daily: EcbDailyRates): FxSnapshot {
  const rate = daily.rates[quote];
  if (!rate) {
    throw new EcbParseError(`ECB daily rates has no entry for currency "${quote}"`);
  }
  return { base: 'EUR', quote, rate, source: 'ecb', asOf: daily.date };
}

function deriveSnapshotFromDaily(base: string, quote: string, daily: EcbDailyRates): FxSnapshot {
  if (base === 'EUR') return eurLegFromDaily(quote, daily);
  if (quote === 'EUR') {
    const eurToBase = eurLegFromDaily(base, daily);
    const invertedRate = fractionToDecimalString(invertRational(parseDecimalToFraction(eurToBase.rate)), 10);
    return { base, quote, rate: invertedRate, source: 'ecb', asOf: daily.date };
  }
  return triangulate(eurLegFromDaily(base, daily), eurLegFromDaily(quote, daily));
}

/**
 * Look up the `(base, quote, date)` FX rate, fetching and caching it from
 * ECB on a miss. One miss triggers at most one ECB fetch (the daily sheet
 * covers every currency at once), regardless of which pair or how many
 * legs of triangulation were needed to derive it.
 */
export async function getRate(
  base: string,
  quote: string,
  date: string,
  db: AnyDatabase,
  options: GetRateOptions = {},
): Promise<FxSnapshot> {
  if (base === quote) {
    return { base, quote, rate: '1', source: 'identity', asOf: date };
  }

  const cached = await readCachedRate(db, base, quote, date);
  if (cached) return cached;

  const fetchRates = options.fetchRates ?? fetchEcbDailyRates;
  const snapshot = deriveSnapshotFromDaily(base, quote, await fetchRates());
  await writeCachedRate(db, snapshot, date);
  return snapshot;
}
