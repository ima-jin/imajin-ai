# Operator approvals — notification contract (#2059)

Kernel half of "operator approvals (gateway restart / config proposals)
appear as a signed confirm on /jin — approve from anywhere". This is the
contract the plugin half (`ima-jin/openclaw-imajin-plugin#24`) implements
against. The plugin repo is never imported from here and this repo never
imports it — the two sides only ever talk over the kernel's existing HTTP
and WebSocket surfaces described below.

## Overview

```
OpenClaw system-agent          OpenClaw plugin                 Kernel (/jin)
  stages a proposal   ──────►  POST /notify/api/send   ──────►  operator.approval.requested
  (restart / config             scope: operator.approval.        notification, renders as a
   mutation)                    requested                        confirm card

                                subscribes over its existing
                                authenticated WS  ◄────────────  operator.approval.decided
                                                                  bus event, published once
  applies/discards via          POST .../applied  ──────────►    the operator taps Approve /
  the Gateway's own                                              Deny / Withdraw on /jin
  approval API
```

The plugin never bypasses the OpenClaw/Gateway approval store — it only
relays the operator's decision to it.

## 1. `operator.approval.requested`

Published by the plugin via the existing notify ingestion endpoint:

```
POST /notify/api/send
x-webhook-secret: <NOTIFY_WEBHOOK_SECRET>
Content-Type: application/json

{
  "to": "<operator DID>",
  "scope": "operator.approval.requested",
  "data": {
    "proposalId": "string",
    "kind": "restart" | "config-mutation" | "other",
    "summary": "string — human-readable, what will happen",
    "keysTouched": ["string", "..."]
  }
}
```

- `to` **must** be the node's configured operator DID
  (`relay.relay_config.node_operator_did` — see `getOperatorDid()` in
  `apps/kernel/src/lib/notify/operator-approvals.ts`). Any other recipient is
  rejected with 400: this notification kind has exactly one legitimate
  addressee.
- `kind` must be one of the three listed values.
- `summary` is free text but is validated at the boundary — see
  **Secret redaction** below.
- `keysTouched` is an array of **key paths only** — e.g. `"gateway.plugins.
  foo.token"` — **never** resolved secret values, never a `SecretRef`
  object, never a raw credential. A payload that fails this check is
  rejected with 400, not silently redacted, so the plugin's own config
  diffing is the one place secret values are ever supposed to be resolved.
- The two implicit actions on the resulting card are `approve` and `deny`.

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
once the operator taps Approve, Deny, or Withdraw on `/jin`
(`decideOperatorApproval` in
`apps/kernel/src/lib/notify/operator-approvals-service.ts`):

```ts
{
  proposalId: string;
  decision: 'approve' | 'deny' | 'withdrawn';
  decidedBy: string;   // the operator DID — always the human, never an agent
  decidedAt: string;   // ISO 8601
  reason?: string;
}
```

The kernel signs this attestation with its own node signing identity
(the same `getNodeSigningIdentity()` pattern the GitHub confirm route and
the generic consent-request primitive use) — `decidedBy` is guaranteed to
be the operator because the decide route requires `requireAuth` to resolve
that *exact* DID directly, never a delegated (`X-Acting-For`/`onBehalfOf`)
identity. See **Auth invariant** below.

### Delivery

The plugin receives this live over its **existing** authenticated
WebSocket (the same challenge-response session every kernel-connected agent
already holds) via the kernel's grant-bound event-subscription fan-out
(#1884, `packages/bus/src/subscriptions.ts`): any agent DID holding an
active delegation grant for the `operator:approvals` capability
(`packages/auth/src/grant-scopes.ts`) is pushed a `bus_event` frame
whenever `operator.approval.decided` is published. If the plugin's agent
DID has no live socket at the moment of publish, the event is still durable
in `kernel.event_subscription_log` for catch-up via
`GET /auth/api/events/subscriptions/catchup`.

No new WS protocol, no new subscription mechanism — the plugin uses the
exact same primitive any other delegated agent uses to observe kernel
events, scoped to a capability the operator (or an admin acting for them)
grants it.

### Idempotency / no-op

Per #24: a `decision` for an already-applied or expired proposal is
expected to be a no-op on the plugin's side, logged and not retried against
the Gateway.

## 3. Withdrawal

`decision: 'withdrawn'` is only ever published as a **follow-up** to a
prior `approve`, and only while the proposal is still "pending-apply" (kernel
status `approved`, i.e. the plugin has not yet confirmed it applied). Once
the plugin confirms apply (see below), withdrawal is no longer possible —
the kernel rejects it with 409.

## 4. Apply confirmation (return path)

Once the plugin's own apply against the Gateway's approval API succeeds,
it reports that back so `/jin` can show `applied` instead of `approved`:

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
