# Kernel deployment

The tracked ecosystem files are the source of truth for in-repo PM2 definitions. Workflow source is not a claim that a live host matches it. [Deploy posture](../docs/ops/DEPLOY-POSTURE.md) explains the workflow order and evidence; [environment configuration](../docs/ENVIRONMENTS.md) owns ports, domains and variable placement.

## HTTP liveness watchdog
**Installation is an operator action after the reviewed kernel deployment.** PM2 `online` proves a process exists, not that HTTP answers.
`deploy/liveness-probe.mjs` checks every HTTP listener in the selected tracked
ecosystem config. Portless `*-kernel-cron` workers are explicitly excluded;
this is not a heartbeat for background jobs. Reconcile any extra live PM2 app
into the tracked config before enabling it. No SSH, timer installation or
live restart is part of this change.

Policy: a **5s total HTTP deadline**, **3 consecutive failures**, **15s between
completed sweeps**, **90s grace for an observed PID's startup**, and a persistent
**5-minute restart cooldown per app**. Success resets that app's streak.
Only 2xx is healthy. A zero/missing PM2 PID stays stopped; an unavailable PID
query is logged without restarting anything. Slow checks never overlap.
The probe runs as `jin` with the same `PM2_HOME` as the apps, and invokes only
`pm2 pid <name>` / `pm2 restart <name>` with argument arrays, never a shell,
`jlist` (which includes secrets), `all`, or `--update-env`.

Each target is `http://127.0.0.1:<port>/api/health?liveness=1`.
For the kernel, this query checks **the same shared pool with SELECT 1**,
bounded to **1.5 seconds**, cancelling the query on timeout. A full/wedged pool
returns 503 rather than a false process-only 200. No separate connection can
mask pool exhaustion, and no vault, registry or HTTP fan-out runs here.
`/api/health` without the query retains its aggregate readiness
contract. Restarting the kernel for a sibling's readiness failure would amplify
an outage; do not point this watchdog at aggregate readiness.

Restart attempts are saved **before** the command in
`~/.imajin/liveness/{dev,prod}.json`. That file also retains counters, cooldowns
and an ops-event outbox. Writes use an atomic rename; a per-environment lock
prevents two probes racing. SIGTERM/SIGINT finish the current bounded sweep,
then remove the lock. After SIGKILL/host failure, inspect the lock's PID before
removing a stale lock; **never discard the state/outbox** to restart the probe.
Archive old delivered history under operator control rather than deleting it.

The outbox delivers (at most five pending receipts per sweep) to
`/jin/api/internal/ops-events` on that environment's kernel, authenticated with
the existing `AUTH_INTERNAL_API_KEY` loaded from the protected kernel env file.
No secret is printed or passed as a CLI value. Failed delivery remains queued
across probe/kernel restarts; 200 acknowledges an idempotent transaction that
writes both a node-signed `ops.liveness.restart` attestation and its Record event.
A crash between command and result leaves an honest `requested` receipt, not
an invented success. `restarted` means the PM2 command succeeded; the next
health check independently proves recovery.

The recipient is the node's **server-configured `nodeOperatorDid`**, not a DID
supplied by the probe. Confirm it is Ryan's operator identity (or the correct
operator organization) before enabling. Receipts appear in that identity's
**`/jin` → Record**, action `ops.liveness.restart`; org context uses normal
validated acting-as access. Personal/other-org Records never inherit them.
The kernel does **not** message Telegram. A gateway may consume/escalate these
ops events; delivery to an offline kernel is necessarily delayed until it can
record them. Probe stderr/journal plus the persistent outbox are the offline
operator evidence.

Operator steps (repeat for dev/prod, do not execute from an agent run):

1. Deploy this code through the normal reviewed release/deploy pipeline.
   Verify `GET /api/health?liveness=1` answers within 2s with `database: true`; verify every tracked
   app actually implements `/api/health` (a 404 is a configuration failure).
2. Check the appropriate kernel env file contains the existing internal key
   without displaying it, and that node metadata has the intended operator DID.
3. From `/home/jin/prod/imajin-ai`, inspect safely with
   `node deploy/liveness-probe.mjs --env prod --once --dry-run`.
   Dry-run is the default and never restarts or sends a real receipt. It does
   persist observations. Do not run a second copy alongside an active daemon.
