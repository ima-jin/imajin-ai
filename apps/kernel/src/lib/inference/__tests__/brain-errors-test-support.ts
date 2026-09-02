/**
 * Shared test support for mocking `@/src/lib/inference/brain`'s error types.
 *
 * `brain.ts` pulls in a real drizzle client plus connector modules purely to
 * build error messages. Callers only need the error TYPES for `instanceof`
 * matching, so this re-implements just enough shape to avoid a live DB client
 * at test-import time. Declared once here rather than copied into every
 * route/adapter test that needs to simulate a brain-resolution failure.
 */
export function createFakeBrainErrorClasses() {
  class NoBrainSealedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NoBrainSealedError';
    }
  }
  class NoModelSelectedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NoModelSelectedError';
    }
  }
  class ModelDeprecatedError extends Error {
    readonly connector: string;
    readonly modelId: string;
    constructor(connector: string, modelId: string) {
      super(`model_deprecated: ${connector} model '${modelId}' was not found upstream`);
      this.name = 'ModelDeprecatedError';
      this.connector = connector;
      this.modelId = modelId;
    }
  }
  return { NoBrainSealedError, NoModelSelectedError, ModelDeprecatedError };
}

/**
 * Shared test support for mocking `@/src/lib/inference/spend-cap` (#1923).
 *
 * That module pulls in `@/src/db` (a real drizzle client) to sum
 * `usage.incurred` rows. Callers only need `SpendCapExceededError`'s TYPE
 * shape for `instanceof` matching in `brain-http-errors.ts`, so this
 * re-implements it rather than importing the real module at test-import time.
 */
export function createFakeSpendCapClasses() {
  class SpendCapExceededError extends Error {
    readonly connectorId: string;
    readonly cap: { amountUsd: number; period: string };
    readonly spentUsd: number;
    constructor(connectorId: string, cap: { amountUsd: number; period: string }, spentUsd: number) {
      super(`spend_cap_exceeded: spent $${spentUsd} of $${cap.amountUsd} ${cap.period} cap`);
      this.name = 'SpendCapExceededError';
      this.connectorId = connectorId;
      this.cap = cap;
      this.spentUsd = spentUsd;
    }
  }
  return { SpendCapExceededError, enforceSpendCap: async () => undefined };
}
