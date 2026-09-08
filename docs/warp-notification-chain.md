# The Warp notification chain: kernel half

This is the kernel-side counterpart to
[`openclaw-imajin-plugin`'s `docs/warp-wake-chain.md`](https://github.com/ima-jin/openclaw-imajin-plugin/blob/main/docs/warp-wake-chain.md)
(PR #14). That document picks up at Hop 4 (the plugin's WS receive) and traces
forward to the agent turn; this one starts at the Warp platform and traces
forward to the WebSocket frame the plugin receives, so the two meet exactly at
the WS boundary (`ws-server.js`'s `sendToDid`) without overlap.

Citations are `ima-jin/imajin-ai` at `main`, after PR #2033 (merged
2026-09-05T21:26:40Z, "fix(warp): run lifecycle — timeout is not terminal,
resumed runs re-observed"), which is itself the fix for #2032. Prod ran #2033
from ~18:10 EDT 2026-09-05.

## The chain at a glance

```
Warp platform run state                                    (no webhooks exist)
  |
  v
[1] Kernel poll: in-request watch OR scheduled sweep observes terminal/still-running/timeout state
  |   apps/kernel/src/lib/warp/dispatch.ts (watchRun, pollUntilTerminal)
  |   apps/kernel/src/lib/warp/run-watch-sweep.ts (sweepInFlightWarpRuns, checkOneRun)
  v
[2] publish() fans the event out: durable log write + configured reactor chain
  |   packages/bus/src/publish.ts, packages/bus/src/subscriptions.ts (deliverToSubscribers)
  |   packages/bus/src/config.ts (DEFAULTS — replaced by a kernel.bus_chain_configs row if one exists)
  v
[3] notify reactor -> POST /notify/api/send -> notifications row + WS push
  |   packages/bus/src/reactors/notify.ts, apps/kernel/app/notify/api/send/route.ts,
  |   apps/kernel/src/lib/notify/ws-push.ts, apps/kernel/ws-server.js (sendToDid)
  v
WebSocket frame reaches the connected agent (openclaw-imajin-plugin picks up here, Hop 4)
```

## Hop 1 — Kernel observes the run

Two kernel-side pollers exist, both funnelling through the same three publish
functions:

- **In-request watch** — `dispatchAgentRun` fires `watchRun` fire-and-forget
  right after the dispatch route responds 201
  (`apps/kernel/app/warp/api/dispatch/route.ts:214`, `void watchRun(...)` —
  deliberately un-awaited so a 30-minute watch never turns a 201 into a
  timeout). `watchRun` (`dispatch.ts:2235`) calls `pollUntilTerminal`
  (`dispatch.ts:1930`), polling on `WATCH_POLL_INTERVALS_MS`
  (`dispatch.ts:1426`, `[5s, 10s, 30s, 60s]` then held) up to `WATCH_TIMEOUT_MS`
  (`dispatch.ts:1429`, 30 minutes). **The followups route now arms a second
  in-request watch for a resumed run** (#2055), immediately after
  `sendFollowup` reports `ack.resumed` — see "Resume lifecycle (#2055)"
  below.
- **Scheduled sweep** — `sweepInFlightWarpRuns` (`run-watch-sweep.ts:366`),
  invoked from `GET /api/cron/warp-run-watch` on a 10-minute cron tick
  (`apps/kernel/vercel.json`). It lists every run whose latest
  `warp.agent.dispatched`/`warp.run.resumed` activity is newer than its
  latest terminal row (`listInFlightRuns`, `run-watch-sweep.ts:169`) and
  re-checks each one (`checkOneRun`, `run-watch-sweep.ts:318`).

**Outcome on success**, from either poller, is one of:
- `publishTerminalRunOutcome` (`dispatch.ts:2124`) → `warp.run.completed` or
  `warp.run.failed`.
- `publishBlockedRunOutcome` (`dispatch.ts:2141`) → `warp.run.blocked`.
- In-request watch only: `publishRunStillRunning` (`dispatch.ts:2183`) →
  `warp.run.still_running` when its own 30-minute budget elapses with Warp
  still non-terminal (`watchRun`'s `outcome.kind === 'timeout'` branch,
  `dispatch.ts:2259-2271` — the branch name is a leftover from before #2032;
  it is explicitly **not** a timeout publish any more).
- Sweep only: `publishTimeoutRunOutcome` (`dispatch.ts:2155`) →
  `warp.run.timeout`, reserved for a candidate whose `activityAt` is older
  than `SWEEP_LOOKBACK_MS` (`run-watch-sweep.ts:97`, 6 hours) and still
  non-terminal/non-BLOCKED on that read (`checkOneRun`,
  `run-watch-sweep.ts:342-349`).
- `sendFollowup`'s `resume: true` path (`dispatch.ts:1339`) publishes
  `warp.run.resumed` (via `publishRunResumed`, `dispatch.ts:1284`) when a
  terminal run is handed off to Warp's cloud-to-cloud resume. This is a
  distinct, third trigger — not a poller — but it is what makes a resumed
  segment visible to the sweep at all (its `previousSessionId` is what the
  sweep's segment-aware query reads back, `run-watch-sweep.ts:193-200`).

**`warp.run.timeout` has exactly one emitter in the whole kernel**:
`publishTimeoutRunOutcome`, called from exactly one call site
(`run-watch-sweep.ts:347`), gated on `ageMs > lookbackMs`
(`run-watch-sweep.ts:342-343`, default 6 hours). Verified by
`git grep -n "warp.run.timeout"` across `apps/kernel` and `packages` — see
"Incidents 2026-09-05" (a) below for why this matters.

**Grep:**
```
"Warp cloud agent run reached a terminal state"                              — dispatch.ts:2253
"Warp run watch budget elapsed while the run is still going"                 — dispatch.ts:2269
"Warp run watch sweep: could not list in-flight runs"                        — run-watch-sweep.ts:376
"Warp run watch sweep: could not check run"                                  — run-watch-sweep.ts:389
```

## Hop 2 — `publish()` fans the event out

`packages/bus/src/publish.ts:9` does two things for every event, in order:

1. **`deliverToSubscribers`** (`packages/bus/src/subscriptions.ts:108`),
   fire-and-forget, unconditionally. First writes a durable row to
   `kernel.event_subscription_log` for any event type at least one grant
   scope could entitle (`subscriptions.ts:120-133`) — **this durable write is
   what backs Hop 1's sweep query**, independent of whether any live
   subscriber is connected. Then resolves active grants and pushes a
   `bus_event`-typed WS frame to each entitled external agent
   (`subscriptions.ts:181-207`). The openclaw-imajin-plugin does not consume
   `bus_event` frames (its `dispatchFrame` only special-cases `notification`
   and `chat_message`); this leg only matters here because of the durable
   write.
   - Entitlement is `packages/auth/src/grant-scopes.ts:27`'s
     `warp:dispatch` scope's `eventTypes` list. #2032 found
     `warp.run.resumed` (and added `warp.run.still_running`) missing from
     this list — without it, `capabilities.length === 0` at
     `subscriptions.ts:112` takes the fast-path return and **no durable row
     is ever written**, which is the root cause #2033 fixed for "resumed
     runs never re-observed" (a completely separate bug from anything WS-push
     related).
2. **The configured reactor chain** (`packages/bus/src/config.ts` DEFAULTS,
   replaced wholesale by a `kernel.bus_chain_configs` row if one exists — see
   the comment at `config.ts:318`). Current `warp.run.*` chains:

   | Event | Reactors |
   |---|---|
   | `warp.run.completed` | `emit` + `notify` (`config.ts:320-327`) |
   | `warp.run.failed` | `emit` + `notify` (`config.ts:354-361`) |
   | `warp.run.blocked` | `emit` + `notify` (`config.ts:362-369`) |
   | `warp.run.timeout` | `emit` + `notify` (`config.ts:328-335`) |
   | `warp.run.still_running` | `emit` + `notify` (`config.ts:345-348`, added by #2032) |
   | `warp.run.resumed` | `emit` + `notify` (`config.ts:340`, added by #2032 — previously no chain at all) |
   | `warp.run.progress` | `emit` only (`config.ts:379-381` — telemetry-class, #1805) |

   None of these reactors are `await: true` (`publish.ts:64-70`), so a
   `notify` failure here is logged (`publish.ts:68`) and never blocks or
   fails the call that published the event.

## Hop 3 — `notify` reactor → notification row + WS push

`notifyReactor` (`packages/bus/src/reactors/notify.ts:44`) interpolates the
configured `title`/`body` and calls `@imajin/notify`'s `send()`, which POSTs
to `POST /notify/api/send` (`apps/kernel/app/notify/api/send/route.ts:128`).
That handler, per request:
1. Inserts a row into `notify.notifications` (`route.ts:178-189`,
   `read: false`).
2. If the recipient's `inapp` preference is on (default on,
   `route.ts:169-170`), calls `pushNotificationToDid`
   (`src/lib/notify/ws-push.ts:83`) and records whether it actually reached a
   socket in `channelsSent` (`route.ts:196-221`).

`pushNotificationToDid` POSTs to the internal `/chat/api/internal/did-push`
route, handled by `ws-server.js`'s `setupBroadcastRoute`
(`ws-server.js:399-430`), which calls `sendToDid` (`ws-server.js:347`) — this
is the exact function `openclaw-imajin-plugin`'s wake-chain doc picks up from
on the other side. `sendToDid` sends to every open socket for the DID plus
any delegate registered via `register_also` (`ws-server.js:230-233`,
`also-registry.js`), and reports whether at least one socket was live.

**Server-side redelivery on reconnect (#2044).** A push that finds nobody
connected (`sendToDid` returns `false`) used to be a dead end on the kernel
side beyond the persisted row. It no longer is: `notify.notifications` now
carries a nullable `delivered_at` (migration
`0129_notify_notifications_delivered_at.sql`) that is distinct from `read`.
`ws-server.js`'s connection handler asks the kernel for that DID's
undelivered backlog immediately after sending `{type: 'connected'}`
(`POST /notify/api/internal/backlog` →
`apps/kernel/src/lib/notify/backlog.ts`'s `getNotificationBacklog`, oldest
first, capped at 100), replaying each eligible row as a
`NotificationWsFrame` with `replay: true`
(`apps/kernel/src/lib/ws/notification-backlog.js`).

`GET /notify/api/notifications` and `GET /notify/api/notifications/unread`
still exist for a client to poll, and `openclaw-imajin-plugin` still never
calls either (confirmed by `git grep -n "notifications\|/notify/" src` in
that repo returning no REST call sites) — the kernel-side replay above
means it no longer needs to, per #2044's kernel-side option. See
"Incidents 2026-09-05" (a) and (b) below for the state before this fix, and
"WS heartbeat + ack-confirmed delivery (#2099)" below for what `delivered_at`
means today — #2044's own claim/release design ("claims a row before
attempting the push, releases the claim again if the push does not reach a
socket") is superseded by that section; a live `.send()` no longer sets
`delivered_at` on its own.

**Grep:** `"Notification WS push failed"` / `"Notification WS push error"`
(`ws-push.ts`); `"Notification WS push found no connected socket for
recipient"` (`ws-push.ts`); `"Notification WS claim failed"` /
`"Notification WS claim rollback failed"` (`ws-push.ts`); `"Notification WS
re-offer cap reached"` (`ws-push.ts`, `backlog.ts`).

## WS heartbeat + ack-confirmed delivery (#2099)

**The gap (#2098, Candidate A).** #2044's redelivery design used
`delivered_at` to mean two different things at once: "a live `.send()` call
reported the socket as OPEN" and "the recipient actually has this". Those
collapse to the same thing only if a socket's `readyState` can be trusted —
and it can't, for a peer that crashes without a clean TCP close (a hard
gateway/turn crash rather than a normal disconnect). `ws-server.js` had no
server-side liveness check: only client→server `{type: 'ping'}` handling and
cleanup on the socket's own `close` event, which a crashed peer never fires.
`sendToDid` kept reporting `sent = true` for that socket indefinitely,
`pushNotificationToDid` marked the row delivered on the strength of that,
and `getNotificationBacklog`'s `delivered_at IS NULL` filter then
permanently excluded the row from replay — the exact failure mode that lost
two `warp.run.completed` wakes on 2026-09-08.

**Fix, in two parts.**

1. **Server-initiated heartbeat** (`apps/kernel/src/lib/ws/heartbeat.js`,
   wired into `ws-server.js`). Every tracked socket is `ws.ping()`'d on a
   30s interval; a `pong` marks it alive again. A socket that misses two
   consecutive pongs is presumed dead: `ws.terminate()`d, removed from
   `didSockets`/`socketMeta` immediately (`cleanupSocket`, shared with the
   normal `close` handler via a `cleanedUpSockets` guard so the two paths
   never double-run), and has its DID's un-acked WS claims released
   (`releaseWsClaimsForDid`, via `POST /notify/api/internal/release`) — all
   before the underlying connection is actually torn down.
2. **Ack-confirmed delivery.** The plugin sends an explicit frame once it
   has actually processed a notification:
   ```json
   { "type": "notification_ack", "id": "<notification id>" }
   ```
   `ws-server.js`'s message handler forwards this to
   `POST /notify/api/internal/ack`, which calls
   `ackNotificationDelivery` (`apps/kernel/src/lib/notify/delivery.ts`) —
   the **only** place `delivered_at` is ever set now. It is a no-op, not an
   error, for an unknown or already-acked id (an atomic
   `UPDATE ... WHERE delivered_at IS NULL RETURNING`), since the plugin
   dedups by notification id on its own and a duplicate/late ack has
   nowhere useful to report a failure to anyway.

**Claim lifecycle.** Migration `0131_notify_notifications_ws_ack.sql` adds
two columns that separate "attempted a WS send" from "confirmed delivered":
`ws_sent_at` (claim/attempt timestamp) and `ws_attempts` (cumulative attempt
count). `claimNotificationForWsSend` is the atomic guard both a live push
and a backlog replay claim through — eligible when `delivered_at IS NULL`,
`ws_attempts < 3`, and `ws_sent_at` is either `NULL` or older than the 30s
ack timeout. A claim records the attempt (`ws_sent_at` = now, `ws_attempts`
+ 1) but never touches `delivered_at`. Three ways a claimed-but-unacked row
becomes eligible again:
- **Timeout** — once `ws_sent_at` is more than 30s old, the next backlog
  fetch's claim attempt simply succeeds again (no explicit "release" step
  needed — the eligibility check itself is time-based).
- **Heartbeat release** — `releaseWsClaimsForDid` resets `ws_sent_at` to
  `NULL` for every un-acked row belonging to a DID whose socket the
  heartbeat just terminated, so a fast reconnect does not have to wait out
  the 30s timeout. Leaves `ws_attempts` untouched: that send genuinely
  reached a socket the server believed was live, so it still counts as a
  spent re-offer.
- **Rollback** — `rollbackWsClaim` fully undoes a claim that never actually
  reached a live socket at all (no open connection found, or the internal
  push route itself failed): resets both `ws_sent_at` and decrements
  `ws_attempts`, since a send that never left the server should cost
  nothing.

**Compat / anti-storm cap.** An old plugin build that never sends the ack
frame must not be re-offered the same notification forever across
reconnects: `ws_attempts` caps re-offers at 3 (`WS_MAX_ATTEMPTS`,
`delivery.ts`), and both `ws-push.ts` and `backlog.ts` log a `warn` the
moment a claim spends the last permitted attempt (`"Notification WS
re-offer cap reached"`). The row still exists and is still readable via
`GET /notify/api/notifications`; it simply stops being re-pushed over WS.

## Incidents 2026-09-05

### (a) 19:09:01 `warp.run.timeout` for a run only ~45 minutes old

**Kernel is clean here.** `warp.run.timeout` has exactly one emitter in the
kernel (`publishTimeoutRunOutcome`, `dispatch.ts:2155`), called from exactly
one site (`run-watch-sweep.ts:347`), which only fires when
`ageMs > lookbackMs` — `SWEEP_LOOKBACK_MS` is 6 hours
(`run-watch-sweep.ts:97`). A run ~45 minutes past its dispatch/resume
activity cannot reach that branch: `checkOneRun` (`run-watch-sweep.ts:318`)
would classify it as `stillInFlight` (if `INPROGRESS`/`QUEUED`) long before
the age check, and the in-request watch's own 30-minute-budget branch
publishes `warp.run.still_running`, never `warp.run.timeout`
(`dispatch.ts:2259-2271`) — that rename is the entire point of #2033.

There is also no kernel-side mechanism that could re-deliver a **stale**
pre-#2033 `warp.run.timeout` notification row at 19:09:01: there is no
redelivery-on-reconnect job anywhere in the kernel (see Hop 3 above — no cron
in `vercel.json` touches `notify.notifications`, and `ws-server.js`'s
connection handler pushes nothing on connect, only `{type: 'connected'}` /
`{type: 'auth_required'}`, `ws-server.js:257,263,278`). If a genuinely
pre-#2033 timeout notification existed as an unread row, the only way it
reaches the plugin at 19:09:01 is the plugin itself reading it back — which,
per Hop 3, it has no code path to do. So there is neither (i) a second
kernel-side timeout emitter #2033 missed, nor (ii) a kernel-side sweep that
re-delivers unacked notification rows.

This is consistent with `openclaw-imajin-plugin` PR #14's own conclusion for
the same timestamp: the `19:09:01` lines it traced are `createNotificationInjector`'s
one-time startup banner (printed on plugin/gateway restart, listing
*configured* `injectScopes` — `warp.run.timeout` included because that scope
is configured to wake the agent, not because a timeout notification arrived
then) — a plugin-side log-format artifact, not a live WS frame. Nothing on
the kernel side contradicts that; if anything, the kernel evidence here
(single emitter, 6-hour gate, no redelivery path) independently rules out
the alternative "genuine kernel event" explanation the task raised.
**No fix applied for (a)** — there was no kernel defect to fix.

### (b) Two completions (18:58, 19:03) that did not push live

Two real, independent gaps found in Hop 3, both fixed in this PR:

1. **The "nobody connected" branch was completely silent.**
   `pushNotificationToDid` (`ws-push.ts`) logged `error` when the internal
   route returned non-2xx or the fetch itself threw, but when the route
   responded 200 with `{ delivered: false }` (i.e. `sendToDid` found no open
   socket for the recipient DID) — the single most likely explanation for a
   completion notification that "did not push live" while the row was
   written fine — **nothing was logged at all**. Fixed: that branch now logs
   a `warn` (`ws-push.ts:109-113`), so a future incident shows up in a plain
   log grep instead of requiring a database query to reconstruct.
2. **No aggregate visibility.** Even with logs, an operator had no
   single place to see "how many live pushes have missed recently" without
   grepping every kernel instance's logs. `GET /notify/api/health`
   (`apps/kernel/app/notify/api/health/route.ts`) now reports
   `recentWsPushMisses`: a count, over the last hour, of notifications where
   the in-app channel was eligible but `channelsSent` never gained `ws`
   (`route.ts:31-49`) — derived from the `notifications` row Hop 3 already
   writes, no new table or service. The count query degrades to omitting the
   field (never failing the health check) if the DB read itself has trouble.

Whether the specific 18:58/19:03 misses were "nobody connected" (WS
briefly down) or something else is not fully reconstructable from source
alone — that is exactly what these two fixes are for going forward. Reactor
ordering was checked and ruled out as a contributing cause: `notify` is not
`await: true` for `warp.run.completed` (`config.ts:320-327`,
`publish.ts:64-70`), so it never blocks or is blocked by anything else in the
chain; the two completions running through the same, single-purpose `notify`
call path as every other `warp.run.completed` rules out ordering as a
distinguishing factor between a push that lands and one that doesn't.

### (c) Resumed run at 16:15 producing no second `warp.run.completed` — and a related dupe risk

**The original #2032 bug (no completion at all for a resumed segment) is
fixed by #2033** and is exercised directly by
`run-watch-sweep.test.ts`'s "is visible to the sweep again even though its
first segment already completed" test
(`apps/kernel/src/lib/warp/__tests__/run-watch-sweep.test.ts:367-381`):
`listInFlightRuns`'s timestamp comparison (latest dispatch-or-resume activity
vs. latest terminal row, `run-watch-sweep.ts:221-222`) makes a resumed
segment visible to the sweep again even though the run's first segment
already has a `warp.run.completed` row, and `resumeContextFor`
(`run-watch-sweep.ts:265-268`) attaches `resumedFrom`/`segment` to that
segment's own completion.

**Auditing this further surfaced a real, separate defect**: neither
`watchRun`'s terminal branch (`dispatch.ts:2244-2256`) nor the sweep's
`checkOneRun` (pre-fix) checked whether the *other* poller had already
published a terminal outcome for the same run before publishing their own.
A fresh (non-resumed) run dispatched via `POST /warp/api/dispatch` starts an
in-request `watchRun` that can stay alive for up to 30 minutes
(`dispatch.ts:214`, `WATCH_TIMEOUT_MS`), while the sweep independently
re-checks every in-flight run every 10 minutes
(`apps/kernel/vercel.json`). Any run that survives past one sweep tick while
still being watched in-request — common for anything longer than a couple of
minutes — has a real window where both the watch's poll and a sweep tick can
call `getAgentRun`, both observe the same terminal state, and both call
`publishTerminalRunOutcome`/`publishTimeoutRunOutcome`, producing **two**
`warp.run.completed` (or `.failed`/`.timeout`) events for one run — a real
duplicate notification and, per the plugin's own wake chain, a real
duplicate agent wake. (At the time of this writing, resumed segments were
not at risk of this specific race: `sendFollowup`'s resume path,
`dispatch.ts:1339-1393`, never started an in-request watch, so only the
sweep ever observed a resumed segment. #2055 changed this — the followups
route now arms its own in-request watch for a resumed segment too, so that
segment gets the same watch-vs-sweep race the claim in the "#2043 update"
note below already closes for segment 1. See "Resume lifecycle (#2055)"
below.)

**Fixed in this PR**, inside the existing pattern
(`hasPublishedBlockedNotice`, `run-watch-sweep.ts:252-262`, already re-checks
the durable log immediately before publishing to avoid re-notifying a known
BLOCKED run): a new `hasTerminalEventForSegment` guard
(`run-watch-sweep.ts:291-302`) re-checks `kernel.event_subscription_log` for
a terminal row at-or-after the candidate's `activityAt` (i.e. for *this*
segment specifically, so an older segment's terminal row never blocks a
resumed segment's own completion) immediately before the sweep's
`checkOneRun` calls `publishTerminalRunOutcome` or
`publishTimeoutRunOutcome`. A skip is counted in the new `SweepOutcome.skippedRace`
field rather than `completed`/`failed`/`timedOut`, since nothing was
published. This closed the common, most-likely-to-actually-fire direction
(sweep racing an in-request watch that has been running for several
minutes), but left the smaller reverse window open — the in-request watch
publishing moments after a sweep tick has already read but not yet
published, since neither's durable row exists yet for the other to see via
a plain re-check. That reverse direction was filed separately as #2043
rather than folded into this fix.

Regression tests added:
- `run-watch-sweep.test.ts` → describe block "race with the in-request
  watch": a candidate with a pre-existing terminal row at-or-after its
  `activityAt` is skipped, not double-published, for both the terminal and
  timeout paths; a legitimately-resumed segment with no such row still
  publishes normally.
- `watch-run.test.ts`'s existing "(#2032 acceptance)" test already pins
  exactly one `warp.run.completed` and zero `warp.run.timeout` across a
  still-running-then-succeeded sequence.

**#2043 update: the reverse direction is now closed too.** Both directions
of this race are now closed by the same DB-level idempotent claim,
`kernel.warp_terminal_publish_claims` (migration 0128, one row per
`(run_id, segment)`), inserted via `INSERT ... ON CONFLICT DO NOTHING
RETURNING`. `claimTerminalPublish` (`run-watch-sweep.ts`) is the one shared
helper both `checkOneRun` and `watchRun`'s terminal branch
(`dispatch.ts`) call immediately before publishing a terminal outcome — the
first of the two to insert for a given `(runId, segment)` wins and
publishes; the other gets zero rows back and skips, counted in
`SweepOutcome.skippedRace` on the sweep side. This is now the actual
authority; `hasTerminalEventForSegment` remains in place only as a cheap
pre-check that avoids a needless claim attempt in the common case.
`watchRun`'s own DB-free design (see `dispatch.ts`'s module doc) is
preserved: the claim function is injected via `WatchRunOptions`, with the
real, DB-backed implementation wired in at the dispatch route's one
production call site (`apps/kernel/app/warp/api/dispatch/route.ts`) rather
than imported into `dispatch.ts` directly.

Regression tests added for #2043:
- `run-watch-sweep.test.ts` → `claimTerminalPublish` describe block: the
  first claim on a `(runId, segment)` pair resolves `true`, a second claim
  on the same pair resolves `false`, and different segments/runs claim
  independently.
- `run-watch-sweep.test.ts` → "race with the in-request watch": a claim
  already won by another publisher is skipped even when
  `hasTerminalEventForSegment` sees no durable row yet, for both the
  terminal and timeout paths, and a resumed segment claims its own segment
  number rather than colliding with an earlier one.
- `watch-run.test.ts` → "terminal publish claim guard" describe block: the
  watch claims segment 1 before publishing, skips the publish when the
  claim is lost, and still publishes unconditionally when no claim function
  is injected (unchanged pre-#2043 behaviour for callers that opt out).
- `terminal-publish-claim-race.test.ts` (new): the acceptance test — the
  real `watchRun` and the real `claimTerminalPublish` sharing one in-memory
  idempotent-claim double, producing exactly one terminal publish for both
  orderings (sweep claims first vs. watch claims first) and under true
  concurrency (`Promise.all` of two simultaneous claims for the same
  segment).

### (d) 22:24:56 completion tonight — kernel's responsibility ends at the WS frame

For an ordinary (non-resumed, non-stale) run reaching `SUCCEEDED`, the
in-request watch publishes exactly one `warp.run.completed`
(`dispatch.ts:2255`, `publishTerminalRunOutcome` with no `resumeContext`),
which Hop 2/3 turns into one `notifications` row and one immediate WS push
attempt (`route.ts:200-204`) — no batching, no delay, no queue on the kernel
side between "run observed terminal" and "push attempted". The plugin's own
receipt nine seconds later (22:25:05) is consistent with that being a single,
immediate live push rather than anything queued.

The kernel's responsibility ends at the WS frame leaving `sendToDid`
(`ws-server.js:347`) successfully — i.e. at the exact point
`openclaw-imajin-plugin`'s wake-chain doc picks up (its Hop 4, WS receive).
The 22:30 failure (a reserved `:` in a cron tag rejecting the scheduled wake
turn) is entirely inside `openclaw-imajin-plugin`/openclaw-core's Hop 6/7
(`schedulePluginSessionTurn`'s tag validation) — not investigated further
here, per scope.

## Resume lifecycle (#2055)

A fresh dispatch has always had two independent paths to its terminal
outcome: the in-request watch AND the scheduled sweep. A resumed run
(`sendFollowup`'s `resume: true` path, #1939) did not — before #2055, its
second (and every later) terminal was observed by the sweep alone (see (c)
below), so a resumed run's outcome was both slower to surface (bounded by
the sweep's 10-minute cron rather than the watch's sub-minute poll schedule)
and had a single point of failure a fresh dispatch never had.

**Confirmed root cause.** Neither part of that gap was closed by #2032/#2033
or #2043/#2049, despite both already being live on `main`: `sendFollowup`
(`dispatch.ts:1385-1442`) published `warp.run.resumed` and nothing else — it
never re-armed `watchRun` — and #2049's claim table
(`kernel.warp_terminal_publish_claims`, migration 0128) already keys on
`(run_id, segment)`, not `run_id` alone, so it was never at risk of deduping
a resumed run's second terminal against its first. The sweep's
segment-aware `listInFlightRuns`/`checkOneRun` (#2032) already re-observes a
resumed segment and attaches its `resumedFrom`/`segment` marker correctly.
What was missing is redundancy and latency parity with a fresh dispatch, not
correctness of the sweep path itself.

**Fix.** The followups route (`apps/kernel/app/warp/api/runs/[runId]/followups/route.ts`)
now re-arms `watchRun` immediately after `sendFollowup` reports
`ack.resumed !== undefined` (i.e. this call actually resumed an
already-terminal run):
1. `countPriorResumes(runId)` (`run-watch-sweep.ts`) is read **before**
   `sendFollowup` is called, counting `warp.run.resumed` rows already
   durably logged for this run. Reading it first — rather than after —
   avoids racing this resume's own fire-and-forget durable-log write
   (`deliverToSubscribers`, `packages/bus/src/publish.ts:24-26`).
2. `sendFollowup` proxies the resume and, when it actually resumed a
   terminal run, returns `{ ..., resumed: { previousSessionId } }`
   (`WarpFollowupAck.resumed`).
3. The route calls `void watchRun(acting.did, run.runId, { claimTerminalPublish,
   resumeContext: { resumedFrom: ack.resumed.previousSessionId, segment: priorResumes + 2 } })`
   — fire-and-forget, identically to the dispatch route's own call.
4. `watchRun`'s terminal branch (`dispatch.ts:2292-2337`) claims
   `resumeContext.segment` instead of the hardcoded `1` and passes
   `resumeContext` through to `publishTerminalRunOutcome`, so the resumed
   segment's completion carries the same `resumedFrom`/`segment` generation
   marker the sweep already attaches when it is the one to observe it.

Because the claim is already keyed by `(run_id, segment)`, a re-armed watch
and the sweep racing the very same resumed segment dedupe exactly like a
fresh run's watch and the sweep already did for segment 1 — no change to
`claimTerminalPublish` or migration 0128 was needed.

## Follow-ups filed

- [#2043](https://github.com/ima-jin/imajin-ai/issues/2043) — **resolved.**
  Closed the remaining (smaller) direction of the (c) race: sweep
  publishing, then the in-request watch independently publishing moments
  later for the same segment. Implemented with a DB-level idempotent claim
  table (`kernel.warp_terminal_publish_claims`, migration 0128) rather than
  an advisory lock — see the "#2043 update" note under (c) above for the
  full design and the tests that pin it. `dispatch.ts` keeps its no-DB-
  dependency design: the claim function is injected into `watchRun` via
  `WatchRunOptions` and wired to the real, DB-backed implementation only at
  the dispatch route's call site.
- [#2044](https://github.com/ima-jin/imajin-ai/issues/2044) — **fixed,
  kernel-side.** A missed live push used to be invisible to the agent until
  a human happened to check the `/notify` page. `ws-server.js` now replays a
  reconnecting DID's undelivered backlog itself (see the redelivery
  paragraph in Hop 3 above), so the plugin needs no client-side catch-up
  read of `GET /notify/api/notifications`/`/unread` to get this guarantee.
  Superseded in part by #2099 below: the original design's `delivered_at IS
  NULL` claim conflated "attempted a WS send" with "confirmed delivered".
- [#2098](https://github.com/ima-jin/imajin-ai/issues/2098) /
  [#2099](https://github.com/ima-jin/imajin-ai/issues/2099) — **fixed.** A
  dead gateway socket (crashed without a clean close) could still be marked
  `delivered_at` by a live `.send()` that reported `readyState === OPEN`,
  permanently stranding the notification from `getNotificationBacklog`'s
  replay. See "WS heartbeat + ack-confirmed delivery (#2099)" above for the
  server-initiated ping/pong heartbeat and the plugin's explicit
  `notification_ack` frame that now gate `delivered_at`.
