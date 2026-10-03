/**
 * Minimal in-memory stand-in for the slice of drizzle the identity-binding
 * code reads with: `select(projection?).from(t).innerJoin(t2, cond).where(p)
 * .orderBy(c).limit(n)`. Unlike a call-recording mock it actually EVALUATES
 * the predicates, so a test fails if the production query forgets a filter
 * (removed rows, wrong subtype, suspended agents, ...) rather than merely
 * asserting that some filter was passed.
 *
 * Columns are the strings `"<table>.<column>"`; `eq(a, b)` compares two
 * columns when `b` is itself a column string, which is how join conditions
 * evaluate. There are deliberately no write methods: a code path under test
 * that tries `insert`/`update`/`delete` throws, which is how the
 * "read-only" claims are enforced.
 */
export type Row = Record<string, unknown>;
export type Predicate = (row: Row) => boolean;

export interface FakeTable {
  __table: string;
  [column: string]: string;
}

export function defineTable(name: string, columns: string[]): FakeTable {
  const table: FakeTable = { __table: name };
  for (const column of columns) table[column] = `${name}.${column}`;
  return table;
}

function isColumn(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z_]+\.[A-Za-z]+$/.test(value);
}

export const fakeEq =
  (column: string, value: unknown): Predicate =>
  (row) =>
    isColumn(value) ? row[column] === row[value] : row[column] === value;

export const fakeIsNull =
  (column: string): Predicate =>
  (row) =>
    row[column] == null;

export const fakeAnd =
  (...predicates: Predicate[]): Predicate =>
  (row) =>
    predicates.every((predicate) => predicate(row));

export const fakeAsc = (column: string): string => column;

export const fakeGt =
  (column: string, value: unknown): Predicate =>
  (row) => {
    const raw = row[column];
    if (raw == null) return false;
    const left = raw instanceof Date ? raw.getTime() : Number(raw);
    const right = value instanceof Date ? value.getTime() : Number(value);
    return left > right;
  };

function prefixed(table: FakeTable, rows: Row[]): Row[] {
  return rows.map((raw) => {
    const out: Row = {};
    for (const [key, value] of Object.entries(raw)) out[`${table.__table}.${key}`] = value;
    return out;
  });
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' ? value : Number.NEGATIVE_INFINITY;
}

function projectRows(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows;
  const entries = Object.entries(projection);
  return rows.map((row) => Object.fromEntries(entries.map(([key, column]) => [key, row[column]])));
}

function crossJoin(left: Row[], right: Row[]): Row[] {
  const joined: Row[] = [];
  for (const l of left) {
    for (const r of right) joined.push({ ...l, ...r });
  }
  return joined;
}

function sortBy(rows: Row[], column: string): Row[] {
  return [...rows].sort((a, b) => toMillis(a[column]) - toMillis(b[column]));
}

/** The awaitable result of `.where(...)`, which may also be refined by `.orderBy` / `.limit`. */
function whereResult(matched: Row[], projection?: Record<string, string>) {
  const resolve = (rows: Row[]) => Promise.resolve(projectRows(rows, projection));
  return Object.assign(resolve(matched), {
    orderBy: (column: string) => resolve(sortBy(matched, column)),
    limit: (n: number) => resolve(matched.slice(0, n)),
  });
}

export function createFakeDb(stores: Record<string, Row[]>) {
  const rowsOf = (table: FakeTable): Row[] => prefixed(table, stores[table.__table] ?? []);

  function select(projection?: Record<string, string>) {
    return {
      from(table: FakeTable) {
        let rows = rowsOf(table);

        const chain = {
          innerJoin(other: FakeTable, condition: Predicate) {
            rows = crossJoin(rows, rowsOf(other)).filter(condition);
            return chain;
          },
          where(predicate: Predicate) {
            return whereResult(rows.filter(predicate), projection);
          },
        };
        return chain;
      },
    };
  }

  return { select };
}
