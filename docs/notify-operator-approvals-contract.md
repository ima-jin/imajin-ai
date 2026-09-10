# Operator approvals — notification contract (#2059, open source/kind vocabulary #2152, operator countersignature #2082)

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
  operatorSignature?: {  // the operator's OWN countersignature (#2082) — see below
    keyId: string;        // hex-encoded Ed25519 public key that produced `sig`
    alg: 'ed25519';
    sig: string;           // hex-encoded Ed25519 signature
  };
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

### Operator countersignature (#2082)

The kernel's node signature above is a **witness record** of an
authenticated operator decision — it is signed by the *kernel's* key, so a
kernel compromise could forge one. `operatorSignature` is a second,
independent signature by the **operator's own key**, produced client-side
on `/jin` (`apps/kernel/app/jin/operator-approvals-panel.tsx`) using the
same Ed25519 keypair already held in the operator's browser
(`localStorage.imajin_keypair`, the same key used for login/registration).
It covers exactly:

```ts
canonicalize({ contentHash, decision, decidedAt })
```

where `contentHash` is the effective content hash of the *request* this
decision answers (see `effectiveContentHash` in `apps/kernel/src/lib/
notify/operator-approvals.ts` — always present on the `GET /jin/api/
operator-approvals` card, recomputed on the fly for a legacy row that
never stored one), and `decidedAt` is the same ISO-8601 timestamp on the
payload above (client-chosen, not kernel-assigned, since it's exactly what
the operator signed over).

**Verification** (`verifyOperatorCountersignature` in `apps/kernel/src/
lib/notify/operator-countersign.ts`), run on every decide request that
supplies `operatorSignature`, regardless of the feature flag below:
1. `decidedAt` must parse and be within the same clock-skew window
   `@imajin/auth`'s message verification already uses (`SIGNED_MESSAGE_MAX_AGE`
   = 5 minutes back, `FUTURE_TOLERANCE` = 30 seconds forward).
2. `operatorSignature.keyId` must equal the operator DID's **current**
   registered `identities.publicKey` exactly (resolved the same way the
   existing `attestations/countersign` route resolves a witness key) —
   this single check rejects an unknown key, a mismatched key, AND a
   revoked/rotated key uniformly, since a rotated-away key is no longer
   "current" either.
3. `crypto.verifySync(sig, canonicalize({contentHash, decision, decidedAt}), keyId)`
   must pass.
Any failure returns 400 **before** the decision is persisted or the
kernel's own witness signature is produced.

### Feature flag: `OPERATOR_COUNTERSIGN_REQUIRED`

Per-node environment variable, default unset (**off**). While off, a
decision with no `operatorSignature` is still accepted (today's v1
behavior) — but any `operatorSignature` that IS supplied is still fully
verified per the rules above, so the plugin side
(`ima-jin/openclaw-imajin-plugin#24`) can be built and tested against real
verification before the flag ever flips. Once `OPERATOR_COUNTERSIGN_REQUIRED=true`
on a node, `decideOperatorApproval` rejects (400, before any state
mutation) any decision — including a withdrawal — that doesn't carry a
valid `operatorSignature`. This is what closes the "kernel-forged
decision" gap: a compromised kernel alone can no longer produce an
accepted decision.

**Rollout order**: (1) this kernel PR ships with the flag off — nothing
changes for an unmigrated plugin. (2) `openclaw-imajin-plugin#24`
implements plugin-side verification of `operatorSignature` against the
operator DID's public key (not the kernel's witness signature) and the
`/jin` client already starts sending `operatorSignature` on every decision
(this PR ships that too). (3) once #24 is confirmed live and verifying
correctly, an operator flips `OPERATOR_COUNTERSIGN_REQUIRED=true` on their
node to require it going forward.

### Wire-contract table

| Field | Who signs it | Who verifies it | Covered by which hash/signature |
|---|---|---|---|
| `contentHash` (on the request) | n/a — computed by the source's adapter | Kernel, at ingest (`validateApprovalRequestedPayload`) | sha256 over `{proposalId, source, kind, summary, keysTouched, detail}` |
| Kernel witness `signature` (on the decision row) | Kernel's own node key (`getNodeSigningIdentity`) | Anyone holding the node's public key (legacy v1 trust anchor) | Ed25519 over `canonicalize(payload)` (the whole decided-event payload) |
| `operatorSignature.sig` | The operator's own key (client-side on `/jin`) | Kernel, at decide time (`verifyOperatorCountersignature`); the plugin, per `#24`, against the operator DID's public key directly | Ed25519 over `canonicalize({contentHash, decision, decidedAt})` |
| `operatorSignature.keyId` | — (identifies the signer) | Kernel: must equal the operator DID's current `identities.publicKey` | n/a |

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