4. Verify `/usr/bin/node`, `User=jin`, both `/home/jin/{dev,prod}/imajin-ai`
   repository/env paths, and `PM2_HOME=/home/jin/.pm2`. After review, run the
   following exact, idempotent operator commands **on the host** (never from
   an agent run). Install from the reviewed production checkout after both
   environments carry the DB-aware health route:

   ```bash
   sudo install -m 0644 /home/jin/prod/imajin-ai/deploy/imajin-liveness@.service /etc/systemd/system/imajin-liveness@.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now imajin-liveness@dev.service imajin-liveness@prod.service
   sudo systemctl is-enabled imajin-liveness@dev.service imajin-liveness@prod.service
   sudo systemctl is-active imajin-liveness@dev.service imajin-liveness@prod.service
   sudo journalctl -u imajin-liveness@dev.service -u imajin-liveness@prod.service --since '5 minutes ago' --no-pager
   ```

   Both `is-enabled` and `is-active` must report two successful units; zero
   installed units is **not** completion. Repeating install/enable is safe.
   For an already-running unit after a future reviewed code/unit update,
   restart only the two watchdog instances with
   `sudo systemctl restart imajin-liveness@dev.service imajin-liveness@prod.service`.
   This is not a PM2 application restart. The unit explicitly passes
   `--execute`; there is no automatic deploy hook.
5. Inspect the journal and `/jin` Record. Test a **stub**, never deliberately
   block production: `pnpm --silent test:agent scripts/__tests__/liveness-probe.test.mjs`.
   It withholds real HTTP responses and uses a stubbed restart command to
   restore health, then verifies the receipt. No PM2 command is executed.
6. To disable, stop the appropriate watchdog unit. PM2 apps remain untouched.
   Keep state/outbox so pending alerts and cooldowns survive re-enabling.

## Authentication deadlines

Kernel boot injects in-process JWT verification and current-identity lookup; infrastructure packages do not import kernel code. Standalone corpus and broker consumers use HTTP. Remaining auth and WebSocket HTTP calls share a five-second headers-and-body deadline without retry. Incoming request timeout alone does not bound an outbound response-header wait.

Internal diagnostics include only safe cause code, target path and duration, never cookies, credential headers, query strings or raw upstream errors. The real-network reproduction is `packages/auth/tests/session-stall-repro.test.ts`; it uses ephemeral test material, not real sessions or databases. Server Action reference noise is a separate failure class.

- `UND_ERR_HEADERS_TIMEOUT` identifies an outbound response-header stall in `packages/auth/src/internal-fetch.cjs`; the receiving server's request timeout does not bound that wait.
- `REPRO_DEFAULT_HEADERS=1` enables the optional native-header-timeout diagnostic in the real-network repro; it can wait about five minutes and is not the bounded-pass criterion.

## Database deadlines and pool-stall reproduction

The shared `@imajin/db` client retains `max: 10`, `idle_timeout: 20` and
`connect_timeout: 10`. Its process-global singleton makes Next's separate
bundles and the DB liveness check use the same pool. Each new connection supplies PostgreSQL
`statement_timeout=30000` and `idle_in_transaction_session_timeout=60000`
startup parameters. Runtime settings (milliseconds, non-negative integers):

- `DB_STATEMENT_TIMEOUT_MS`: default 30000, server statement execution.
- `DB_IDLE_TRANSACTION_TIMEOUT_MS`: default 60000, server idle-in-transaction.
- `DB_ACQUIRE_TIMEOUT_MS`: default 10000, queued queries/reservations/transactions.
- `DB_QUERY_TIMEOUT_MS`: default 40000, total client query response/transaction
  callback deadline, including checkout for queries.

Timed-out queries are cancelled, including removal of still-queued work.
Reservations arriving late are released; transaction callbacks never start
after a checkout timeout. A callback deadline forces rollback and rejects the
caller without waiting indefinitely for its transport. Never await same-kernel
HTTP or non-DB work inside a transaction. Stage external work before checkout
or deliver only after commit. Query cancellation is best-effort when the
transport is broken; the DB-aware watchdog is the recovery backstop.
Broker consent notifications now insert on the dedupe transaction's own
connection and deliver after commit. Relay operations originating inside a
transaction (including signed-mail audit) queue until the outermost commit;
rollback/timeout drops the queued delivery. Savepoints merge into their parent.
An autocommit/COMMIT timeout does not prove that a write was not applied:
do not automatically retry value-moving writes after an ambiguous response.

