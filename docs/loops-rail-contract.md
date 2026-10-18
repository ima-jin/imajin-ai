# Loop registry rail — publisher-authorization contract (#2358, epic #2288/#2290, #2295, #2296, #2338)
Horizon step entries extend this signed rail under #2878; claim lease policy and Runs rendering remain separate.
## Horizon steps (#2878, parent #2313 decision a)

Publish `step.queued|updated|claimed|started|progress|blocked|finished|observed|attested`
through the existing `POST /api/loops` signature and `loops:publish` authorization
boundary. All events carry the common loop envelope plus a nonempty `stepId`.
`loopId` names the **existing owning loop**, not a harness session or the step.
A missing loop or different principal fails with 409. Step observations never
change the owning loop's lifecycle, refs, last-seen time or surface leases.
No gateway RPC, connector polling, harness lookup, session credential or new
secret is involved. The publisher pushes facts; signatures prove who asserted
them, not that GitHub or a deployment actually agrees.

The type-specific data, with no other type-specific block permitted, is:

| Event | Signed data |
| --- | --- |
| `step.queued` | `step: {stepKind: "code" \| "human" \| "ops", intention, rank, repository?, exitConditions}`; `state` must be `queued` |
| `step.updated` | nonempty `update: {rank?, intention?, issue?: {ref, outcome}, briefRef?, provisionRef?, designRef?}` |
| `step.claimed` | `claim: {leaseId, holderDid, expiresAt}`; holder DID must equal the actual signer |
| `step.started`, `step.progress`, `step.blocked`, `step.finished` | no extra block; derive `running`, `running`, `blocked`, `finished` respectively |
| `step.observed` | `observation: {conditionId, evidence}` |
| `step.attested` | `attestation: {conditionId, did, statement}`; DID must equal the actual signer |

`rank` is finite, lower first; ties use exact `stepId`. No automatic rank
normalization or 12-item truncation occurs. Text facts are nonblank and bounded
to 2000 characters. `outcome` must start with `OUTCOME`; refs are assertions,
not URLs the kernel fetches. A code declaration requires `repository` in
`owner/repo` form. Updates are sparse and cannot replace exit conditions or kind.
The earliest queued declaration by `(occurred_at, id)` wins, including on retry.
Declare before sharpening/working (timestamps determine order, not arrival).
Declarations are seeded before folding other facts so co-timestamped batches
cannot lose an update to signed-id ordering. Facts dated before their declaration
are retained in history but do not affect that step.
Unknown-step observations stay in history but cannot create an undeclared item.

Code items declare exactly one of each:

- `{id, kind: "issue_closed"}` — evidence `{kind: "issue_closed", issue}` must
  match the sharpened `issue.ref`.
- `{id, kind: "release_contains"}` — evidence
  `{kind: "release_contains", repository, issue, mergeCommit, tag}` must match
  this step's repository and issue. `mergeCommit` is a full 40-hex Git SHA.
  The signed assertion means **that commit is contained in that release tag**.
- `{id, kind: "deployed"}` — evidence
  `{kind: "deployed", repository, tag, environment: "prod"}` must match this
  step's repository and the release-containment tag. Dev/staging assertions
  cannot satisfy production exit, nor can deploying a different tag.

Human/ops items instead declare exactly
`[{id, kind: "attestation", attestorDid}]`, identifying the person who completes
the work. Only `step.attested` signed by that same DID satisfies it; an agent
or node cannot attest *as* that person through its publishing delegation.
Condition ids are distinct, nonempty, immutable, and never vacuously empty.
Unknown ids, wrong evidence kinds and mismatched targets never satisfy an exit.
The latest well-shaped assertion per declared condition supplies its evidence;
corrections are new signed observations, never edits to historical rows.

`GET /api/loops/{loopId}` and MCP `loops_get` return
`{loop, events, horizon: {steps, depth, targetDepth: 12}}`. `steps` are sorted
by rank then id. Each carries its declaration, sharpening facts, projected
`state`, derived `zone`, optional `claim`, `conditions` (each declaration,
`satisfied`, and evidence `{eventId, issuer, at, fact}`), and `openExitConditions`
(ids still unsatisfied). The flat loops list retains its existing contract;
use detail for the horizon. For explicit audit reads only, HTTP
`?includeExited=true` / MCP `include_exited: true` includes completed steps
with `state: "exited"` and `zone: "done"`, without changing non-done `depth`.
No new MCP scope or HTTP endpoint is needed.

