# The Warp notification chain: kernel half

The kernel observes authorized cloud runs and delivers notifications to the
recipient DID. The [plugin wake-chain guide](https://github.com/ima-jin/openclaw-imajin-plugin/blob/main/docs/warp-wake-chain.md)
owns what happens after the plugin receives the WebSocket frame. A delivered
notification is not proof of an executed agent turn or a completed command.
Wire schemas and access controls live in the
[Jin spec](https://jin.imajin.ai/jin/api/spec) and
[notify spec](https://jin.imajin.ai/notify/api/spec).

## Observation and terminal publication

The dispatch and follow-up routes arm an in-request `watchRun`; the scheduled
`sweepInFlightWarpRuns` provides recovery through the same outcome publishers.
The watcher polls with increasing intervals and has a thirty-minute budget.
Budget exhaustion publishes `warp.run.still_running`, not a terminal timeout.
The scheduler invokes the sweep every ten minutes.

`WATCH_POLL_INTERVALS_MS` uses 5, 10, 30 and then 60 seconds, holding the final
interval until `WATCH_TIMEOUT_MS`. `SWEEP_LOOKBACK_MS` is six hours measured
from dispatch/resume activity, not from the current poll. The subscription log's
fourteen-day retention bounds recovery history independently of that lookback.
The sweep reads each stale candidate once more: a completed run is reported as
completed, not relabelled timeout because its observation was late.

The sweep derives candidates from durable `warp.agent.dispatched` and
`warp.run.resumed` activity in `kernel.event_subscription_log`. A run is in
flight when its latest activity is newer than its latest terminal record.
Resuming a completed run therefore makes a new segment observable. The follow-up
route counts prior resumes before publishing the new resume and passes the new
segment context to its watcher.

A terminal read produces `warp.run.completed` or `warp.run.failed`; a blocked
read produces `warp.run.blocked`. Only the sweep publishes `warp.run.timeout`,
and only after the latest activity is over six hours old and a fresh read is
still neither terminal nor blocked. This is a kernel observation budget, not a
claim that the external runtime was forcibly stopped.

Both observers must win `claimTerminalPublish` for `(runId, segment)` before
publishing a terminal outcome. The DB's conflict-safe insert is the race guard;
a durable-log pre-check is only an optimization. Different resumed segments
claim independently. Observation errors are logged and counted, not converted
into invented successful outcomes.

`publishTerminalRunOutcome`, `publishBlockedRunOutcome`,
`publishRunStillRunning`, `publishTimeoutRunOutcome` and `publishRunResumed`
provide the common outcome paths. Cancelled terminal runs follow the completion
path; failed runs follow failure. The sweep counts checked, completed, failed,
blockedNotified, stillInFlight, timedOut, skippedRace and errors separately.
`hasTerminalEventForSegment` is a pre-check; the claim remains authoritative
when both observers read before either durable event exists.

Source: `apps/kernel/src/lib/warp/dispatch.ts`, `run-watch-sweep.ts`, the dispatch
and follow-up route adapters, and `apps/kernel/src/cron/schedule.ts`.

## Bus and notification persistence

`publish()` fans out through two separate paths:

1. Grant-scoped event subscriptions persist eligible events and offer `bus_event`
   frames to authorized agents. The durable subscription log supports recovery
   independently of whether a live socket exists.
2. The configured reactor chain emits the record and/or sends notifications.
   An exact-scope or node-default `kernel.bus_chain_configs` row can replace code
   defaults; inspect configuration rather than assuming defaults prove live setup.

Lifecycle defaults for completed, failed, blocked, timeout, still-running and
resumed events include emit and notify. Progress defaults are emit-only.
Fire-and-forget notification failure is logged without failing the operation
that published the event. These guarantees do not amount to an exactly-once
end-to-end agent wake.

The notify reactor uses the notify SDK. Internal callers use the vault-resolved
internal credential; external apps need an app-service token with the live
operator-approved endpoint scope. A rejected app credential must not downgrade
to internal authority. See [the approval notification contract](notify-operator-approvals-contract.md).

The send handler stores `notify.notifications` and, when the recipient's in-app
preference allows, attempts a DID-addressed push. `pushNotificationToDid` uses
the kernel's internal did-push transport; `ws-server.js` sends to open sockets
and authorized delegated notification recipients. A socket reporting OPEN only
means transport can be attempted, not that the peer processed the frame.

## Ack-confirmed delivery and reconnect

`read`, `delivered_at`, `ws_sent_at` and `ws_attempts` mean different things:

- `read` is the recipient's UI state.
- `ws_sent_at` claims an attempt; it does not mark delivery.
- `ws_attempts` counts offered sends, capped at three.
- `delivered_at` is set only after an explicit `notification_ack`, scoped to the
  authenticated socket DID and notification recipient. Another DID cannot ack
  the row even if it knows the id; unknown/already-acked rows are safe no-ops.

Live push and reconnect backlog share the same atomic claim. A still-unacked
claim becomes eligible after thirty seconds. A push that reaches no socket
rolls back both claim time and attempt count. A socket lost to heartbeat releases
its unacked claim times without refunding the attempts.

The server pings tracked sockets every thirty seconds and terminates one that
misses two consecutive pongs, removing it from routing and releasing its claims.
On reconnect it offers the oldest eligible backlog rows, capped at one hundred,
as replay notifications. Clients deduplicate by notification id and ack only
after processing. Hitting the three-offer cap logs a warning and stops WS replay,
but the notification remains readable through the authenticated notify API.

Source: `apps/kernel/src/lib/notify/delivery.ts`, `backlog.ts`, `ws-push.ts`,
`apps/kernel/src/lib/ws/heartbeat.js`, `notification-backlog.js`, and `ws-server.js`.

## Diagnose the boundary that failed

Check run activity and segment before interpreting a timeout. Compare the
terminal publish claim, durable event, notification row, push attempt and ack
separately. `recentWsPushMisses` in notify health summarizes recent eligible
notifications without a successful WS channel; it does not prove plugin execution.

Search for `Notification WS push failed`, `Notification WS push error`,
`Notification WS push found no connected socket for recipient` and
`Notification WS re-offer cap reached`. A persisted notification without an ack
is not a delivered agent turn. A notification accepted by the plugin can still
fail later in its own scheduling/execution path; use the plugin's runbook there.
Do not dump credential-bearing frames, process environments or message contents.

Run authority and usage metering remain principal-scoped. A selected business is
the effective principal, not the human's personal DID; another principal's run
or usage is not a recovery fallback. Kernel usage recovery and lifecycle replay
use signed dispatch/history, never a gateway transcript or runtime session key.
