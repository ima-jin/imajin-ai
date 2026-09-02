/**
 * Upsert normalized provider billing lines into `usage.billed` (#1076 Stage 1).
 *
 * One call per (principal, provider, period, granularity) pull — `lines` is
 * the adapter's already-normalized per-model (and, for OpenAI, one
 * aggregate) breakdown for that single window. Idempotent: re-running the
 * same pull (the daily job re-pulls yesterday's settled day and the current
 * month-to-date bucket every run) upserts in place via the migration's
 * `(principal_did, provider, period_start, granularity, COALESCE(model,''))`
 * unique index rather than accumulating duplicate rows.
 *
 * Written with the raw `postgres` client (`getClient()`) rather than the
 * drizzle query builder: drizzle's `onConflictDoUpdate({ target })` only
 * accepts real columns (`IndexColumn | IndexColumn[]`), not the
 * `COALESCE(model, '')` expression the migration's unique index is actually
 * built on, so there is no way to name this conflict target through the
 * query builder. Same escape hatch `calendar/index.ts` uses for its own
 * `ON CONFLICT` write.
 */
import { getClient } from '@imajin/db';
import { generateId } from '@/src/lib/kernel/id';
import type { BilledGranularity, BilledLine, BilledPeriod } from './types';

export interface IngestBilledUsageParams {
  principalDid: string;
  provider: string;
  period: BilledPeriod;
  granularity: BilledGranularity;
  lines: BilledLine[];
}

/** Upsert every line for one pull. Returns the number of rows written. */
export async function ingestBilledUsage(params: IngestBilledUsageParams): Promise<number> {
  const { principalDid, provider, period, granularity, lines } = params;
  const sql = getClient();

  for (const line of lines) {
    const billedUsd = line.billedUsd === null ? null : line.billedUsd.toFixed(8);
    // Round-tripped through JSON.stringify/parse so the value structurally
    // satisfies `postgres`'s `JSONValue` type — `line.raw` is `unknown` here
    // (an adapter's own provider-shaped object), and it is already destined
    // for a jsonb column, so this is a type-narrowing no-op, not a behavior change.
    const raw = JSON.parse(JSON.stringify(line.raw ?? {}));
    await sql`
      INSERT INTO usage.billed
        (id, principal_did, provider, period_start, period_end, granularity, model, tokens_in, tokens_out, billed_usd, raw, fetched_at)
      VALUES
        (${generateId('billed')}, ${principalDid}, ${provider}, ${period.start}, ${period.end}, ${granularity},
         ${line.model}, ${line.tokensIn}, ${line.tokensOut}, ${billedUsd}, ${sql.json(raw)}, now())
      ON CONFLICT (principal_did, provider, period_start, granularity, COALESCE(model, ''))
      DO UPDATE SET
        period_end = EXCLUDED.period_end,
        tokens_in = EXCLUDED.tokens_in,
        tokens_out = EXCLUDED.tokens_out,
        billed_usd = EXCLUDED.billed_usd,
        raw = EXCLUDED.raw,
        fetched_at = EXCLUDED.fetched_at
    `;
  }

  return lines.length;
}
