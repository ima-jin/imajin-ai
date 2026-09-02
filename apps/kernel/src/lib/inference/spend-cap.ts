/**
 * Spend-cap enforcement (#1923, Phase 3 of #1922).
 *
 * The cap itself lives on `kernel.connectors.spend_cap` (#1924, migration
 * 0114) — the consolidated connector registry, not a new table. 0114 left
 * the column shapeless JSONB "until #1922 Phase 3 settles the window
 * semantics"; this module IS that settlement: `{ amountUsd, period }`.
 *
 * Enforcement checks the ALREADY-ACCUMULATED spend for this connector
 * registration against the cap, before the call is forwarded upstream — not
 * a prediction of what the upcoming call will cost. A chat-completion's
 * exact cost is unknowable before the provider has actually generated the
 * (variable-length) response, so "refuse once already at/over the cap"
 * (checked here) is the only version of "before forwarding" that is
 * actually enforceable without inventing a token-estimate heuristic that
 * would either under- or over-block regardless. This is the same trade-off
 * every prepaid-metering system with variable-cost units makes; the epic's
 * "refuses if exceeded" wording matches a based-on-current-spend check, not
 * a look-ahead one.
 *
 * Fails OPEN on a measurement error (DB read failure): a transient query
 * failure must not make every inference call fail closed just because the
 * spend total could not be computed. Fails CLOSED once a cap is
 * successfully read and the accumulated spend is at or over it — that
 * judgement is the feature.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, inferenceUsage } from '@/src/db';

const log = createLogger('kernel:inference:spend-cap');

export type SpendCapPeriod = 'daily' | 'monthly' | 'total';

export interface SpendCap {
  amountUsd: number;
  period: SpendCapPeriod;
}

const VALID_PERIODS: readonly SpendCapPeriod[] = ['daily', 'monthly', 'total'];

/**
 * Parse the JSONB `spend_cap` column into a typed cap, or `undefined` when
 * absent or malformed. A malformed cap is logged and treated as "no cap"
 * (fail open) — this is a budget guard, not a credential gate, so refusing
 * every call over a bad JSONB value would be a worse outcome than the owner
 * quietly needing to re-save it.
 */
export function parseSpendCap(raw: unknown): SpendCap | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object') return undefined;

  const value = raw as Record<string, unknown>;
  const amountUsd = value.amountUsd;
  const period = value.period;

  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    log.warn({ raw }, 'spend cap: malformed amountUsd — treating as no cap');
    return undefined;
  }
  if (typeof period !== 'string' || !VALID_PERIODS.includes(period as SpendCapPeriod)) {
    log.warn({ raw }, 'spend cap: malformed period — treating as no cap');
    return undefined;
  }

  return { amountUsd, period: period as SpendCapPeriod };
}

/** Serialize a cap back to the JSONB shape stored on `kernel.connectors.spend_cap`. */
export function serializeSpendCap(cap: SpendCap): Record<string, unknown> {
  return { amountUsd: cap.amountUsd, period: cap.period };
}

/** Start of the current window for a cap's period, or `undefined` for `'total'` (no window). */
function periodStart(period: SpendCapPeriod, now: Date): Date | undefined {
  if (period === 'daily') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (period === 'monthly') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return undefined;
}

/**
 * Sum `inference.usage.cost_usd` for one connector registration within the
 * cap's current window. Rows with a null cost (usage recorded without a
 * computable price) do not contribute — they were never billed against the
 * cap in the first place.
 */
async function spentUsd(connectorId: string, cap: SpendCap, now: Date): Promise<number> {
  const start = periodStart(cap.period, now);
  const conditions = [eq(inferenceUsage.connectorId, connectorId)];
  if (start) conditions.push(gte(inferenceUsage.createdAt, start));

  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${inferenceUsage.costUsd}), 0)` })
    .from(inferenceUsage)
    .where(and(...conditions));

  return Number(rows[0]?.total ?? 0);
}

export interface SpendCapCheck {
  exceeded: boolean;
  cap: SpendCap;
  spentUsd: number;
}

/**
 * Check whether `connectorId`'s accumulated spend has already reached or
 * passed `cap`. Returns `undefined` when the check itself could not be
 * performed (fail open — see module doc).
 */
export async function checkSpendCap(connectorId: string, cap: SpendCap): Promise<SpendCapCheck | undefined> {
  try {
    const spent = await spentUsd(connectorId, cap, new Date());
    return { exceeded: spent >= cap.amountUsd, cap, spentUsd: spent };
  } catch (err) {
    log.warn({ err: String(err), connectorId }, 'spend cap: usage query failed — allowing the call through');
    return undefined;
  }
}

/** Thrown when a connector's declared spend cap has already been reached. */
export class SpendCapExceededError extends Error {
  readonly connectorId: string;
  readonly cap: SpendCap;
  readonly spentUsd: number;

  constructor(connectorId: string, cap: SpendCap, spentUsd: number) {
    super(
      `spend_cap_exceeded: connector has spent $${spentUsd.toFixed(2)} of its ` +
      `$${cap.amountUsd.toFixed(2)} ${cap.period} cap — refusing further calls until the window resets ` +
      `or the cap is raised.`,
    );
    this.name = 'SpendCapExceededError';
    this.connectorId = connectorId;
    this.cap = cap;
    this.spentUsd = spentUsd;
  }
}

/**
 * Enforce a connector's spend cap, throwing {@link SpendCapExceededError}
 * when it has already been reached. A no-op when `rawSpendCap` is absent or
 * malformed (parsed to `undefined`) — no cap declared means no limit.
 */
export async function enforceSpendCap(connectorId: string, rawSpendCap: unknown): Promise<void> {
  const cap = parseSpendCap(rawSpendCap);
  if (!cap) return;

  const result = await checkSpendCap(connectorId, cap);
  if (result?.exceeded) {
    throw new SpendCapExceededError(connectorId, result.cap, result.spentUsd);
  }
}
