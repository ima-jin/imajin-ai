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
