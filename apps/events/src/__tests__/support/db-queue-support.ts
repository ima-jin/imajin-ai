/**
 * Queue-based drizzle `db` double shared by the route suites that run their
 * handlers directly against `db.select()` / `db.update()` / `db.insert()`
 * chains (campaign routes, migrate-tickets, my-ticket, register).
 *
 * Every builder call (`select()`, `update(t)`, `insert(t)`) takes the NEXT
 * queued result for its kind and returns a chain whose methods (`from`,
 * `leftJoin`, `where`, `orderBy`, `limit`, `set`, `values`, `returning`) all
 * hand back the same chain; the chain is itself a promise, so `await` yields
 * the queued result at any point of the chain. Tests therefore read
 * top-to-bottom in the order the route performs its queries:
 *
 *   nextSelect([event]);          // 1st db.select()
 *   nextSelect([{ total: 3 }]);   // 2nd db.select()
 *   nextUpdate(new Error('x'));   // db.update() rejects
 *
 * Importing this module BEFORE the route under test registers the `@/db`
 * mock (vitest hoists `vi.mock`/`vi.hoisted`; ES imports evaluate in order).
 * The real table objects are kept, so `eq(table.col, …)` etc. stay real.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { vi } from 'vitest';

type Kind = 'select' | 'update' | 'insert';
type ChainMethod = 'from' | 'leftJoin' | 'innerJoin' | 'where' | 'orderBy' | 'limit' | 'set' | 'values' | 'returning';
type Chain = Promise<unknown> & Record<ChainMethod, (...args: unknown[]) => Chain>;

const hoisted = vi.hoisted(() => {
  const queues: Record<'select' | 'update' | 'insert', unknown[]> = { select: [], update: [], insert: [] };

  const setMock = vi.fn<(values: Record<string, unknown>) => void>();
  const valuesMock = vi.fn<(values: Record<string, unknown>) => void>();
  const returningMock = vi.fn<(fields?: unknown) => void>();
  const whereMock = vi.fn<(condition: unknown) => void>();

  function makeChain(kind: 'select' | 'update' | 'insert'): Chain {
    const next = queues[kind].shift();
    const settled = next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
    const chain: Chain = Object.assign(settled, {
      from: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      where: (condition: unknown) => {
        whereMock(condition);
        return chain;
      },
      set: (values: unknown) => {
        setMock(values as Record<string, unknown>);
        return chain;
      },
      values: (values: unknown) => {
        valuesMock(values as Record<string, unknown>);
        return chain;
      },
      returning: (fields?: unknown) => {
        returningMock(fields);
        return chain;
      },
    });
    return chain;
  }

  return {
    queues,
    setMock,
    valuesMock,
    returningMock,
    whereMock,
    selectMock: vi.fn<(fields?: unknown) => Chain>(() => makeChain('select')),
    updateMock: vi.fn<(table: unknown) => Chain>(() => makeChain('update')),
    insertMock: vi.fn<(table: unknown) => Chain>(() => makeChain('insert')),
  };
});

export const { selectMock, updateMock, insertMock, setMock, valuesMock, returningMock, whereMock } = hoisted;

vi.mock('@/src/db', async () => {
  const actual = await import('../../db/schema');
  return {
    ...actual,
    db: { select: hoisted.selectMock, update: hoisted.updateMock, insert: hoisted.insertMock },
  };
});

function enqueue(kind: Kind, result: unknown): void {
  hoisted.queues[kind].push(result);
}

/** Queue the rows (or a rejection) for the next `db.select()` chain. */
export function nextSelect(rows: unknown[] | Error): void {
  enqueue('select', rows);
}

/** Queue the result (e.g. `.returning()` rows, or a rejection) for the next `db.update()` chain. */
export function nextUpdate(result: unknown[] | Error): void {
  enqueue('update', result);
}

/** Queue a rejection (or an empty result) for the next `db.insert()` chain. */
export function nextInsert(result: unknown[] | Error = []): void {
  enqueue('insert', result);
}

/** Tables passed to `db.update()`, in call order. */
export function updatedTables(): unknown[] {
  return updateMock.mock.calls.map(([table]) => table);
}

/** Values passed to `.set()`, in call order. */
export function setValues(): Record<string, unknown>[] {
  return setMock.mock.calls.map(([values]) => values);
}

/** Bound parameters of the Nth `.where(...)` condition, rendered by drizzle's real pg dialect. */
export function whereParams(callIndex: number): unknown[] {
  const condition = whereMock.mock.calls[callIndex]?.[0];
  return new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]).params;
}

/** Empty every queue and clear every recorded call. Call from `beforeEach`. */
export function resetDbMocks(): void {
  for (const queue of Object.values(hoisted.queues)) queue.length = 0;
  for (const mock of [selectMock, updateMock, insertMock, setMock, valuesMock, returningMock, whereMock]) mock.mockClear();
}
