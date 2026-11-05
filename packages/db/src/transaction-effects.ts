import { AsyncLocalStorage } from 'node:async_hooks';

interface Effects {
  active: boolean;
  tasks: Array<() => Promise<unknown>>;
}
const STORAGE = Symbol.for('imajin.db.transaction-effects');
const shared = globalThis as typeof globalThis & { [STORAGE]?: AsyncLocalStorage<Effects> };
const storage = shared[STORAGE] ??= new AsyncLocalStorage<Effects>();

/** Return true when queued; never await a self-request while holding a pool slot. */
export function deferAfterCommit(task: () => Promise<unknown>): boolean {
  const context = storage.getStore();
  if (!context) return false;
  if (!context.active) throw new Error('DB_TRANSACTION_COMPLETE');
  context.tasks.push(task);
  return true;
}

export function transactionEffects() {
  const parent = storage.getStore();
  const context: Effects = { active: true, tasks: [] };
  return {
    run<T>(work: () => T): T { return storage.run(context, work); },
    isActive() { return context.active; },
    close() { context.active = false; },
    async committed() {
      context.active = false;
      if (parent) {
        if (!parent.active) throw new Error('DB_TRANSACTION_COMPLETE');
        parent.tasks.push(...context.tasks);
      } else {
        // No pool connection or transaction is retained here.
        for (const task of context.tasks) await task();
      }
    },
  };
}
