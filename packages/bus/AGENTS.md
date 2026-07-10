# packages/bus — agent rules

## Package boundary: `packages/bus` must NOT import `apps/kernel`

`apps/kernel` depends on `packages/bus` (for event types, publish, reactors). The reverse
import is a circular dependency and is forbidden. This means reactors and other bus code
cannot use the Drizzle `db` instance from `apps/kernel/src/db/index.ts`, because that
module imports the Drizzle schema tables that live in `apps/kernel`.

## DB access: always use raw SQL via `@imajin/db` `getClient()`

Because the Drizzle schema tables are in `apps/kernel` (off-limits), the only way to touch
the database from `packages/bus` is through the raw `postgres.js` client exported by
`@imajin/db`. Use a dynamic import to avoid pulling in the DB connection at module load time
(keeps the package testable without a real database):

```typescript
const { getClient } = await import('@imajin/db');
const sql = getClient();

await sql`
  INSERT INTO kernel.some_table (id, foo) VALUES (${id}, ${foo})
`;
```

**Do NOT:**
- Import `db` or any Drizzle table from `apps/kernel/src/db`
- Import `createDb` from `@imajin/db` with schema tables from `apps/kernel`
- Use `drizzle-orm` query builders directly in `packages/bus`

**Existing examples of this pattern:**
- `src/config.ts` — reads `kernel.bus_chain_configs`
- `src/reactors/audit.ts` — writes `kernel.broker_audit_log`
- `src/reactors/supply-recorder.ts` — writes `kernel.supply_lots` / `kernel.supply_stages`

## Testing reactors that use `getClient()`

Mock `@imajin/db` with a fake tagged-template function that records query text and values.
Use `vi.hoisted` so the mock is available before module imports are resolved:

```typescript
const { calls, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve([]);
  };
  return { calls, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));
```

Then assert on `calls[n].text` (query skeleton) and `calls[n].values` (interpolated params).
See `tests/supply-recorder.test.ts` and `tests/supply-lots.test.ts` for complete examples.
