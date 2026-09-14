/**
 * Rail registry (#2172 design amendment, point 4): "which rails are enabled
 * per unit is a config row... so adding a rail is an adapter + a row" —
 * this is that row, in-memory today (the same shape `bus_chain_configs`
 * eventually grew a DB-backed override for). No `switch (rail)` statement
 * anywhere else in the withdraw/reconciliation code — every call site asks
 * this registry for a rail by name or by unit.
 */
import type { Unit } from '../ledger';
import type { WithdrawRail } from './types';
import { StripeWithdrawRail, STRIPE_RAIL_NAME } from '../providers/stripe-withdraw-rail';

export interface RailRegistryEntry {
  /** Lazily constructed — mirrors `getStripe()`'s own lazy init, so importing the registry never requires `STRIPE_SECRET_KEY` to be set (e.g. in tests that never call `execute`/`list`). */
  getRail: () => WithdrawRail;
  enabledUnits: readonly Unit[];
}

let stripeRailSingleton: StripeWithdrawRail | null = null;
function getStripeRail(): StripeWithdrawRail {
  return (stripeRailSingleton ??= new StripeWithdrawRail());
}

/**
 * The registry itself. Adding a new rail (EMT under #2014, Solana Pay/x402
 * under #2013, Lightning) is an adapter class + one entry here — never a
 * change to the withdraw route, `withdraw-intent.ts`, or the reconciler.
 */
const REGISTRY: Record<string, RailRegistryEntry> = {
  [STRIPE_RAIL_NAME]: { getRail: getStripeRail, enabledUnits: ['MJN'] },
};

/** Look up a rail by its registered name, regardless of unit. */
export function getWithdrawRailByName(rail: string): WithdrawRail | null {
  return REGISTRY[rail]?.getRail() ?? null;
}

/** Resolve a rail by name, but only if it's enabled for the given unit. */
export function getWithdrawRail(rail: string, unit: Unit): WithdrawRail | null {
  const entry = REGISTRY[rail];
  if (!entry || !entry.enabledUnits.includes(unit)) return null;
  return entry.getRail();
}

/** The rail a withdrawal of this unit should use when the caller doesn't name one explicitly — today, exactly one rail is enabled per unit. */
export function defaultRailForUnit(unit: Unit): WithdrawRail | null {
  for (const entry of Object.values(REGISTRY)) {
    if (entry.enabledUnits.includes(unit)) return entry.getRail();
  }
  return null;
}

/** Every registered rail, regardless of unit — used by the reconciliation sweep, which iterates all rails. */
export function listRegisteredRails(): WithdrawRail[] {
  return Object.values(REGISTRY).map((entry) => entry.getRail());
}