Zones are **read projection only**, in precedence order:

1. `done` / derived state `exited`: every declared condition holds; omitted
   from `horizon.steps` and `depth`, never erased from history.
2. `past`: this item's issue is closed but at least one exit remains open.
3. `head`: a signed claim references an unexpired lease.
4. `near`: issue/OUTCOME, brief, provision and settled-design refs all exist.
5. `middle`: issue/OUTCOME exists.
6. `tail`: one-line intention only.

Input `zone`, `depth`, derived `state: "exited"` and step `output` are rejected.
Other common-envelope state labels are observational only; they cannot override
the projected lifecycle. Lease acquisition, exclusivity, renewal/release policy
and authoritative lease validation belong to **#2879**. This substrate records
the signer's claim reference, not proof that a lease service granted ownership;
readers must not use it as a dispatch lock. **#2880** owns Runs rendering.

`kernel.loop_events` already stores all necessary facts. New bus defaults await
history persistence and invoke the existing emit reactor, so no schema migration, schema ownership change
or numbered migration reservation is needed. Exact signed retries deduplicate
by a hash of the signed ingest request. History is principal scoped; replay
sorts by `(occurred_at, id)`, with no in-memory session state to lose at restart.
Every step fact retains server-assigned `publisherProof` over its exact wire
payload; credential-bearing/redaction-changing step facts are rejected instead
of storing an unverifiable substitute. The existing Record lane can read
`action=step.attested` from the emitted signed event stream, including the
completing DID, statement and publisher proof, under its existing principal /
delegated-issuer visibility rules. No `/jin` change is part of this PR.
Record emission uses the existing batched, fire-and-forget adapter; only
`loop_events` history/horizon has read-after-write durability. This feature
does not change the shared Record adapter's delivery guarantees.

