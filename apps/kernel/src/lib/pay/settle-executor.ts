/**
 * Kernel hook-up for the bus `settle` reactor (#2642).
 *
 * `packages/bus` must not import `apps/kernel`, so the reactor cannot call
 * `settlePayment()` itself. Instead the kernel injects it at boot through the
 * bus's `registerSettleExecutor()` hook — the reactor then settles in-process,
 * with no HTTP hop to `/pay/api/settle` and no shared `PAY_SERVICE_API_KEY`.
 *
 * Called from `instrumentation.ts` at server boot. Idempotent, and cheap enough
 * for the kernel's own publishers of settle-chained events to call again
 * (`ensureSettleExecutorRegistered`) as a belt-and-braces guard.
 */
import { registerSettleExecutor, getSettleExecutor, type SettleExecutor } from '@imajin/bus';
import { settlePayment } from './settle-core';

/** The executor handed to the bus: the canonical settlement primitive, unchanged. */
export const kernelSettleExecutor: SettleExecutor = (params) => settlePayment(params);

/** Register the kernel's in-process settle executor with the bus. Idempotent. */
export function ensureSettleExecutorRegistered(): void {
  if (getSettleExecutor() === kernelSettleExecutor) return;
  registerSettleExecutor(kernelSettleExecutor);
}
