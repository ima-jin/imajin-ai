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
 */
export function createMockDb(state: MockDbCallState, limitResultFor: (table: unknown) => Promise<unknown[]>) {
  function whereClauseFor(table: unknown) {
    return { limit: (_n: number) => limitResultFor(table) };
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
