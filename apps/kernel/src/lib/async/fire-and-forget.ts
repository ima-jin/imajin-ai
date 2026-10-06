/**
 * Explicit fire-and-forget for promises that nobody awaits (event handlers,
 * effects, timers). Satisfies typescript:S9383 without changing behaviour:
 * the work still runs unawaited, but a rejection is logged instead of
 * becoming an unhandled promise rejection.
 *
 * Usage: `fireAndForget(loadData(), 'profile:loadData')`
 */
export function fireAndForget(task: PromiseLike<unknown>, context: string): void {
  void Promise.resolve(task).then(undefined, (err: unknown) => {
    console.error(`[${context}] unhandled async error`, err);
  });
}
