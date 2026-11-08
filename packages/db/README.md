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

Tests execute the exported predicate against a seeded pg_stat_activity-shaped
SQLite fixture (epoch timestamps; interval/current_user syntax adapted only),
covering every exclusion and the exact threshold. No production DB is used.