**Explicit opt-outs:** a dedicated long-running worker may set the relevant
`DB_*_TIMEOUT_MS=0` (or a larger bound) only in that worker's environment, never
the HTTP kernel environment. No kernel request path opts out. The migration
runner `scripts/migrate.mjs` uses its own direct postgres client, not the shared
runtime client, and therefore deliberately retains migration-specific policy.
The companion `0237_database_runtime_bounds.sql` is idempotent `SELECT 1`:
no role/database-wide timeout is changed and no rows are rewritten/deleted.

Local-only real PostgreSQL repro: start a disposable Postgres with a loopback
port and **database `imajin_runtime_repro`**, set `DB_BOUNDS_REPRO_URL` in the
environment, then run `pnpm exec tsx scripts/repro-db-pool-stall.ts`.
The script refuses non-loopback or other database targets. It holds all ten
pool connections, asserts bounded query failure, serves the actual shared
DB liveness check, and exercises the watchdog with a **fake exact-app restart**
that releases those connections. It proves recovery, receipt delivery and
cooldown without invoking PM2, systemd, or any production endpoint.

## Configuration and deployment

| Tracked file | Environment path | Kernel port |
|---|---|---|
| `ecosystem.dev.config.js` | `~/dev/ecosystem.config.js` | 3000 |
| `ecosystem.prod.config.js` | `~/prod/ecosystem.config.js` | 7000 |

Edit the tracked config through a reviewed PR. The deploy workflows copy it into place before builds and reconcile processes from that file; do not hand-edit a live config without recording the change here.

Production deployment follows Release dispatch, reviewed release PR, automatic tag/deploy dispatch and the existing production approval. Redeploy an approved ref through that workflow. Do not create tags by hand, bypass approval or use a manual production pull.

