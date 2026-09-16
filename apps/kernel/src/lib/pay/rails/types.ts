/**
 * `WithdrawRail` adapter interface (#2172 design amendment).
 *
 * Withdraw is a settlement-primitive concept; Stripe is one rail among
 * several the platform will eventually support (EMT manual withdrawal,
 * Solana Pay / x402, Lightning — see the issue's refs). Every kernel code
 * path that reserves, executes, or reconciles a withdrawal talks to this
 * interface only — never to a rail SDK directly. The Stripe SDK itself may
 * only be imported under `apps/kernel/src/lib/pay/providers/` (enforced by
 * `scripts/ci-guard-stripe-import-scope.mjs`).
 */
import type { Unit } from '../ledger';

/**
 * The intent record an adapter's `execute()` is asked to fulfil.
 *
 * `destination` is a deliberately rail-agnostic, NOT-persisted runtime hint
 * (e.g. a Stripe connected account id) supplied by the caller at request
 * time — see `apps/kernel/app/pay/api/balance/withdraw/route.ts`. It is
 * never written to `pay.withdrawal_intents`, which stays free of any
 * rail-specific column per the design amendment.
 */
export interface WithdrawalIntent {
  id: string;
  did: string;
  unit: Unit;
  /** Numeric string — mirrors every other ledger amount in this codebase. */
  amount: string;
  rail: string;
  /** Passed to the adapter's native idempotency mechanism (e.g. Stripe's `idempotencyKey`). Equal to `id` — see `reserveWithdrawal` in `../withdraw-intent`. */
  idempotencyKey: string;
  /** Rail-specific destination hint, not persisted. Optional because not every rail needs one (e.g. a rail that resolves its own destination from `did`). */
  destination?: string;
  /** Fiat currency code for the external transfer (e.g. 'CAD'), as supplied on the original request. Not persisted — `pay.withdrawal_intents` carries only `unit`. Defaults to 'CAD' when omitted, matching the pre-#2172 route's default. */
  currency?: string;
}

/** Result of a successful `execute()` call. */
export interface WithdrawRailExecuteResult {
  /** Opaque external transfer reference — the kernel never interprets this. */
  externalRef: string;
}

/** One entry in a rail's transfer feed, as reported by `list()`. */
export interface RailTransfer {
  externalRef: string;
  /** The withdrawal intent id this transfer was tagged with, when the rail can report it (e.g. Stripe transfer metadata). `null` when the rail has no way to report it, or the transfer predates this intent system. */
  intentId: string | null;
  amount: number;
  unit: string;
  createdAt: Date;
}

export interface ListTransfersParams {
  /** Only return transfers created at or after this instant. */
  since: Date;
}

/**
 * A withdrawal payment rail. Implementations own everything rail-specific
 * (SDK client, credential lookup, wire format) behind these three methods.
 */
export interface WithdrawRail {
  /** Stable adapter name — matches `pay.withdrawal_intents.rail` / `pay.reconciliation_watermarks.rail`. */
  readonly name: string;

  /**
   * Execute the external transfer for an already-reserved intent. Must be
   * idempotent on `intent.idempotencyKey`: calling this twice for the same
   * intent must never produce a second real transfer. Throws on failure —
   * callers are responsible for releasing the reservation.
   */
  execute(intent: WithdrawalIntent): Promise<WithdrawRailExecuteResult>;

  /** List this rail's transfers since a given instant — the reconciliation feed. */
  list(params: ListTransfersParams): Promise<RailTransfer[]>;

  /**
   * Parse a rail-native webhook payload and return the withdrawal intent id
   * (plus the external transfer ref the event confirms it against) it
   * confirms, or `null` if the payload isn't a transfer-confirmation event
   * this rail recognizes. Never throws on an unrecognized shape.
   *
   * Returns the ref alongside the intent id (a small, deliberate widening
   * of the design amendment's `confirmFromEvent(payload) -> intentId | null`
   * sketch) because the webhook fast path needs it to call
   * `confirmWithdrawal` — without it, the caller would have to re-derive
   * the same rail-specific event shape the adapter already parsed.
   */
  confirmFromEvent(payload: unknown): Promise<{ intentId: string; externalRef: string } | null>;
}
