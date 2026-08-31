/**
 * Shared row-predicate builders for the lightweight in-memory `drizzle-orm`
 * mocks used by this directory's unit tests. Extracted so new test files
 * don't re-implement the same `eq`/`gt`/`isNull`/`and` predicate logic
 * inline inside their `vi.mock('drizzle-orm', ...)` factory.
 */
export type Row = Record<string, unknown>;
export type Predicate = (row: Row) => boolean;

export const eqPredicate =
  (column: string, value: unknown): Predicate =>
  (row) =>
    row[column] === value;

export const gtPredicate = (column: string, value: unknown): Predicate => {
  const b = value instanceof Date ? value.getTime() : (value as number);
  return (row) => {
    const raw = row[column] as Date | number | undefined;
    if (raw === undefined) return false;
    const a = raw instanceof Date ? raw.getTime() : raw;
    return a > b;
  };
};

export const isNullPredicate =
  (column: string): Predicate =>
  (row) =>
    row[column] == null;

export const andPredicate =
  (...preds: Predicate[]): Predicate =>
  (row) =>
    preds.every((p) => p(row));