The release PR is opened automatically by a scoped GitHub App token, also used for the branch push; its `pull_request` event starts CI. Ryan provisions the App on `imajin-ai` only with Contents and Pull requests read/write permissions, the Actions variable `RELEASE_APP_ID` and Actions secret `RELEASE_APP_PRIVATE_KEY`. Keep the Actions PR-creation setting OFF. See [release setup](../docs/npm-publishing.md#cutting-a-release-tag-is-truth--2285); do not open the PR by hand or substitute a PAT.

## Kernel environment loading

The standalone kernel runs through Node with `--env-file` pointing to its untracked kernel environment file. Plain Node does not load that file automatically, and PM2's unsupported `env_file` property is not a substitute. Only the path belongs in the ecosystem definition; secret values do not.

Missing env files make Node fail; a missing production signing key makes protected operations refuse rather than use a development key. A real deployment preserves `--env-file`, reconciles from the tracked config and saves PM2 state so reboot resurrection keeps the invocation.

Do not diagnose this by printing env files or full PM2 dumps. Use the vault-path consistency checker and safe signing-identity diagnostics; any development fallback in a production identity is a failure, not permission to reseal data with a replacement key.

## Direct listener and process reconciliation

PM2 must supervise the listener, not an npm wrapper whose child can retain the port after restart. Next apps execute the Next binary directly; the kernel executes its server, and the development corpus daemon uses Node's in-process TypeScript loader.

`scripts/pm2-reconcile.sh <ecosystem-file> <name>...` compares the stored executable and interpreter with the tracked definition. A stale or absent definition is recreated; a matching one uses the ordinary file-based restart. Before start, unowned listeners are reaped through the shared port helper. Failure to free a port, query PM2 or reconcile a process fails deployment rather than masking it with a cold start.

`PORT_REAP_FAILED` means `scripts/lib/reap-port.sh` cannot free a required listener; the app is not started and the build exits with code 1.

The workflows save process state and run `scripts/assert-pm2-listeners.sh` to establish listener ownership. An intentional stopped-process snapshot is preserved across build/restart selection, except for the explicitly deployed production kernel. Consult the workflow and shared selector for cron-worker handling.

Each ecosystem app has an explicit shutdown timeout. Do not shorten it to PM2's default or use an npm wrapper to work around a stale invocation.

## PM2 restart and stopped-service checks

`scripts/check-pm2-restarts.sh` compares restart counters within a sliding window and reports crash loops. `scripts/check-pm2-status.sh` reports parked errored/stopped declared apps, respecting intentional stops and one-shot policy. `scripts/pm2-health-check.sh` runs the install preflight and both checks with the worst exit result.

The deploy workflows run the idempotent `scripts/install-pm2-health-cron.sh` per environment and execute a post-deploy check. The schedule logs problems in the environment's PM2 health log. Optional webhook configuration is stored in a protected file rather than embedded in crontab. Without a webhook, failures remain in logs and deployment results.

- `PM2_ALERT_WEBHOOK` is the optional repository secret used by the installer, stored in the protected `~/.config/imajin/pm2-alert-webhook.<scope>` file for cron.
- `RESTART_ALERT_WEBHOOK` overrides the restart-check webhook in the environment; keep its value out of crontab and logs.
- `RESTART_ALERT_THRESHOLD` is the maximum tolerated restart increase in the window (default 5); a larger increase alerts.
- `RESTART_ALERT_WINDOW` is the restart sampling window in seconds (default 600).
- `RESTART_ALERT_STATE` selects the restart sample file (default `~/.cache/imajin/pm2-restarts.<scope>.json`).
- `STATUS_ALERT_WEBHOOK` selects the stopped-service webhook, falling back to `RESTART_ALERT_WEBHOOK` and then the protected scope file.
- `STATUS_ALERT_REPEAT` is the repeat interval in seconds for an unchanged app/status alert (default 3600); a newly observed pair alerts immediately.

A quiet restart counter is not proof that a parked process is healthy. Process status, HTTP liveness and aggregate readiness remain separate signals.

## Kernel cron scheduler

`apps/kernel/src/cron/schedule.ts` declares job paths, UTC schedules and overlap policy. One `*-kernel-cron` process per environment runs the scheduler directly with Node's TypeScript loader and kernel bootstrap configuration. `CRON_BASE_URL` must match the kernel's loopback port.

The scheduler obtains its cron bearer from a live vault grant into memory; do not hand-set a cron secret. Provisioning creates the bootstrap identity and grant before check-env/build. Missing custody or authority fails closed; the bounded boot retry is not permission to bypass it.

A job does not overlap itself. Logs contain job, outcome, HTTP status and duration, never the bearer. The authenticated cron-status projection reports last run, stale ticks and whether the scheduler has recorded state. Each cron route refuses missing vault custody or a wrong bearer.

Rotation uses the existing vault approval rail. The kernel resolves the current secret, while the scheduler fetches its grant at boot. The cron manifest guard rejects route/schedule drift. Apps own their schedulers outside this workspace.

- `CRON_STATE_PATH` overrides the scheduler state file, which defaults to `apps/kernel/.cron-state.json`.
- `CRON_VAULT_FETCH_TIMEOUT_MS` bounds the boot-time vault-fetch retry window in milliseconds (default 120000); exhaustion fails closed.
- `scripts/ci-guard-cron-manifest.mjs` checks cron route/schedule agreement through `scripts/__tests__/ci-guard-cron-manifest.test.mjs` in CI.

## Scoped pay callers and card rail

Deploy the kernel contract before app callers. Approve required refund and pledge-charge service scopes through the operator-countersigned app-service scope flow; registration or a shared pay key does not replace scoped authority.

Legacy pledges without app-bound setup transactions require fresh setup. Reconcile ambiguous/interrupted charges before retrying rather than assuming processor idempotency lasts indefinitely. Session-cookie topups create pending funding, not direct credits of caller-supplied cash.

Node-owned Stripe topup sells receipt-backed MJN, not emitted MJNx. Its connector belongs to the node DID, not the human operator or buyer. Historical withdrawal reconciliation reads that account; supported withdrawal requests use the documented rail. Unconfigured node custody yields the explicit card-rail configuration error without preventing kernel startup.

`NODE_CARD_RAIL_NOT_CONFIGURED` means the node's card rail is not configured: topup returns HTTP 503 and the Stripe withdrawal adapter reports the same error; kernel startup remains available.

Operator setup, separately per environment:

1. Resolve the node's public identity from the registry contract and confirm it matches the bootstrapped node identity.
2. Create a restricted Stripe credential with Checkout Sessions write, Payment Intents read and Webhook Endpoints write; historical transfer reconciliation also needs Transfers read. Do not use a full-access key.
3. Enter it only through the authenticated masked Stripe connector input over TLS in that node's authorized context. The flow seals the API key, provisions the per-owner webhook and seals its signing secret separately.
4. Approve both readable vault custody and the node owner's Stripe event scope. A bare sealed field without a live grant/webhook is not a configured rail.
5. Inspect metadata-only connector status and webhook delivery, then verify a test-mode topup completes and credits MJN once. Revocation must make the next attempt refuse; clients do not cache unsealed keys.

If node-owner context is unavailable, leave the rail disabled until properly provisioned. Generic vault Set/Rotate does not replace connector webhook provisioning and scope approval. Never paste credentials into chat, source, shell history, env files, logs or diagnostic responses.

See the [pay spec](https://jin.imajin.ai/pay/api/spec) and [registration contract](../docs/REGISTRATION.md).

## Independently owned apps and corpus

Coffee, dykil, events, learn, links and market own their source, PM2 definitions, builds, migrations and deployment procedures. Kernel-only nodes need no checkout of those apps. The [environment guide](../docs/ENVIRONMENTS.md) retains their routing/port configuration.

An app process retaining an environment-prefixed name can still be bounced by the kernel's name-based restart selection. That does not transfer build or schema ownership. Reconcile the actual working directory and public health before claiming a cutover; do not run a frozen removed-app build against drifting dependencies.

App schemas, rows and recorded migration history remain intact. For legacy webhook consumers, keep matching service URLs and bearer secrets until each receiver's signed-webhook deployment is verified. The additive kernel signature alone does not establish receiver support. Consult the owned app runbook and [webhook security guide](../docs/security/kernel-webhooks.md).

- Keep `COFFEE_SERVICE_URL` and `COFFEE_WEBHOOK_SECRET` set while coffee uses its legacy Bearer.
- Keep `LEARN_SERVICE_URL` and `LEARN_WEBHOOK_SECRET` set while learn uses its legacy Bearer.
- Keep `MARKET_SERVICE_URL` and `MARKET_WEBHOOK_SECRET` set while market uses its legacy Bearer.

Each kernel secret must match the receiver's `WEBHOOK_SECRET`.
`kernel-webhook-legacy.ts` attaches the Bearer only while that secret is set;
the detached signature is additive. Remove compatibility configuration only
after that receiver's signed verification is deployed and verified.

### Events rollback

Events uses its owned prior deployment ref with a matching build/dependency set through the standard approved workflow. Verify working directory, listener, prefixed health and PM2 persistence. The removed kernel copy is not a rollback target, and no SQL/data rollback follows from a code rollback.

### Corpus placement

The production ecosystem has no corpus entry; recorded production placement is on a separate host. Development corpus remains an ecosystem-owned daemon. Configure the actual service URL and follow the [corpus runbook](../apps/corpus/README.md) for source-owner grants, OAuth selection and separately authorized migration.

Check-env uses ecosystem working directories to decide whether a missing service environment is a target error or a non-target warning. Do not add a fictitious production daemon merely to suppress a warning.

## SSH and inference deployment

The [vault SSH action contract](../docs/deploy/vault-ssh-deploy.md) requires repository/environment-bound authority, verified OIDC, pinned public host keys, host CA/principal policy and non-swappable ephemeral keys. Source fixtures do not establish host trust.

The [inference updater](infer-passthrough/README.md) is separate systemd automation with exact-SHA successful production deployment evidence and declared-mode health gates. Installation and privileged runner configuration are operator prerequisites, not consequences of a kernel source merge.

## Build exit codes

| Code | Meaning |
|---|---|
| `0` | Builds, listener clearing and required restarts succeed. |
| `1` | A build fails or an orphan listener cannot be cleared. |
| `2` | Builds and ports are ready, but a required restart/cold-start fails. |

Any nonzero result fails the workflow. Use [rollback guidance](../docs/ops/ROLLBACK.md) and the [baseline contract](../migrations/BASELINE.md) for recovery; migrations remain forward-only and recorded rows are not rewritten.

`scripts/build-restart-failed.test.sh` covers `RESTART_FAILED`: builds and port clearing can succeed while required PM2 restart and cold-start both fail, producing exit code 2 rather than a green deployment.
