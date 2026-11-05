import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundSql, timeoutSetting } from '../src/bounds';

const bounds = { acquireMs: 100, queryMs: 400 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(assigned = false) {
  const pending = deferred<unknown>();
  const query = Object.assign(pending.promise, {
    state: assigned ? {} : null,
    cancel: vi.fn(() => pending.reject(new Error('cancelled'))),
    values() { return this; },
    raw() { return this; },
  });
  const sql = Object.assign(vi.fn(() => query), { unsafe: vi.fn(() => query) });
  return { ...pending, query, sql: sql as unknown as ReturnType<typeof postgres> };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('shared DB bounds', () => {
  it.each(['-1', 'NaN', '', '1.5', '1e4', 'Infinity', '9007199254740992'])('rejects invalid setting %s', value => {
    expect(() => timeoutSetting({ TIMEOUT: value }, 'TIMEOUT', 100)).toThrow('non-negative integer');
  });
  it('allows explicit zero opt-out and a positive override', () => {
    expect(timeoutSetting({}, 'TIMEOUT', 100)).toBe(100);
    expect(timeoutSetting({ TIMEOUT: '0' }, 'TIMEOUT', 100)).toBe(0);
    expect(timeoutSetting({ TIMEOUT: '250' }, 'TIMEOUT', 100)).toBe(250);
  });
  it('rejects queued work within the acquire bound and cancels it', async () => {
    const f = fixture();
    const sql = boundSql(f.sql, bounds);
    const pending = expect(sql.unsafe('SELECT 1').values()).rejects.toMatchObject({ code: 'DB_ACQUIRE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    expect(f.query.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the total query bound for assigned work and cancels a stalled response', async () => {
    const f = fixture(true);
    const pending = expect(boundSql(f.sql, bounds)`SELECT 1`).rejects.toMatchObject({ code: 'DB_QUERY_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(101);
    expect(f.query.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(f.query.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps queries lazy, chainable, reusable, and cleans timers after success', async () => {
    const f = fixture();
    const query = boundSql(f.sql, bounds).unsafe('SELECT 1').raw();
    expect(vi.getTimerCount()).toBe(0);
    const first = Promise.resolve(query);
    await vi.advanceTimersByTimeAsync(0);
    f.resolve([{ value: 1 }]);
    expect(await first).toEqual([{ value: 1 }]);
    expect(await query).toEqual([{ value: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('supports catch/finally/execute and explicit client opt-out', async () => {
    const f = fixture(true);
    const query = boundSql(f.sql, { acquireMs: 0, queryMs: 0 }).unsafe('SELECT 1').execute();
    const done = vi.fn();
    const pending = query.catch(() => []).finally(done);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.query.cancel).not.toHaveBeenCalled();
    f.reject(new Error('failure'));
    expect(await pending).toEqual([]);
    expect(done).toHaveBeenCalledOnce();
  });
  it('releases a reservation that arrives after the caller times out', async () => {
    const connection = deferred<ReturnType<typeof postgres>>();
    const release = vi.fn();
    const f = fixture();
    Object.assign(f.sql, { reserve: () => connection.promise });
    const pending = expect(boundSql(f.sql, bounds).reserve()).rejects.toMatchObject({ code: 'DB_ACQUIRE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    connection.resolve(Object.assign(f.sql, { release }));
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledOnce();
  });
  it('never executes a transaction callback after a late checkout', async () => {
    const checkout = deferred<void>();
    const f = fixture();
    const begin = vi.fn(async (callback: (sql: typeof f.sql) => unknown) => {
      await checkout.promise;
      return callback(f.sql);
    });
    Object.assign(f.sql, { begin });
    const callback = vi.fn();
    const pending = expect(boundSql(f.sql, bounds).begin(callback)).rejects.toMatchObject({ code: 'DB_ACQUIRE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    checkout.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).not.toHaveBeenCalled();
  });
  it('does not apply the acquire timer to an already running transaction', async () => {
    const work = deferred<unknown>();
    const f = fixture();
    Object.assign(f.sql, { begin: (callback: (sql: typeof f.sql) => unknown) => Promise.resolve(callback(f.sql)) });
    const pending = boundSql(f.sql, bounds).begin(() => work.promise);
    await vi.advanceTimersByTimeAsync(200);
    work.resolve('committed');
    expect(await pending).toBe('committed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a transaction callback that never finishes', async () => {
    const f = fixture();
    Object.assign(f.sql, { begin: (callback: (sql: typeof f.sql) => unknown) => Promise.resolve(callback(f.sql)) });
    const pending = expect(boundSql(f.sql, bounds).begin(() => new Promise(() => undefined)))
      .rejects.toMatchObject({ code: 'DB_QUERY_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(401);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
});