The referenced workspace bridge is outside this repository and no settled
bridge field-shape ruling was attached to #2878 at dispatch. This contract is
the explicit kernel wire seam for the later plugin sync (#2881); it does not
claim to have inspected or modified an agent's local horizon files.

## Surface leases (#2405)

`POST /api/loops` also accepts signed `surface.acquired`, `surface.released`,
and `surface.conflicted` observations. They use the same common loop envelope
(`loopId`, `kind`, `principal`, `state`, `summary`, `at`, optional lineage/refs),
plus a required `surface`. Sign **the exact wire payload** inside
`canonicalize({type,payload})`; validation never adds optional defaults to a
surface payload. The same key resolution and `loops:publish` authorization
rules below apply to all three event kinds. An explicit conflict also requires
`refs.conflictingLoopId`.

Surface identities are exact, case-sensitive typed URIs, at most 2048 characters:
`repo:<org>/<repo>#branch:<branch>`, `service:<app>@env:<env>`,
`device:<id>`, or `issue:#<positive-integer>`. No gateway lookup, polling,
session lease, or harness-specific state is involved.

`kernel.surface_lease` holds one current row per surface. A live acquisition
by a different loop retains the first holder and emits a node-witness-signed
`surface.conflicted` naming the claimant in `loopId` and the holder in
`refs.conflictingLoopId`. **Both loops proceed.** This is an observation,
never a 409, fencing token, queue, or pre-dispatch check.

The lease expires fifteen minutes after acquisition/latest signed heartbeat.
`loop.progress` refreshes only a still-live, unreleased lease with the same
loop, principal, and issuer; it cannot revive an expired holding.
`surface.released` and `loop.finished` release matching holdings. Older
transitions cannot regress newer holdings, and a release/completion delivered
before its acquisition prevents that stale acquisition from becoming live.
Expiry is evaluated at read/acquire time, so no new cron or environment
configuration is required.

Acquisition evidence is retained as `issuer`, `signature`, and `signed_payload`
on the lease row. Surface observations are also in `kernel.loop_events`;
their payload retains `evidence: {publisherDid, signature, signedPayload}`.
Verify that signature against `canonicalize({type, payload: evidence.signedPayload})`,
not the augmented history payload. When #2406 redaction or
artifact spilling changes an envelope, surface history and lease rows retain
only the prepared, redacted payload; history evidence has `redacted: true`
instead of an exact `signedPayload`. As with `publisherProof`, original
credentials and overflow output must never be reintroduced through evidence.
A stored `observedConflictingLoopId` is projection metadata outside the
signed payload, retaining the original collision outcome across retries.
History deduplicates exact signed observations;
retries can re-emit the same warning but never renew an old lease.
Surface events never change `kernel.loops` lifecycle state.

`GET /api/loops/surfaces` returns `{leases, conflicts, warnOnly: true}` under
`requireAuth` and `resolveActingDid`. It returns only that effective principal's
live leases and most recent conflict observations, with ISO timestamps and
camelCase lease fields (including original signed evidence). Optional `loopId`
filters leases by holder and conflicts by either named loop; `limit` defaults
to 50, capped at 200 independently for each list. `principal`, if supplied,
must match the effective principal. Cross-principal holdings are never returned;
a collision observation exposes the conflicting loop id, not its principal or
signature. The Runs lane can consume these warnings inline (#2404); rendering
and publisher/plugin changes remain separate work.

Kernel half of the loop registry rail's signed ingest boundary
(`POST /api/loops`, `apps/kernel/src/lib/loops/`). Any publisher (Warp's
own dispatch bridge, the sprint `cycle` loopKind, the OpenClaw plugin
translating gateway-side lifecycle hooks, a review sub-agent) submits a
`loop.started|progress|blocked|finished` envelope naming a `principal` —
the DID this history is attributed to — signed with the publisher's own
DID key. This document is the contract for **who may publish loop history
for whom**, split into the two independent checks ingest runs, in order,
before anything is written or published onto the bus.

## 1. Signature verification (#2295, #2338)

`verifyLoopPublisherSignature` (`src/lib/loops/verify-publisher-signature.ts`)
proves `publisherDid` controls the private key it claims: it resolves
`publisherDid` to its currently registered public key (the kernel node's
own signing DID resolves in-process, `getNodeSigningIdentity()`, per
#2338 — every other DID resolves via the identity registry) and verifies
the Ed25519 signature over `canonicalize({ type, payload })`. An unknown,
mismatched, or revoked key — or an invalid signature — is rejected with
400 before anything downstream runs.

This step answers **"does this publisher control this DID?"** — nothing
more. It does **not** answer whether that DID has any standing to write
history for `payload.principal`.

## 2. Publisher authorization (#2358)

`authorizeLoopPublisher` (`src/lib/loops/authorize-publisher.ts`) answers
that second question, once signature verification has already succeeded.
`publisherDid` may write `loop.*` history naming `principal` when, and
only when, one of the following holds:

1. **Self-attestation**: `publisherDid === principal`. A DID always may
   publish its own loop history.
2. **The kernel node's own signing-DID path (#2338)**: `getNodeSigningIdentity()`
   witnesses every `warp.run.*` (`src/lib/warp/loop-emit.ts`) and `cycle`
   (`src/lib/loops/cycle.ts`) transition on behalf of whichever human
   dispatched or triggered it — `principal` is that dispatching DID,
   never the node's own DID. The node's signing DID is deliberately never
   registered in the identity registry (#2338: a registry write the
   node's own verification "shouldn't depend on... succeeding"), so
   neither self-attestation nor a realistic per-principal delegation
   grant could ever cover it. The node is not an external actor crossing
   this ingest boundary — it is the same trusted process enforcing the
   boundary — so its own witnessed events are exempt from the
   delegation-grant check the same way they are already exempt from
   registry-based key resolution.
3. **An active `loops:publish` delegation grant (#1882)**: a
   `delegationGrants` row where `agentDid = publisherDid`,
   `delegatorDid = principal`, status `active`, not expired, holding the
   `loops:publish` capability (`packages/auth/src/grant-scopes.ts`).
   Checked via `introspectGrant` — the same fail-closed,
   re-read-on-every-call primitive every other cross-DID capability in
   this codebase uses (`agent:reach`, `usage:read`) — so a revoked or
   expired grant denies on the very next call, with nothing cached to go
   stale.

Anything else — an unrelated publisher with no self-match, no
node-witness match, and no matching grant — is rejected with **403** and
a typed error code (`loop_publisher_unauthorized`) before publishing.
The rejected `(publisherDid, principal)` pair is logged; the envelope
payload (summary, refs, etc.) is never logged on this path.

## Granting `loops:publish`

Issue a grant the same way every other #1882 delegation grant is issued
(`POST /auth/api/grants`, `issueGrant` in `apps/kernel/src/lib/auth/grants.ts`):
the principal (`delegatorDid`) authorizes a specific external agent DID
(`agentDid`) to hold the `loops:publish` capability, scoped by `audience`
and a bounded TTL. Revoking the grant (or letting it expire) makes the
very next `POST /api/loops` call from that publisher fail with 403.


## Registry refs and spend (#2290)

`refs` are signed publisher data: `runId`, `sessionKey`, `issue`, `pr`.
`GET /api/loops` and MCP `loops_list` accept exact-match filters with those
names, including on ancestor reads. GitHub subject refs should be canonical
`https://github.com/owner/repo/issues/N` / `/pull/N` URLs or `owner/repo#N`;
unknown strings remain visible as refs but are never guessed into an issue.

`GET /api/loops/spend?window=YYYY-MM` (or the usage API's inclusive date-range
syntax) returns `{currency, windowFrom, windowTo, runs, issues, prs}` for the
authenticated effective principal only. Each run includes signed refs, loop
identity/state, and `metered: {usd, turns} | null`. Issue and PR totals include
their explicit ref and distinct run count. Both sides of the join are principal
scoped. USD is summed from non-error `usage.incurred` rows in the half-open
window: exact `session_id = runId` wins, otherwise an unambiguous
`session_id = sessionKey` joins. Duplicate loops cannot multiply a usage row;
shared session aliases stay unattributed. Null cost is unknown, not zero.
Old loops with usage in the window are included. Session-only loops use their
stable loopId as the correlation identity, not an invented Warp run id. A run
with any unpriced usage and a subject with any unknown run cost remain unknown,
never a misleading partial total.

`/jin/api/spend/runs` uses this registry first. Only Warp runs with no loop
record (checked independently of pagination/time window) use the old branch
derivation. Registry-owned sessions are excluded from fallback metering.
Registry failure fails closed, never silently switches the whole lane back
to heuristics. Warp failure does not erase registry costs. The legacy
`interim` response property is retained for panel compatibility; the label
identifies the actual source and any legacy fallback. GitHub closure state
still uses the existing principal-authorized connector; unavailable is unknown.

`/jin` Runs uses the same projection through direct-human operator-gated
adapters, not the Warp or gateway API. Nonoperators see no Runs lane.
## Native lifecycle observations (#2290)

- Warp publishes authoritative run/session ids, exact GitHub trigger refs and
  unambiguous typed PR artifact refs; it never infers subjects from prompts or
  branches. Sparse transitions preserve existing refs.
- A `bus.chain` is one actual `publish()` invocation, with its own UUID.
  Completion waits for awaited and fire-and-forget reactors to settle.
  Correlation ids remain trace metadata, not invented parent loops. The kernel
  injects the signed observer; the bus never imports kernel code and never
  observes `loop.*` recursively.
- `review` follows the cycle's real review-phase transitions. `pr` first
  appears from a confirmed typed PR artifact, parented to its run. That initial
  observation cannot overwrite an existing PR projection. Existing authenticated
  `getPullRequest` observations update open/draft/closed/merged state without
  any new API call, poller or gateway dependency.
- Unchanged inline history rows retain server-assigned `publisherProof` containing
  the exact original signed payload/type, publisher DID and signature for audit.
  Proofs are omitted when redaction or output spilling changes the envelope:
  the raw signed payload must not reintroduce credentials or unbounded output.
  Caller-supplied proof metadata is never trusted. Older history is not
  backfilled with fabricated proofs. Projection ownership cannot
  move between principals, and history reads are also principal scoped.

## Summary table

| Publisher | Principal | Path | Result |
|---|---|---|---|
| `did:imajin:ryan` | `did:imajin:ryan` | self-attestation | 201 |
| kernel node's signing DID | any dispatching DID | node-witness (#2338) | 201 |
| `did:imajin:agent` | `did:imajin:ryan` | active `loops:publish` grant from ryan | 201 |
| `did:imajin:agent` | `did:imajin:ryan` | grant revoked or expired | 403 |
| `did:imajin:stranger` | `did:imajin:ryan` | no grant at all | 403 |
