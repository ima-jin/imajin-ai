/**
 * Shared minimal Drizzle-style query-builder mock for the #1073 golden
 * characterization suites (settle route + webhook route).
 *
 * Both suites need to fake `db.select().from(table).where(...).limit(n)`,
 * `db.update(table).set(...).where(...)`, and
 * `db.insert(table).values(...).onConflictDoUpdate(...)` without a real
 * database connection. Extracted here so the two test files don't
 * duplicate this chain-building plumbing — each suite still supplies its
 * own per-table `.limit()` result logic and owns its call-recording state
 * (and, for the settle route, its own `db.transaction()` wrapper).
 *
 * Not a `.test.ts` file, so vitest's `apps/**\/__tests__/**\/*.test.ts`
 * include glob does not pick this up as a test suite of its own.
 */

export interface MockInsertCall {
  table: string;
  values: Record<string, unknown>;
  conflict?: unknown;
}

export interface MockUpdateCall {
  table: string;
  values: Record<string, unknown>;
}

export interface MockDbCallState {
  insertCalls: MockInsertCall[];
  updateCalls: MockUpdateCall[];
}

/** Read the `__table` tag every mock table object in these suites carries. */
export function tableTag(table: unknown): string {
  return (table as { __table?: string } | undefined)?.__table ?? 'unknown';
}

/**
 * Build a fake `db` exposing `select`/`update`/`insert` with the same
 * chained call shape Drizzle's query builder has, recording insert/update
 * calls into `state` and delegating `.limit()` results to the caller via
 * `limitResultFor(table)`.
 *
 * The where-clause result is both directly awaitable (mirrors
 * `getBalances()`, which never calls `.limit()`) and chainable with
 * `.limit()` (mirrors `getBalanceRow()`), matching how real Drizzle's
 * query builder behaves either way.
 */
export function createMockDb(state: MockDbCallState, limitResultFor: (table: unknown) => Promise<unknown[]>) {
  function whereClauseFor(table: unknown) {
    // Lazy + cached: `limitResultFor(table)` must run at most once per
    // where-clause, whether the caller awaits the clause directly or calls
    // `.limit(n)` on it (or, in principle, both) — eagerly invoking it here
    // would double-consume any queue-shaped `limitResultFor` the caller supplies.
    let cached: Promise<unknown[]> | undefined;
    const getResult = () => (cached ??= limitResultFor(table));
    return {
      limit: (_n: number) => getResult(),
      then: (onFulfilled?: ((value: unknown[]) => unknown) | null, onRejected?: ((reason: unknown) => unknown) | null) =>
        getResult().then(onFulfilled, onRejected),
    };
  }
  function fromClauseFor() {
    return (table: unknown) => ({ where: (_cond?: unknown) => whereClauseFor(table) });
  }
  function select(_proj?: unknown) {
    return { from: fromClauseFor() };
  }

  function update(table: unknown) {
    return {
      set(values: Record<string, unknown>) {
        return {
          where(_cond?: unknown) {
            state.updateCalls.push({ table: tableTag(table), values });
            return Promise.resolve(undefined);
          },
        };
      },
    };
  }

  function insert(table: unknown) {
    return {
      values(values: Record<string, unknown>) {
        const record: MockInsertCall = { table: tableTag(table), values };
        state.insertCalls.push(record);
        const promise = Promise.resolve(undefined);
        return Object.assign(promise, {
          onConflictDoUpdate(conflict: unknown) {
            record.conflict = conflict;
            return Promise.resolve(undefined);
          },
        });
      },
    };
  }

  return { select, update, insert };
}

/**
 * Shared `@imajin/logger` `withLogger` mock: a transparent pass-through so
 * `POST`/`GET` route handlers wrapped in `withLogger('kernel', handler)`
 * are callable directly in tests, matching every pay route's shape.
 */
export function withLoggerPassthrough() {
  return (_service: string, handler: (req: unknown, ctx: { log: unknown }) => Promise<Response>) =>
    (req: unknown) => handler(req, { log: { error: () => {}, info: () => {}, warn: () => {} } });
}

export interface BalanceRouteDbMockOptions {
  /**
   * FIFO queue drained by `.limit()` calls against the `balances` table,
   * in call order (e.g. sender balance, then recipient balance — see each
   * suite's own comment for its specific order). Every other table, and
   * `balances` once the queue is empty, resolves to no rows. Omit for
   * suites whose route never calls `db.select()`.
   */
  balanceRowQueue?: Array<Record<string, unknown> | undefined>;
  /** Extra mock module exports beyond `db`/`balances`/`transactions`, e.g. `{ withdrawalRequests: {} }`. */
  extra?: Record<string, unknown>;
}

/**
 * Shared `@/src/db` mock module for `#2016` pay balance-route suites: a
 * `db` exposing `select`/`insert`/`update`/`transaction` over the
 * `createMockDb` chain-building plumbing above, plus a `balances` table
 * object carrying the `__table` tag `limitResultFor` keys off of, and an
 * empty `transactions` table stub. Centralized here (instead of each
 * route's suite redeclaring the same wiring) because it was the single
 * biggest source of cross-suite duplication in this family of tests.
 */
export function balanceRouteDbModule(state: MockDbCallState, opts: BalanceRouteDbMockOptions = {}) {
  function limitResultFor(table: unknown) {
    if (!opts.balanceRowQueue || tableTag(table) !== 'balances') return Promise.resolve([]);
    const row = opts.balanceRowQueue.shift();
    return Promise.resolve(row ? [row] : []);
  }
  const { select, insert, update } = createMockDb(state, limitResultFor);
  return {
    db: { select, insert, update, transaction: (cb: (tx: unknown) => Promise<void>) => cb({ insert, update }) },
    balances: { __table: 'balances', did: 'did', unit: 'unit', amount: 'amount' },
    transactions: {},
    ...(opts.extra ?? {}),
  };
}

/** Reset every array field of a `MockDbCallState`-shaped state object in place, including any extra fixture queues (e.g. `balanceRowQueue`) — call from `beforeEach` instead of a per-suite `resetState()`. */
export function resetMockDbCallState(state: Record<string, unknown>): void {
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) value.length = 0;
  }
}

/** Build a same-origin JSON POST `Request`, matching the shape every pay balance route test constructs by hand. */
export function jsonPostRequest(url: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}
