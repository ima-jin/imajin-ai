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
import type { WithdrawDestinationResolutionMode } from '../withdraw-destination';

/**
 * The intent record an adapter's `execute()` is asked to fulfil.
 *
 * `destination` is a deliberately rail-agnostic, NOT-persisted runtime hint
 * (e.g. a Stripe connected account id) supplied by the caller at request
 * time — see `apps/kernel/app/pay/api/balance/withdraw/route.ts`. It is
 * never written to `pay.withdrawal_intents`, which stays free of any
 * rail-specific column per the design amendment.
 *
 * #2190: `destination` is now always resolved SERVER-SIDE (never the raw
 * client-supplied value — see `../withdraw-destination.ts`), and
 * `resolutionMode` records how, so the record of what the kernel actually
 * did survives into `confirmWithdrawal`'s transaction metadata even though
 * neither field is persisted on the intent row itself.
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
  /** How `destination` was resolved (#2190) — `'default'` when the caller omitted `account_id` and the DID's own connected account was used, `'selected'` when the caller named an `account_id` that was verified to belong to the DID. Not persisted — carried into `confirmWithdrawal`'s transaction metadata instead. */
  resolutionMode?: WithdrawDestinationResolutionMode;
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
 * Rail-neutral webhook event (#2175 design amendment).
 *
 * The normalized shape every rail's webhook adapter emits from a raw,
 * provider-verified delivery — e.g. `providers/stripe-webhook.ts`'s
 * `toRailEvent()`. Callers outside a `providers/` adapter (the pay webhook
 * routes, `webhook-handlers.ts`) consume only this shape; they never see
 * the rail's native SDK event type. `raw` carries the rail-native event's
 * inner entity (e.g. a Stripe checkout session or payment intent) as a
 * generic, JSON-safe bag — callers cast it to one of the `*Like` interfaces
 * in `../webhook-event-shapes.ts` for the fields they need.
 */
export interface RailEvent {
  /** Stable adapter name, matching `WithdrawRail.name` (e.g. `'stripe'`). */
  rail: string;
  /** The rail-native event type string (e.g. `'checkout.session.completed'`). */
  type: string;
  /** Opaque external reference for the event's subject entity (e.g. a checkout session or payment intent id), or `null` when the entity carries none. */
  externalRef: string | null;
  /** Amount in minor units (e.g. cents), or `null` when not applicable to this event type. */
  amount: number | null;
  /** ISO currency code as reported by the rail, or `null` when not applicable. */
  currency: string | null;
  /** The rail-native event's inner entity, as a generic JSON-safe bag. */
  raw: Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// Pay-in direction (#2665)
//
// `WithdrawRail` above is the OUT direction (reserve -> execute -> reconcile).
// `PayInRail` is the IN direction: how a payer funds a payment. A rail keeps
// ONE stable `name` across both directions (EMT is `'emt'` here and will be
// `'emt'` as a `WithdrawRail` under #2014), so `pay.withdrawal_intents.rail`,
// `settlement_ref.method` and the registry key all agree on what the rail is.
// The two interfaces are deliberately separate: a manual rail like EMT has
// no webhook, feed or SDK, so it implements only the direction it supports.
// ---------------------------------------------------------------------------

/**
 * What the pay-in rail is asked to give a payer instructions for. Amounts
 * are integer minor units (cents), per `packages/money` — never floats.
 */
export interface PayInRequest {
  /** Rail-neutral reference the payer must quote so the receiver can match the deposit (EMT: the transfer memo). Unique to the thing being paid. */
  reference: string;
  /** Exact amount owed, in minor units. */
  amountMinor: number;
  /** ISO currency code, uppercase. */
  currency: string;
}

/**
 * What a payer is shown to fund a payment. `destination` is rail-specific
 * and deliberately a plain string (EMT: the receiving email) — the same
 * shape as `WithdrawalIntent.destination`, so the two directions can share a
 * destination vocabulary under #2014.
 */
export interface PayInInstructions {
  rail: string;
  destination: string;
  amountMinor: number;
  currency: string;
  reference: string;
}

/** A manifest `fees[]` entry, as `resolveSettlementChain` reads it. */
export interface PayInFeeEntry {
  role: string;
  rateBps: number;
  fixedCents: number;
}

/**
 * A pay-in payment rail. Implementations own everything rail-specific
 * (instruction format, accepted currencies, fee schedule) behind this
 * interface; callers (payment requests today, the events app later) never
 * branch on the rail name.
 */
export interface PayInRail {
  /** Stable adapter name — equals the `WithdrawRail.name` for the same rail, and `settlement_ref.method`. */
  readonly name: string;
  /** ISO currencies this rail can collect. */
  readonly currencies: readonly string[];
  /** `'manual'` = a human confirms receipt (no webhook); `'automatic'` = the rail reports it. */
  readonly confirmation: 'manual' | 'automatic';
  /** Whether this rail can collect `currency`. */
  supportsCurrency(currency: string): boolean;
  /** The instructions a payer needs to fund `request` into `destination`. Pure. */
  instructionsFor(request: PayInRequest, destination: string): PayInInstructions;
  /**
   * The `fees[]` to settle a manifest with when paid over this rail: the
   * manifest's own entries with its `processor` entry replaced by this
   * rail's schedule. A manifest is built against the default (card) rail's
   * fee, which must never be charged on a rail that does not incur it.
   */
  settlementFees(manifestFees: readonly PayInFeeEntry[] | undefined): PayInFeeEntry[];
}
