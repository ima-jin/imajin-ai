import { describe, it, expect, vi } from 'vitest';

// `../registry` -> `../../providers/stripe-withdraw-rail` -> `../../ledger`
// (for the `Unit` type) -> `@/src/db`, which eagerly constructs a real DB
// client at import time unless stubbed — same reason every other pay suite
// in this codebase mocks `@/src/db`.
vi.mock('@/src/db', () => ({ db: {}, balances: {}, transactions: {}, withdrawalIntents: {} }));

import { getWithdrawRail, getWithdrawRailByName, defaultRailForUnit, listRegisteredRails } from '../registry';
import { STRIPE_RAIL_NAME } from '../../providers/stripe-withdraw-rail';
import { MJN, MJNX } from '../../ledger';

describe('rail registry (#2172 design amendment point 4: config-driven, not a switch statement)', () => {
  it('resolves the stripe rail for MJN', () => {
    const rail = getWithdrawRail(STRIPE_RAIL_NAME, MJN);
    expect(rail?.name).toBe(STRIPE_RAIL_NAME);
  });

  it('does not enable stripe for MJNx (MJNx is never withdrawable)', () => {
    expect(getWithdrawRail(STRIPE_RAIL_NAME, MJNX)).toBeNull();
  });

  it('returns null for an unregistered rail name', () => {
    expect(getWithdrawRail('does-not-exist', MJN)).toBeNull();
  });

  it('getWithdrawRailByName ignores unit enablement', () => {
    expect(getWithdrawRailByName(STRIPE_RAIL_NAME)?.name).toBe(STRIPE_RAIL_NAME);
    expect(getWithdrawRailByName('does-not-exist')).toBeNull();
  });

  it('defaultRailForUnit resolves the only rail enabled for MJN, and none for MJNx', () => {
    expect(defaultRailForUnit(MJN)?.name).toBe(STRIPE_RAIL_NAME);
    expect(defaultRailForUnit(MJNX)).toBeNull();
  });

  it('listRegisteredRails returns every registered rail exactly once, as a stable singleton', () => {
    const rails = listRegisteredRails();
    expect(rails.map((r) => r.name)).toEqual([STRIPE_RAIL_NAME]);
    expect(listRegisteredRails()[0]).toBe(rails[0]); // lazy singleton, not reconstructed per call
  });
});
