# Database connection recovery

## Stuck-backend reaper
`apps/kernel/src/cron/db-reaper.ts` runs directly in each environment's
`dev-kernel-cron` / `prod-kernel-cron` process once per minute. It does not
call kernel HTTP or borrow the kernel's exhausted application pool. Each run
uses one short-lived connection to that process's `DATABASE_URL`, with a
10-second total deadline, a 5-second statement/connect timeout, and forced
socket shutdown after one second on close. No pool-size policy changes.

The single exported `STUCK_BACKEND_PREDICATE` restricts termination to the
current database AND current role, client backends only, excluding itself,
with `state = 'active'`, `wait_event = 'ClientRead'`, and a `state_change`
older than `DB_REAPER_THRESHOLD_SECONDS` (default **300**, positive integer).
It never terminates other databases/roles, idle or replication backends.
Do not broaden this predicate to all active or all old connections.

A postgres.js CancelRequest asks the server to cancel executing work. A
backend waiting for the next client protocol message has no executing work
to cancel. The driver releases a busy slot only on ReadyForQuery or socket
death; caller deadlines do not prove reclamation. The existing bounds stay
unchanged. The server-side termination closes the stuck socket so the
application driver can replace it.

Every termination result is logged as `db.reaper` with pid, age in seconds,
application_name and a query prefix of at most 80 characters. To avoid leaking
SQL literals, the prefix contains only the leading SQL command (otherwise
`[redacted]`), not query text or parameters. `terminated: false` and
`db.reaper-failed` must be investigated; no permissions are escalated. The
normal application role must be able to terminate its own sessions.

Tests execute the unchanged exported predicate against a seeded
pg_stat_activity-shaped fixture in the repository's embedded PostgreSQL
(PGlite), covering every exclusion and the exact threshold. No production DB
or external database server is used.

## HTTP liveness in the scheduled watchdog
`scripts/pm2-health-check.sh prod` now runs the existing
`deploy/liveness-probe.mjs` in `--once --execute --watchdog` mode after the
crash-loop and process-status checks, using the same ecosystem inventory.
Every HTTP listener is checked on loopback at `/api/health?liveness=1`.
The kernel endpoint performs `SELECT 1` through its actual pool (1.5-second
bound), without registry/HTTP fan-out. The probe's total HTTP deadline is
5 seconds; a non-2xx response, redirect, or timeout is a failure.

Persistent per-app counters trigger an exact-name `pm2 restart` after **3
consecutive failures**, normally **3 per-minute cron checks**, with 90 seconds
startup grace and a five-minute restart cooldown. Success resets the streak.
Stopped/missing processes stay stopped. Dev and prod inventories and state are
separate. State/outbox is written before restart in
`~/.imajin/liveness/<dev|prod>.json` (override directory:
`IMAJIN_LIVENESS_STATE_DIR`). A lock prevents simultaneous probe runs; do not
enable both the optional systemd continuous probe and this cron watchdog.
If a process is forcibly killed while holding a lock, Jin must verify no probe
is running before removing the stale `.lock` file.

Watchdog alerts use the existing `RESTART_ALERT_WEBHOOK` /
`STATUS_ALERT_WEBHOOK`, including the wrapper's protected webhook-file
fallback. No kernel secret needs to be copied into cron. If the internal
credential is already available, signed ops-event delivery remains in use.
Failed deliveries stay in the durable outbox; unhealthy probes or pending
alerts produce a nonzero watchdog result. Neither raw errors nor credentials
are printed.

### Installation and operator verification (Jin only)
This change ships code; the agent does not SSH, install, restart production
services, or access production Postgres. The existing per-environment
`scripts/install-pm2-health-cron.sh` installs this wrapper once a minute.
After the normal reviewed deploy, Jin verifies the existing prod cron points
at this repository's `scripts/pm2-health-check.sh prod`, not an old server-only
copy. Jin restarts `prod-kernel-cron` through the normal deploy so it loads the
direct reaper, and checks its logs for `db.reaper` or failure events. No new
service, schema migration, privileged database role, or pool setting is needed.
If the optional `imajin-liveness@prod` systemd unit was enabled previously,
Jin disables that duplicate supervisor before using cron.

Jin verifies normal `/api/health?liveness=1` returns 200 and that the watchdog
state updates each minute. Then observe production for **48 hours** with no
`DB_ACQUIRE_TIMEOUT` or unexpected liveness restarts; this run cannot claim
that observation before installation.

Safe local reproduction: `node scripts/repro-db-watchdog.mjs`. It runs an
actual loopback HTTP stub, returns 503 on three virtual one-minute ticks,
persists/reloads counters like cron, records exactly one stubbed restart,
then returns 200. It needs no database, secrets, or real pm2.

## Retryable auth database timeouts
`POST /auth/api/apps/token` and `GET /auth/api/session` return **503** with
`Retry-After: 5` and `Cache-Control: no-store` for `DatabaseTimeoutError`
acquire/query bounds, including Drizzle's wrapped `cause`. Other errors and
authentication/authorization responses are unchanged. A timeout does not
clear the session cookie. No acting identity or ownership behavior changes.
