/**
 * Rail-keyed payment-processor fee lookup (#2177 item 2, parent #2173).
 *
 * The attribution package never names a payment rail in its logic: every
 * fee a manifest or a settlement needs is looked up here BY RAIL KEY, from
 * one table. Adding a rail is one row in {@link PROCESSOR_FEE_SCHEDULES} —
 * `buildManifest`, `settlement`, and `templates` stay untouched.
 *
 * This module is PURE — no DB, HTTP, or environment-variable reads.
 *
 * Fee schedules are ESTIMATES (actual fees vary by card type / corridor).
 * The default rail uses its international rate as a safe estimate to avoid
 * platform losses; the rail's webhook adapter reconciles against the actual
 * fee after the fact.
 */
import type { FairFee } from './types';

/** Fee schedule for one rail: `amount * rateBps / 10_000 + fixedCents`. */
export interface ProcessorFeeSchedule {
  /** Human-readable processor name, written into manifest `fees[].name`. */
  readonly name: string;
  /** Estimate rate in basis points (1 bps = 0.01%) — the safe, high-side rate. */
  readonly rateBps: number;
  /** Lowest rate the rail charges (e.g. domestic cards) — informational, written into `fees[].minRateBps`. */
  readonly minRateBps: number;
  /** Fixed per-transaction fee in minor units (cents). */
  readonly fixedCents: number;
}

/**
 * The rail whose schedule applies when a caller does not name one. This is
 * the only place the default is chosen; changing it re-keys every default
 * manifest and the settlement fallback at once.
 */
export const DEFAULT_PROCESSOR_RAIL = 'stripe';

/** The lookup table — rail key → fee schedule. */
const PROCESSOR_FEE_SCHEDULES: ReadonlyMap<string, ProcessorFeeSchedule> = new Map([
  [
    DEFAULT_PROCESSOR_RAIL,
    {
      name: 'Stripe',
      rateBps: 370, //     3.7% (domestic 2.9% + international 0.8%)
      minRateBps: 290, //  2.9% (domestic cards)
      fixedCents: 30, //   CA$0.30 per transaction
    },
  ],
]);

/**
 * Compute a fee in cents: `amountCents * rateBps / 10_000 + fixedCents`.
 *
 * @param amountCents - Transaction total in minor units (cents).
 * @param rateBps     - Fee rate in basis points (1 bps = 0.01%).
 * @param fixedCents  - Fixed per-transaction fee in minor units (cents).
 * @returns Fee amount in cents (unrounded — caller decides rounding).
 */
export function computeFeeCents(
  amountCents: number,
  rateBps: number,
  fixedCents: number,
): number {
  return (amountCents * rateBps) / 10_000 + fixedCents;
}

/** The fee schedule registered for `rail`, or `undefined` when the rail is unknown. */
export function processorFeeSchedule(rail: string): ProcessorFeeSchedule | undefined {
  return PROCESSOR_FEE_SCHEDULES.get(rail);
}

function requireSchedule(rail: string): ProcessorFeeSchedule {
  const schedule = PROCESSOR_FEE_SCHEDULES.get(rail);
  if (!schedule) {
    throw new Error(`processorFee: no fee schedule registered for rail "${rail}"`);
  }
  return schedule;
}

/**
 * Estimated processor fee for charging `amountCents` over `rail`, in cents,
 * UNROUNDED (the settlement path rounds once, at the dollar boundary).
 *
 * @throws when `rail` has no registered schedule.
 */
export function processorFee(rail: string, amountCents: number): number {
  const { rateBps, fixedCents } = requireSchedule(rail);
  return computeFeeCents(amountCents, rateBps, fixedCents);
}

/**
 * Estimated processor fee in WHOLE cents: the percentage part is rounded,
 * then the fixed part is added — the integer-cent expression the checkout /
 * webhook paths have always used.
 *
 * @throws when `rail` has no registered schedule.
 */
export function processorFeeCents(rail: string, amountCents: number): number {
  const { rateBps, fixedCents } = requireSchedule(rail);
  return Math.round((amountCents * rateBps) / 10_000) + fixedCents;
}

/**
 * The charge (cents) that leaves `netCents` after the rail's processor fee —
 * i.e. `ceil((net + fixed) / (1 - rate))`. Used when the payer absorbs fees.
 *
 * @throws when `rail` has no registered schedule.
 */
export function grossUpForProcessorFee(rail: string, netCents: number): number {
  const { rateBps, fixedCents } = requireSchedule(rail);
  return Math.ceil((netCents + fixedCents) / (1 - rateBps / 10_000));
}

/**
 * The manifest `fees[]` entry for `rail` (role `processor`).
 *
 * @throws when `rail` has no registered schedule.
 */
export function processorFeeEntry(rail: string = DEFAULT_PROCESSOR_RAIL): FairFee {
  const { name, rateBps, minRateBps, fixedCents } = requireSchedule(rail);
  return { role: 'processor', name, rateBps, minRateBps, fixedCents };
}
