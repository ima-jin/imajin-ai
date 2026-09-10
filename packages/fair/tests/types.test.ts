/**
 * Type-level tests for the `.fair` entry shape collapse (#1712).
 *
 * `FairEntry` used to be redeclared four times: twice "canonically" in this
 * package (`FairEntry` and `DidShareEntry`, which were structurally
 * identical) and twice more as hand-maintained narrowings in
 * `apps/market/src/lib/settle.ts` and `packages/bus/src/reactors/settle.ts`.
 * `FairEntry` is now the single canonical shape — `DidShareEntry` no longer
 * exists as its own declaration, `DidShareList` is just `FairEntry[]`, and
 * `FairSettlementEntry` (consumed by both settle.ts files) is a `Pick`
 * derived from `FairEntry`.
 *
 * `expectTypeOf` is a documentation-and-IDE-time check here — per Vitest's
 * own docs it is a no-op under plain `vitest run` and only actually fails a
 * build under `vitest --typecheck` (see https://vitest.dev/api/expect-typeof).
 * The assertion this repo's `pnpm typecheck` (`tsc --noEmit`) actually
 * enforces is the `_FairSettlementEntryAssignableFromFairEntry` generic
 * constraint in `../src/settlement.ts`, which fails to compile if
 * `FairSettlementEntry` ever stops being assignable from a resolved
 * `FairEntry`.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { FairEntry, DidShareList, FairManifestV10, FairManifestV11 } from '../src/types';
import type { FairSettlementEntry } from '../src/settlement';

describe('.fair entry shape (#1712)', () => {
  it('DidShareList is just FairEntry[] — no second hand-maintained entry shape', () => {
    expectTypeOf<DidShareList>().toEqualTypeOf<FairEntry[]>();
  });

  it('both manifest versions carry the same entry shape in attribution/chain/distributions', () => {
    expectTypeOf<FairManifestV10['attribution']>().toEqualTypeOf<FairEntry[]>();
    expectTypeOf<NonNullable<FairManifestV10['chain']>>().toEqualTypeOf<FairEntry[]>();
    expectTypeOf<FairManifestV11['attribution']>().toEqualTypeOf<FairEntry[]>();
  });

  it('FairSettlementEntry (used by apps/market and packages/bus settle.ts) is assignable from a resolved FairEntry', () => {
    // A fully-resolved FairEntry (did always present) must satisfy
    // FairSettlementEntry — this is what lets both settle.ts files consume
    // real .fair entries without a hand-rolled narrowing of their own.
    expectTypeOf<Required<Pick<FairEntry, 'did' | 'role' | 'share'>>>().toExtend<FairSettlementEntry>();
  });
});
