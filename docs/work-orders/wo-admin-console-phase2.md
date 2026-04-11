# Work Order Series: Admin Console — Phase 2

**Goal:** Observability foundation with swappable backends. Structured logging, correlation IDs, event bus, and admin dashboards — all behind adapter interfaces so Pino→OTel, Postgres→Inngest, etc. can be swapped without changing service code.

**Architecture principle:**
```
Services → thin shared interface → adapter → storage
              (never changes)      (swap)    (swap)
```

**Critical path:**
```
WO1 (@imajin/logger) → WO2 (correlation middleware) → WO3 (instrument services) → WO4 (telemetry dashboard)
                                                     → WO5 (@imajin/events)     → WO6 (instrument emitters) → WO7 (event viewer)
```

WO1-WO2 are sequential. WO3 + WO5 can parallelize after WO2. WO4 needs WO3. WO6 needs WO5. WO7 needs WO6.

**Estimated total:** 5-7 days across 7 work orders.

**Not in scope:** Crash replay (pulled out of #673, future Phase 3 work). Security monitoring (#671, Phase 3 — depends on this phase).

---

## Work Order 1: `@imajin/logger` Package (#672)
**Estimated effort:** 0.5 day
**Status:** Ready now
**Blocks:** Everything else

Create `packages/logger` with a Pino-backed structured JSON logger behind a stable interface.

### Deliverables

**packages/logger/src/index.ts** — public API:
```ts
export interface LogContext {
  service: string;
  correlationId?: string;
  did?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  ip?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(ctx: LogContext, message: string): void;
  warn(ctx: LogContext, message: string): void;
  error(ctx: LogContext, message: string): void;
  debug(ctx: LogContext, message: string): void;
  child(bindings: Partial<LogContext>): Logger;
}

export function createLogger(service: string): Logger;
```

**packages/logger/src/adapters/pino.ts** — Pino implementation:
- JSON output to stdout (pm2/Docker friendly)
- ISO timestamps
- Configurable log level via `LOG_LEVEL` env var (default: `info`)
- `child()` for per-request loggers with bound context
- Redaction of sensitive fields (passwords, tokens, keys) via Pino's `redact` option

**packages/logger/package.json:**
- Name: `@imajin/logger`
- Peer deps: none (Pino is a direct dep)
- Exports: `./src/index.ts`

### Notes
- The interface is the contract. Swapping to OTel later means writing `adapters/otel.ts` and changing the factory — zero service code changes.
- Don't add request middleware here — that's WO2.

---

## Work Order 2: Correlation ID Middleware (#672)
**Estimated effort:** 0.5 day
**Depends on:** WO1
**Blocks:** WO3, WO5

Add correlation ID generation and propagation across all services.

### Deliverables

**packages/logger/src/middleware.ts** — Next.js API route wrapper:
```ts
export function withLogger(
  service: string,
  handler: (req: NextRequest, ctx: { log: Logger; correlationId: string }) => Promise<NextResponse>
): (req: NextRequest) => Promise<NextResponse>;
```

This wrapper:
1. Reads `X-Correlation-Id` header from incoming request (for service-to-service calls)
2. If missing, generates one: `cor_${nanoid(16)}`
3. Creates a child logger bound to `{ correlationId, method, path, ip }`
4. Calls the handler with `{ log, correlationId }`
5. After response: logs `{ status, durationMs }` automatically
6. Sets `X-Correlation-Id` on the response

**packages/config/src/base-path.ts** (or wherever `apiFetch` lives) — propagate correlation ID:
- `apiFetch()` should accept and forward `X-Correlation-Id` header
- Any service-to-service call carries the correlation ID through the chain

**packages/logger/src/admin.ts** — shared `requireAdmin()` helper:
- Extract the copy-pasted `requireAdmin()` pattern (currently duplicated in 10+ admin API routes) into a shared export
- Same logic: `getSession()` → verify `actingAs` is node-scope group DID
- Return `session` or throw/return null

### Notes
- This is where OTel trace context would slot in later — the correlation ID maps 1:1 to a trace ID.
- `requireAdmin()` extraction is a freebie while we're touching every admin route anyway (WO3).

---

## Work Order 3: Instrument Services with Logger (#672)
**Estimated effort:** 1-1.5 days
**Depends on:** WO2
**Blocks:** WO4

Replace all `console.log/warn/error` calls across apps and packages with the structured logger.

### Scope

**729 console calls** across the codebase (692 in apps, 37 in packages).

Strategy per service:
1. Add `@imajin/logger` dependency
2. Create service-scoped logger: `const log = createLogger('kernel')` (or 'events', 'auth', etc.)
3. Replace `console.log(...)` → `log.info({ ...context }, message)`
4. Replace `console.error(...)` → `log.error({ ...context }, message)`
5. Replace `console.warn(...)` → `log.warn({ ...context }, message)`
6. For API routes: wrap with `withLogger()` to get automatic request/response logging + correlation ID

**Priority order** (kernel first since admin routes need `requireAdmin` extraction too):
1. `apps/kernel` (~415 calls + admin route cleanup)
2. `packages/*` (~37 calls)
3. `apps/auth`, `apps/pay`, `apps/events` (high-value services)
4. Remaining apps

**Admin routes:** Replace copy-pasted `requireAdmin()` with import from `@imajin/logger` (or `@imajin/auth` — wherever it lands from WO2).

### Notes
- This is the biggest WO by volume. Could split into 2 sub-agents: one for kernel+packages, one for remaining apps.
- Don't change behavior — just swap the log calls. No logic changes.
- Some `console.log` calls are in client components (`.tsx`) — leave those alone or use a browser-safe wrapper.

---

## Work Order 4: Telemetry Dashboard (#672)
**Estimated effort:** 1 day
**Depends on:** WO3

Build `/admin/telemetry` page in kernel, reading from structured log data.

### Deliverables

**Schema — migration 0015 (or next):**
```sql
CREATE TABLE registry.request_log (
  id TEXT PRIMARY KEY DEFAULT gen_id('req'),
  service TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER,
  did TEXT,
  ip TEXT,
  correlation_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_request_log_service_created ON registry.request_log(service, created_at DESC);
CREATE INDEX idx_request_log_correlation ON registry.request_log(correlation_id);
CREATE INDEX idx_request_log_status ON registry.request_log(status) WHERE status >= 400;
```

**Log sink** — extend `withLogger()` to optionally write completed requests to `request_log`:
- Async, fire-and-forget (never blocks the response)
- Controlled by `ENABLE_REQUEST_LOG=true` env var
- Retention: auto-delete rows older than configurable days (default 30), via cron or on-write cleanup

**API routes:**
- `GET /api/admin/telemetry` — aggregated stats: request volume over time, p50/p95/p99 latency per endpoint, error rates
- `GET /api/admin/telemetry/slow` — requests >1s, paginated
- `GET /api/admin/telemetry/errors` — recent 4xx/5xx, paginated
- `GET /api/admin/telemetry/trace/[correlationId]` — all request_log entries with matching correlation_id (shows the cross-service chain)

**Admin page — `apps/kernel/app/admin/telemetry/page.tsx`:**
- Request volume chart (24h, 7d toggleable)
- Latency percentiles table per endpoint
- Error rate per endpoint
- Top 10 slowest endpoints
- Recent errors list
- Click correlation ID → trace view (all requests in the chain, ordered by time)

**Nav update:** Add `{ label: 'Telemetry', href: '/admin/telemetry', icon: '📈' }` to admin nav items in layout.tsx.

### Future swap
When migrating to Grafana/Loki: remove the request_log table + sink, point the dashboard page at Grafana iframe or retire it entirely.

---

## Work Order 5: `@imajin/events` Package (#673)
**Estimated effort:** 0.5 day
**Depends on:** WO2 (needs correlation IDs)
**Blocks:** WO6

Create `packages/events` with a Postgres-backed event emitter behind a stable interface.

### Deliverables

**packages/events/src/index.ts** — public API:
```ts
export interface SystemEvent {
  service: string;
  action: string;             // e.g. 'ticket.create', 'identity.register', 'payment.charge'
  did?: string;               // acting DID
  correlationId?: string;     // from request context
  parentEventId?: string;     // causal chain
  payload?: Record<string, unknown>;
  status?: 'success' | 'failure';
  durationMs?: number;
}

export function emit(event: SystemEvent): void;  // fire-and-forget, never throws
export function createEmitter(service: string): ServiceEmitter;

export interface ServiceEmitter {
  emit(event: Omit<SystemEvent, 'service'>): void;
}
```

**packages/events/src/adapters/postgres.ts:**
- Writes to `registry.system_events` table
- Async, non-blocking — `emit()` returns immediately, write happens in background
- Batch writes: buffer events for up to 100ms or 10 events, then flush (reduces DB round-trips)
- On failure: log warning via `@imajin/logger`, never throw

**Schema — migration 0016 (or next):**
```sql
CREATE TABLE registry.system_events (
  id TEXT PRIMARY KEY DEFAULT gen_id('evt'),
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  did TEXT,
  correlation_id TEXT,
  parent_event_id TEXT,
  payload JSONB,
  status TEXT DEFAULT 'success',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_system_events_service_action ON registry.system_events(service, action);
CREATE INDEX idx_system_events_correlation ON registry.system_events(correlation_id);
CREATE INDEX idx_system_events_did ON registry.system_events(did);
CREATE INDEX idx_system_events_created ON registry.system_events(created_at DESC);
```

**Retention:** configurable via `EVENTS_RETENTION_DAYS` env var (default 90 days).

### Notes
- The `emit()` interface is the contract. Swapping to Inngest later means writing `adapters/inngest.ts` — same call sites, different transport.
- `parentEventId` enables causal chains: checkout → payment → notification. Each step references the event that triggered it.

---

## Work Order 6: Instrument Event Emission (#673)
**Estimated effort:** 1 day
**Depends on:** WO5

Add `emit()` calls at key action points across services.

### Event Catalog

Define the initial set of events. Each service creates a scoped emitter:

**Kernel (auth-adjacent):**
- `identity.register` — new DID created
- `identity.verify.preliminary` / `.established` — tier upgrade
- `session.create` / `.destroy` — login/logout
- `identity.suspend` / `.unsuspend` — admin action

**Events:**
- `event.create` / `.update` / `.delete`
- `ticket.purchase` — includes eventId, amount, buyerDid, sellerDid
- `checkin.create`

**Pay:**
- `payment.charge` — Stripe charge succeeded
- `payment.refund`
- `payout.request` / `.complete`
- `fee.record` — fee ledger entry created

**Connections:**
- `connection.create` / `.disconnect`
- `bump.match` / `.confirm`

**Chat:**
- `conversation.create`
- `message.send` (metadata only — no message content in events!)

**Profile:**
- `profile.update`
- `scope.switch` — actingAs changed

**Registry:**
- `attestation.create`
- `app.register` / `.unregister`

**Market:**
- `listing.create` / `.update` / `.delete`
- `listing.purchase`

### Implementation Pattern
```ts
import { createEmitter } from '@imajin/events';
const events = createEmitter('events');

// In a route handler:
events.emit({
  action: 'ticket.purchase',
  did: session.actingAs || session.id,
  correlationId,
  payload: { ticketId, eventId, amount },
});
```

### Notes
- **No message content, no PII in payloads.** Events record _what happened_, not _what was said_.
- Correlation IDs come from the `withLogger()` middleware context.
- Don't emit events for reads (GET requests) — only state-changing actions.

---

## Work Order 7: Event Viewer Dashboard (#673)
**Estimated effort:** 1 day
**Depends on:** WO6

Build `/admin/events` and `/admin/events/trace/[correlationId]` pages in kernel.

### Deliverables

**API routes:**
- `GET /api/admin/events` — paginated event stream, filterable by service, action, DID, correlation_id, time range
- `GET /api/admin/events/stats` — event volume by service/action over time
- `GET /api/admin/events/trace/[correlationId]` — all events sharing a correlation_id, ordered by created_at

**Admin page — `apps/kernel/app/admin/events/page.tsx`:**
- Live event stream (newest first), auto-refreshing
- Filters: service dropdown, action type, DID search, time range
- Each row: timestamp, service, action, DID (truncated), status badge, duration
- Click a row → expand to see full payload (redacted)
- Click correlation_id → navigate to trace view

**Trace view — `apps/kernel/app/admin/events/trace/[correlationId]/page.tsx`:**
- Waterfall/timeline visualization showing the cascade:
  ```
  auth (session.create)  ─────┐  12ms
  events (ticket.purchase) ───┤  45ms
  pay (payment.charge) ───────┤  230ms
  pay (fee.record) ───────────┤  8ms
  notify (email) ─────────────┘  150ms
  ```
- Each step shows: service, action, duration, status (green/red), payload (expandable)
- If a step failed → red highlight with error details

**Nav update:** Add `{ label: 'Events', href: '/admin/events', icon: '🔔' }` to admin nav.

### Future swap
When migrating to Inngest: the event viewer either becomes a thin proxy to Inngest's dashboard, or gets replaced by linking out to it.

---

## Summary

| WO | Scope | Issue | Est. | Depends On |
|----|-------|-------|------|------------|
| 1 | `@imajin/logger` package | #672 | 0.5d | — |
| 2 | Correlation middleware + requireAdmin extract | #672 | 0.5d | WO1 |
| 3 | Instrument all services | #672 | 1-1.5d | WO2 |
| 4 | Telemetry dashboard | #672 | 1d | WO3 |
| 5 | `@imajin/events` package | #673 | 0.5d | WO2 |
| 6 | Instrument event emission | #673 | 1d | WO5 |
| 7 | Event viewer dashboard | #673 | 1d | WO6 |

**Total: ~5.5-6.5 days**

**Parallelization:** After WO2, the logging track (WO3→WO4) and events track (WO5→WO6→WO7) can run in parallel.

**Deferred to Phase 3:**
- Crash replay (was in #673 — too ambitious, needs stable event bus first)
- Security monitoring (#671 — needs structured logging + events as foundation)
