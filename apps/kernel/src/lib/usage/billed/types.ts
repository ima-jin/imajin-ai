/**
 * Shared shape for provider billing adapters (#1076 Stage 1).
 *
 * Each adapter pulls ONE provider's own usage/cost admin API and normalizes
 * it into `BilledLine[]` — line items destined for `usage.billed`, the
 * counterparty's statement (see migrations/0122_usage_billed.sql for the
 * full framing note). Never merged into `usage.incurred`.
 */

/** The two granularities the daily ingestion job pulls (#1076 Stage 1). */
export type BilledGranularity = 'day' | 'month';

/** One reporting window to pull a provider's statement for. */
export interface BilledPeriod {
  start: Date;
  end: Date;
}

/**
 * One normalized line item, ready to upsert into `usage.billed`.
 *
 * `model` is nullable: a provider's cost endpoint does not always support a
 * per-model breakdown (OpenAI's `/organization/costs` cannot group by model
 * at all — only its usage endpoint can), so an adapter may emit an
 * aggregate, org-wide line (`model: null`) alongside per-model lines that
 * carry tokens but no cost. `tokensIn`/`tokensOut`/`billedUsd` are
 * independently nullable for the same reason: a line may know tokens without
 * cost, cost without tokens, or (rarely) neither.
 */
export interface BilledLine {
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  billedUsd: number | null;
  /** The provider's own line item(s) this row was derived from, verbatim. */
  raw: unknown;
}

/**
 * Typed error for an authentication/authorization failure against a
 * provider's billing API (401/403) — a missing or insufficiently-scoped
 * admin key. The daily ingestion job (#1076 Stage 1) catches this
 * specifically to log and skip the provider for that principal, rather than
 * crashing the whole sweep the way an unexpected error would.
 */
export class BillingApiError extends Error {
  readonly provider: string;
  readonly status: number;

  constructor(provider: string, status: number, message: string) {
    super(message);
    this.name = 'BillingApiError';
    this.provider = provider;
    this.status = status;
  }

  /** True for 401 (missing/invalid key) or 403 (insufficient scope). */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * One provider's billing-statement reader. `fetch` pulls and normalizes the
 * provider's own line items for `period` at `granularity`, paginating
 * internally so the caller always gets the complete window in one call.
 *
 * Throws {@link BillingApiError} on a non-2xx response — the caller decides
 * whether to fail-open (401/403) or propagate (anything else, e.g. 5xx or
 * malformed response).
 */
export interface BilledUsageReader {
  readonly provider: string;
  fetch(period: BilledPeriod, granularity: BilledGranularity): Promise<BilledLine[]>;
}
