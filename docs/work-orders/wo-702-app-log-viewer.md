# Work Order: Application Log Viewer (#702)

**Goal:** Pipe `@imajin/logger` application-level log entries (warn/error by default, info opt-in) into Postgres and expose them in the admin console with filtering, search, and correlation ID linking.

**Branch:** `feat/702-app-log-viewer` from `main`
**Depends on:** #686 merged (events→emit rename touches the same import paths in logger)

---

## Architecture

Three layers, in build order:

```
1. Schema + Migration      → telemetry.app_logs table
2. Logger Transport         → Pino → Postgres write (fire-and-forget)
3. Admin API + UI          → /api/admin/logs + /admin/logs page
```

---

## Step 1: Schema + Migration

### 1a. Drizzle schema

Add to `apps/kernel/src/db/schemas/registry.ts` (where `requestLog` and `systemEvents` already live):

```ts
export const appLogs = registrySchema.table('app_logs', {
  id: text('id').primaryKey(),
  service: text('service').notNull(),
  level: text('level').notNull(),                // debug, info, warn, error
  message: text('message').notNull(),
  correlationId: text('correlation_id'),
  did: text('did'),
  method: text('method'),
  path: text('path'),
  metadata: jsonb('metadata'),                   // remaining LogContext fields
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  createdIdx: index('idx_app_logs_created').on(table.createdAt),
  serviceLevelIdx: index('idx_app_logs_service_level').on(table.service, table.level),
  correlationIdx: index('idx_app_logs_correlation').on(table.correlationId),
}));
```

Export from `apps/kernel/src/db/index.ts` if not auto-exported via the schema barrel.

### 1b. Migration SQL

Create `apps/kernel/drizzle/XXXX_app_logs.sql` (use next available number):

```sql
CREATE TABLE IF NOT EXISTS registry.app_logs (
  id text PRIMARY KEY,
  service text NOT NULL,
  level text NOT NULL,
  message text NOT NULL,
  correlation_id text,
  did text,
  method text,
  path text,
  metadata jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_logs_created ON registry.app_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_app_logs_service_level ON registry.app_logs (service, level);
CREATE INDEX IF NOT EXISTS idx_app_logs_correlation ON registry.app_logs (correlation_id) WHERE correlation_id IS NOT NULL;
```

**Note:** Use `registry` schema (not `telemetry`) — that's where `request_log` and `system_events` live. The issue said `telemetry` but match the existing pattern.

Add journal entry + snapshot file per the drizzle convention.

### 1c. Retention

Add to the migration:

```sql
-- Retention: auto-delete logs older than 14 days
-- Run via pg_cron or a scheduled admin endpoint
-- CREATE EXTENSION IF NOT EXISTS pg_cron;  -- if pg_cron is available
-- SELECT cron.schedule('app-logs-cleanup', '0 3 * * *', $$DELETE FROM registry.app_logs WHERE created_at < now() - interval '14 days'$$);
```

For now, create an admin API endpoint for manual cleanup (Step 3). pg_cron can be added when confirmed available on the server.

---

## Step 2: Logger Transport

### 2a. Add Postgres write to Pino adapter

**File:** `packages/logger/src/adapters/pino.ts`

Add a fire-and-forget write function (same pattern as `writeRequestLog` in `packages/logger/src/middleware.ts`):

