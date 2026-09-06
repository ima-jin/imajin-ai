/**
 * Shared `db.insert`/`db.transaction` test-double reset for
 * `confirmReceiptLines` (#1951). Factored out once because
 * `receipt.test.ts` (full mock of `@imajin/money`) and
 * `receipt-fx-aggregate.test.ts` (real `@imajin/money` math, only `getRate`
 * stubbed) otherwise repeat this `beforeEach` wiring verbatim.
 *
 * The `vi.fn()` creation itself stays inline in each test file's
 * `vi.hoisted()` block rather than being factored in here too:
 * `vi.hoisted` callbacks run before this module's imports are linked, so a
 * call into an imported factory from inside `vi.hoisted` throws a TDZ
 * `ReferenceError` — only code that runs later (e.g. this `beforeEach`
 * helper) can safely reference an imported symbol.
 */
import type { Mock } from 'vitest';

export interface InsertTransactionDouble {
  insert: Mock;
  insertValues: Mock;
  transaction: Mock;
}

export function resetInsertTransactionDouble(double: InsertTransactionDouble): void {
  double.insert.mockImplementation(() => ({ values: double.insertValues }));
  double.transaction.mockImplementation(async (fn: (tx: { insert: typeof double.insert }) => Promise<void>) =>
    fn({ insert: double.insert }),
  );
  double.insertValues.mockResolvedValue(undefined);
}
