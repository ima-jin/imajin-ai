# Loop registry rail — publisher-authorization contract (#2358, epic #2288/#2290, #2295, #2296, #2338)

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
Old loops with usage in the window are included.

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

## Summary table

| Publisher | Principal | Path | Result |
|---|---|---|---|
| `did:imajin:ryan` | `did:imajin:ryan` | self-attestation | 201 |
| kernel node's signing DID | any dispatching DID | node-witness (#2338) | 201 |
| `did:imajin:agent` | `did:imajin:ryan` | active `loops:publish` grant from ryan | 201 |
| `did:imajin:agent` | `did:imajin:ryan` | grant revoked or expired | 403 |
| `did:imajin:stranger` | `did:imajin:ryan` | no grant at all | 403 |
