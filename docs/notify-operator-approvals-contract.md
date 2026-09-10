# Operator approvals — notification contract (#2059, open source/kind vocabulary #2152)

Kernel half of "operator approvals appear as a signed confirm on /jin —
approve from anywhere". #2059 shipped a single hard-coded vocabulary (the
OpenClaw system-agent: `kind: restart | config-mutation | other`). #2152
generalizes it so **any source** can raise a proposal — first new consumer:
OpenClaw Skill Workshop proposals. This is the contract source adapters
implement against, primarily the OpenClaw plugin's generic
gateway-approvals bridge (`ima-jin/openclaw-imajin-plugin#33`, superseding
`#24`). The plugin repo is never imported from here and this repo never
imports it — the two sides only ever talk over the kernel's existing HTTP
and WebSocket surfaces described below.

**Backward compatibility**: a source may still publish the original bare
`kind` (no `source` field, no `detail`, no `contentHash`) and it ingests
and renders exactly as before, normalized onto `system-agent:*` — sources
don't have to be lock-stepped with this contract's generalization.

## Overview

```
A source (e.g. OpenClaw       The source's adapter            Kernel (/jin)
system-agent, Skill Workshop)   (e.g. the OpenClaw plugin's
  stages a proposal   ──────►  bridge)                 ──────►  operator.approval.requested
                                POST /notify/api/send            notification, renders as a
                                scope: operator.approval.        confirm card via the
                                requested                        source's own renderer

                                subscribes over its existing
                                authenticated WS  ◄────────────  operator.approval.decided
                                                                  bus event, published once
  applies/discards via          POST .../applied  ──────────►    the operator taps Approve /
  the source's own                                               Reject / Withdraw on /jin
  apply mechanism
```

A source's adapter never bypasses its own underlying approval store — it
only relays the operator's decision to it, mapping the generic
`approve`/`reject` onto whatever vocabulary that store expects (e.g.
system-agent: approve → `allow-once`, reject → `deny`).

## 1. `operator.approval.requested`

Published by the source's adapter via the existing notify ingestion
endpoint:

```
POST /notify/api/send
x-webhook-secret: <NOTIFY_WEBHOOK_SECRET>
Content-Type: application/json

{
  "to": "<operator DID>",
  "scope": "operator.approval.requested",
  "data": {
    "proposalId": "string",
    "source": "system-agent" | "skill-workshop" | "<any lowercase-hyphenated id>",
    "kind": "<source>:<subkind>",   // e.g. "system-agent:restart", "skill-workshop:update"
    "summary": "string — human-readable, what will happen",
    "keysTouched": ["string", "..."],
    "detail": { "...": "optional, bounded (\u226416KB) per-source structured payload" },
    "contentHash": "sha256 hex digest — see Content hash below"
  }
}
```

- `to` **must** be the node's configured operator DID
  (`relay.relay_config.node_operator_did` — see `getOperatorDid()` in
  `apps/kernel/src/lib/notify/operator-approvals.ts`). Any other recipient is
  rejected with 400: this notification kind has exactly one legitimate
  addressee.
- **Legacy shape** (no `source` field): `kind` must be one of the original
  three bare values (`restart` | `config-mutation` | `other`); the kernel
  normalizes it onto `source: "system-agent"`, `kind: "system-agent:<kind>"`.
  `detail` and `contentHash` are not required on this path.
- **Open-vocabulary shape** (`source` present): `source` must be a
  lowercase, hyphenated identifier; `kind` must be namespaced
  `"<source>:<subkind>"` with the same lowercase-hyphenated rule for
  `<subkind>`. `contentHash` is **required** on this path (see below).
- `summary` is free text but is validated at the boundary — see
  **Secret redaction** below.
- `keysTouched` is an array of **key paths only** — e.g. `"gateway.plugins.
  foo.token"` — **never** resolved secret values, never a `SecretRef`
  object, never a raw credential. A payload that fails this check is
  rejected with 400, not silently redacted, so the source's own config
  diffing is the one place secret values are ever supposed to be resolved.
