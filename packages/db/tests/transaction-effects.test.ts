import { expect, it, vi } from 'vitest';
import { deferAfterCommit, transactionEffects } from '../src/transaction-effects';

it('keeps deferred delivery sequential without overlapping tasks', async () => {
  const effects = transactionEffects();
  const order: string[] = [];
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  effects.run(() => {
    deferAfterCommit(() => first.then(() => { order.push('first'); }));
    deferAfterCommit(() => { order.push('second'); return Promise.resolve(); });
  });
  effects.close();
  const pending = effects.committed();
  await Promise.resolve();
  expect(order).toEqual([]);
  release();
  await pending;
  expect(order).toEqual(['first', 'second']);
});

it('does not defer ordinary out-of-transaction work', () => {
  const work = vi.fn();
  expect(deferAfterCommit(work)).toBe(false);
  expect(work).not.toHaveBeenCalled();
});
it('runs queued work only after commit, outside the transaction context', async () => {
  const effects = transactionEffects();
  const work = vi.fn(async () => {
    expect(deferAfterCommit(vi.fn())).toBe(false);
  });
  await effects.run(async () => {
    await Promise.resolve();
    expect(deferAfterCommit(work)).toBe(true);
  });
  effects.close();
  expect(work).not.toHaveBeenCalled();
  await effects.committed();
  expect(work).toHaveBeenCalledOnce();
});
it('merges savepoint effects into the outer transaction rather than delivering early', async () => {
  const outer = transactionEffects();
  const work = vi.fn();
  await outer.run(async () => {
    const inner = transactionEffects();
    inner.run(() => deferAfterCommit(work));
    inner.close();
    await inner.committed();
    expect(work).not.toHaveBeenCalled();
  });
  outer.close();
  await outer.committed();
  expect(work).toHaveBeenCalledOnce();
});
it('refuses side effects from a callback continuing after timeout or rollback', async () => {
  const effects = transactionEffects();
  let late!: () => void;
  effects.run(() => { late = () => deferAfterCommit(vi.fn()); });
  effects.close();
  effects.run(() => expect(late).toThrow('DB_TRANSACTION_COMPLETE'));
});
it('does not attach savepoint effects to an expired parent', async () => {
  const outer = transactionEffects();
  const inner = outer.run(() => transactionEffects());
  outer.close();
  await expect(inner.committed()).rejects.toThrow('DB_TRANSACTION_COMPLETE');
});
