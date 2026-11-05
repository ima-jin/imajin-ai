import type postgres from 'postgres';

export class DatabaseTimeoutError extends Error {
  constructor(readonly code: 'DB_ACQUIRE_TIMEOUT' | 'DB_QUERY_TIMEOUT') {
    super(code);
    this.name = 'DatabaseTimeoutError';
  }
}

export interface DatabaseBounds {
  acquireMs: number;
  queryMs: number;
}

/** Zero is an explicit opt-out, never the result of an invalid setting. */
export function timeoutSetting(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a non-negative integer in milliseconds`);
  }
  return Number(value);
}

type Sql = ReturnType<typeof postgres>;
type Pending = Promise<unknown> & {
  cancel(): void;
  // postgres.js 3.x cancel() uses this same field to distinguish queued work.
  state: unknown;
};

/** Bound lazy postgres.js queries without eagerly executing SQL fragments. */
function boundQuery(query: Pending, bounds: DatabaseBounds): Pending {
  let result: Promise<unknown> | undefined;
  let proxy: Pending;
  function execute(): Promise<unknown> {
    if (result) return result;
    let acquireTimer: ReturnType<typeof setTimeout> | undefined;
    let queryTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectDeadline: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const expire = (code: DatabaseTimeoutError['code']) => {
      // Settle the caller even when a broken transport cannot acknowledge cancel.
      rejectDeadline(new DatabaseTimeoutError(code));
      query.cancel(); // Removes unassigned queries from postgres.js's queue.
    };
    if (bounds.acquireMs > 0) {
      acquireTimer = setTimeout(() => {
        if (!query.state) expire('DB_ACQUIRE_TIMEOUT');
      }, bounds.acquireMs);
    }
    // Total client deadline includes checkout and response consumption.
    if (bounds.queryMs > 0) queryTimer = setTimeout(() => expire('DB_QUERY_TIMEOUT'), bounds.queryMs);
    result = Promise.race([deadline, query]).finally(() => {
      clearTimeout(acquireTimer);
      clearTimeout(queryTimer);
    });
    return result;
  }
  proxy = new Proxy(query, {
    get(target, property) {
      if (property === 'then') return execute().then.bind(execute());
      if (property === 'catch') return execute().catch.bind(execute());
      if (property === 'finally') return execute().finally.bind(execute());
      if (property === 'execute') return () => { void execute().catch(() => undefined); return proxy; };
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const returned = Reflect.apply(value, target, args);
        return returned === target ? proxy : returned;
      };
    },
  });
  return proxy;
}

/** Reservations have no native acquire cancellation: release any late arrival. */
async function acquire<T>(
  pending: Promise<T>, ms: number, late: (value: T) => void,
): Promise<T> {
  if (ms === 0) return pending;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(value => {
        if (expired) late(value);
        return value;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new DatabaseTimeoutError('DB_ACQUIRE_TIMEOUT'));
        }, ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function transaction(
  target: Sql, method: 'begin' | 'savepoint', args: unknown[], bounds: DatabaseBounds,
): Promise<unknown> {
  const callback = args.at(-1) as (sql: Sql) => unknown;
  let expired = false;
  let acquired: (() => void) | undefined;
  let rejectTimeout!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const started = new Promise<void>(resolve => { acquired = resolve; });
  const run = async (sql: Sql) => {
    acquired?.();
    if (expired) throw new DatabaseTimeoutError('DB_ACQUIRE_TIMEOUT');
    let active = true;
    const scoped = boundSql(sql, bounds, () => {
      if (!active) throw new DatabaseTimeoutError('DB_QUERY_TIMEOUT');
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = callback(scoped);
      const pending = Array.isArray(work) ? Promise.all(work) : Promise.resolve(work);
      if (bounds.queryMs === 0) return await pending;
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new DatabaseTimeoutError('DB_QUERY_TIMEOUT');
            rejectTimeout(error);
            reject(error);
          }, bounds.queryMs);
        }),
      ]);
    } finally { active = false; clearTimeout(timer); }
  };
  const pending = Reflect.apply(Reflect.get(target, method), target, [...args.slice(0, -1), run]) as Promise<unknown>;
  // Stop measuring checkout once the transaction callback receives its connection.
  const checkout = acquire(Promise.race([
    pending.then(() => undefined), started,
  ]), bounds.acquireMs, () => undefined).then(() => pending).catch(error => {
    if (error instanceof DatabaseTimeoutError && error.code === 'DB_ACQUIRE_TIMEOUT') expired = true;
    throw error;
  });
  return Promise.race([checkout, deadline]);
}

/** Keep SQL helpers/fragments intact; wrap only executable queries and scopes. */
export function boundSql<T extends Sql>(sql: T, bounds: DatabaseBounds, assertActive = () => undefined): T {
  const wrap = (value: unknown) => value && typeof value === 'object' && 'cancel' in value && 'then' in value
    ? boundQuery(value as Pending, bounds) : value;
  return new Proxy(sql, {
    apply(target, thisArg, args) { assertActive(); return wrap(Reflect.apply(target, thisArg, args)); },
    get(target, property) {
      if (property === 'begin' || property === 'savepoint') {
        return (...args: unknown[]) => { assertActive(); return transaction(target, property, args, bounds); };
      }
      if (property === 'reserve') {
        return async () => {
          const reserved = await acquire(target.reserve(), bounds.acquireMs, late => late.release());
          return boundSql(reserved, bounds);
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { assertActive(); return wrap(Reflect.apply(value, target, args)); };
    },
  });
}