```ts
const MIN_PERSIST_LEVEL = process.env.APP_LOG_LEVEL || 'warn';
const LEVEL_PRIORITY: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function shouldPersist(level: string): boolean {
  if (process.env.ENABLE_APP_LOG !== 'true') return false;
  return (LEVEL_PRIORITY[level] ?? 0) >= (LEVEL_PRIORITY[MIN_PERSIST_LEVEL] ?? 30);
}

function writeAppLog(entry: {
  service: string;
  level: string;
  message: string;
  correlationId?: string;
  did?: string;
  method?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}): void {
  if (!shouldPersist(entry.level)) return;

  import('@imajin/db')
    .then(({ getClient }) => {
      const sql = getClient();
      const id = `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      return sql`
        INSERT INTO registry.app_logs (id, service, level, message, correlation_id, did, method, path, metadata)
        VALUES (${id}, ${entry.service}, ${entry.level}, ${entry.message},
                ${entry.correlationId ?? null}, ${entry.did ?? null},
                ${entry.method ?? null}, ${entry.path ?? null},
                ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb)
      `;
    })
    .catch(() => {
      // Never block or surface errors from the log sink
    });
}
```

### 2b. Wire into the Logger wrapper functions

In `wrapPino`, add `writeAppLog` calls alongside each Pino method. Extract known fields from LogContext, put the rest in metadata:

```ts
function wrapPino(instance: pino.Logger): Logger {
  function persist(level: string, ctx: LogContext, message: string) {
    const { service, correlationId, did, method, path, ...rest } = ctx;
    writeAppLog({
      service: service || 'unknown',
      level,
      message,
      correlationId,
      did,
      method,
      path,
      metadata: Object.keys(rest).length > 0 ? rest : undefined,
    });
  }

  return {
    info(ctx, msg) { instance.info(ctx, msg); persist('info', ctx, msg); },
    warn(ctx, msg) { instance.warn(ctx, msg); persist('warn', ctx, msg); },
    error(ctx, msg) { instance.error(ctx, msg); persist('error', ctx, msg); },
    debug(ctx, msg) { instance.debug(ctx, msg); persist('debug', ctx, msg); },
    child(bindings) { return wrapPino(instance.child(bindings as Record<string, unknown>)); },
  };
}
```

**Important:** `shouldPersist` gates everything — no DB calls unless `ENABLE_APP_LOG=true` AND the level meets the threshold.

### 2c. Don't touch middleware.ts

The existing `writeRequestLog` in middleware.ts stays as-is. It writes to `registry.request_log` (HTTP-level). The new transport writes to `registry.app_logs` (application-level). They're complementary, linked by correlation ID.

---

## Step 3: Admin API + UI

### 3a. API endpoint

**File:** `apps/kernel/app/api/admin/logs/route.ts`

Pattern: copy from `apps/kernel/app/api/admin/events/route.ts` — same auth check (`requireAdmin`), same parameterized query, same response shape.

```
GET /api/admin/logs
  ?service=kernel
  &level=error,warn          (comma-separated)
  &correlationId=cor_xxx
  &did=did:imajin:xxx
  &search=failed              (ILIKE on message)
  &from=2026-04-13T00:00:00Z
  &to=2026-04-14T00:00:00Z
  &limit=50
  &offset=0

Response: { rows: AppLog[], total: number }
```

### 3b. Cleanup endpoint

**File:** `apps/kernel/app/api/admin/logs/cleanup/route.ts`

```
POST /api/admin/logs/cleanup
  ?days=14    (default 14, minimum 1)

Requires admin. Deletes rows older than N days. Returns { deleted: number }.
```

### 3c. Admin page

**File:** `apps/kernel/app/admin/logs/page.tsx` (server component, fetches initial data)
**File:** `apps/kernel/app/admin/logs/logs-client.tsx` (client component with filters + live view)

**Pattern:** Match the Events page (`apps/kernel/app/admin/events/`). Specifically:
- `events/page.tsx` is the server shell
- `events/events-client.tsx` is the client component with filters, table, pagination

**Layout:**
- Filter bar: service dropdown, level pills (debug/info/warn/error — toggleable), search box, correlation ID input, time range
- Log table: timestamp, service badge (use same `SERVICE_COLORS` map from events-client.tsx), level badge, message (truncated), correlation ID (clickable link to `/admin/telemetry/trace/[id]`)
- Row expansion: click to expand and show full metadata JSON
- Pagination: offset/limit with "Showing X of Y"
- Auto-refresh toggle (poll every 5s when enabled)

**Level badge colors:**
```ts
const LEVEL_COLORS = {
  debug: 'bg-gray-100 dark:bg-gray-800 text-gray-500',
  info:  'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400',
  warn:  'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400',
  error: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400',
};
```

### 3d. Nav item

**File:** `apps/kernel/app/admin/layout.tsx`

Add to `NAV_ITEMS` array (after Telemetry):

```ts
{ label: 'Logs', href: '/admin/logs', icon: '📋' },
```

---

## Validation

1. Set `ENABLE_APP_LOG=true` in kernel .env.local
2. Hit some endpoints that trigger `log.error()` / `log.warn()`
3. Verify rows appear in `registry.app_logs`
4. Open `/admin/logs` — should show entries
5. Filter by service, level, search — should work
6. Click correlation ID — should link to telemetry trace view
7. Verify `ENABLE_APP_LOG` not set → zero DB writes (no performance impact)
8. Run cleanup endpoint → old rows deleted

---

## Rules

- **Fire-and-forget only.** Log writes must never block requests or throw.
- **No new package dependencies.** Uses existing `@imajin/db` dynamic import pattern.
- **Match existing admin page patterns.** Copy from events page, not from scratch.
- **`registry` schema**, not `telemetry`. Match where `request_log` and `system_events` live.
- **All DDL idempotent.** `IF NOT EXISTS` everywhere.
- **Add journal entry + snapshot** to drizzle meta.
- **Don't modify middleware.ts.** The request log transport is separate.
- **Redaction still applies.** Pino's redact config runs before our transport sees the data — sensitive fields are already `[redacted]`.