- `detail` is optional, per-source structured JSON, bounded to 16KB — e.g.
  Skill Workshop's `{ skillName, kind: 'create'|'update', scan, description,
  diffSummary }`. Rendered by the /jin panel's per-source renderer registry
  (`apps/kernel/app/jin/operator-approvals-panel.tsx`); an unregistered
  source falls back to the default summary/keys-touched card.
- The two implicit actions on the resulting card are `approve` and
  `reject` — labeled per source via `decisionLabels` in the panel's
  renderer registry (default: Approve/Deny; Skill Workshop: Apply/Reject).

### Content hash (#2152)

`contentHash` is a sha256 hex digest (optionally `sha256:`-prefixed) over
the canonical JSON of `{proposalId, source, kind, summary, keysTouched,
detail}` (see `computeApprovalContentHash` in `apps/kernel/src/lib/
notify/operator-approvals.ts`). The kernel **independently recomputes**
this and rejects the request with 400 on any mismatch — the invariant is
"what the operator saw is what gets applied": `detail` cannot be silently
swapped between the moment the card renders and the moment a source
applies the reviewed decision. Required whenever `source` and/or `detail`
is present; not required (but still verified if supplied) for the legacy
bare-kind shape.

### Secret redaction

There is no shared `SecretRef` type across repos, so the kernel validates
the *shape* of what it's given (`validateApprovalRequestedPayload` in
`apps/kernel/src/lib/notify/operator-approvals.ts`):

- Every `keysTouched` entry must look like a short, plain key path
  (letters/digits/`_.-/`, ≤200 chars) — not a value.
- Both `summary` and every `keysTouched` entry are rejected if they match
  common secret shapes: PEM private-key blocks, vendor token prefixes
  (`sk-`, `ghp_`, `xoxb-`, …), long hex/base64 blobs, or a `Bearer <token>`
  string.

This is defense-in-depth at the kernel boundary. The plugin is still
responsible for never resolving a `SecretRef` before building `summary` /
`keysTouched` in the first place.

## 2. `operator.approval.decided`

Published by the kernel via `bus.publish('operator.approval.decided', …)`
once the operator taps Approve, Reject, or Withdraw on `/jin`
(`decideOperatorApproval` in
`apps/kernel/src/lib/notify/operator-approvals-service.ts`):

```ts
{
  proposalId: string;
  source: string;       // carried through unchanged from the request (#2152)
  kind: string;          // carried through unchanged from the request (#2152)
  decision: 'approve' | 'reject' | 'withdrawn';
  mode?: string;         // opaque, source-adapter-chosen (e.g. 'allow-once') — kernel never interprets it (#2152)
  decidedBy: string;    // the operator DID — always the human, never an agent
  decidedAt: string;    // ISO 8601
  reason?: string;
}
```

The kernel signs this attestation with its own node signing identity
(the same `getNodeSigningIdentity()` pattern the GitHub confirm route and
the generic consent-request primitive use) — `decidedBy` is guaranteed to
be the operator because the decide route requires `requireAuth` to resolve
that *exact* DID directly, never a delegated (`X-Acting-For`/`onBehalfOf`)
identity. See **Auth invariant** below. The kernel never interprets
`decision` or `mode` — it only witnesses and republishes them; a source's
adapter is responsible for mapping `approve`/`reject` (+ optional `mode`)
onto whatever vocabulary its own underlying store expects.

### Delivery

Each source's adapter routes this event back to its own owning source by
the `source` field. It's received live over the adapter's **existing**
authenticated WebSocket (the same challenge-response session every
kernel-connected agent already holds) via the kernel's grant-bound
event-subscription fan-out (#1884, `packages/bus/src/subscriptions.ts`):
any agent DID holding an active delegation grant for the
`operator:approvals` capability (`packages/auth/src/grant-scopes.ts`) is
pushed a `bus_event` frame whenever `operator.approval.decided` is
published. If the adapter's agent DID has no live socket at the moment of
publish, the event is still durable in `kernel.event_subscription_log` for
catch-up via `GET /auth/api/events/subscriptions/catchup`.

No new WS protocol, no new subscription mechanism — every source shares
the exact same primitive any other delegated agent uses to observe kernel
events, scoped to a capability the operator (or an admin acting for them)
grants it.

### Idempotency / no-op

Per the OpenClaw bridge (#24, generalized #33): a `decision` for an
already-applied or expired proposal is expected to be a no-op on the
adapter's side, logged and not retried against the underlying store.

## 3. Withdrawal

`decision: 'withdrawn'` is only ever published as a **follow-up** to a
prior `approve`, and only while the proposal is still "pending-apply" (kernel
status `approved`, i.e. the source has not yet confirmed it applied). Once
the source confirms apply (see below), withdrawal is no longer possible —
the kernel rejects it with 409.

## 4. Apply confirmation (return path)

Once a source's own apply against its underlying approval mechanism
succeeds, it reports that back so `/jin` can show `applied` instead of
`approved`:

```
POST /notify/api/internal/operator-approvals/applied
x-webhook-secret: <NOTIFY_WEBHOOK_SECRET>
Content-Type: application/json

{ "proposalId": "string" }
```

Idempotent: calling this again for an already-`applied` proposal succeeds
as a no-op; calling it for a proposal that isn't currently `approved`
(unknown, denied, or already withdrawn) is a safe no-op too.

## Auth invariant

The decide route (`POST /jin/api/operator-approvals/:proposalId/decision`)
requires the caller's authenticated identity to be the operator DID
**directly** — `identity.id === operatorDid && !identity.actingFor`
(`isOperatorIdentity` in `apps/kernel/src/lib/notify/operator-
approvals.ts`). An agent (e.g. `@jin`) authenticated with its own DID and
`X-Acting-For: <operatorDid>` has `identity.id !== operatorDid`, so this is
always false for it, regardless of what it claims to act for — `@jin`
proposing and `@jin` approving is structurally impossible, not just
discouraged. A different human identity gets 403 without ever learning
whether a given `proposalId` exists.

## Redelivery

`operator.approval.requested` is an ordinary `notify.notifications` row, so
it gets the same backlog-on-reconnect redelivery every other notification
does (#2044/#2050, `apps/kernel/src/lib/notify/backlog.ts`) — a pending
approval survives the operator's client reconnecting with no
proposal-specific redelivery code required.
