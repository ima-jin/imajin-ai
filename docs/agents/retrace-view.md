# Retrace view — design and route contract

Refs [#1962](https://github.com/ima-jin/imajin-ai/issues/1962) (sub-issue of
[#1758](https://github.com/ima-jin/imajin-ai/issues/1758), RFC-31 v2). Lives on
the Agent View pane (`/auth/agents`) that landed in
[#1933](https://github.com/ima-jin/imajin-ai/issues/1933) — see
[`envelope-provisioner.md`](./envelope-provisioner.md) for that surface.

## 1. What this is

The signed record already *is* a causal chain: a wish (signed intent) leads to
an inference event, composed primitives, and each agent action carrying
`onBehalfOf` plus the grant it acted under. Retrace is that record read
backwards — a read-only walk from any terminal artifact back to the
originating signed intent (or the first point the record stops linking
further). It is not a general graph explorer: one path, one direction, no
replay or undo.

## 2. Route

`GET /auth/api/retrace?artifact=<id>&kind=<attestation|agent_provision|bus_event>`
(`apps/kernel/app/auth/api/retrace/route.ts`).

- **Auth**: `requireAuth` via the same `resolveCallerIdentity` preamble the
  provisioner routes use (#1933) — 401 if unauthenticated. The caller's
  effective DID (`actingAs ?? id`) is the viewer identity checked against
  every hop.
- **`artifact`** (required): the id of the artifact to start from.
- **`kind`** (optional): overrides the inferred kind. When omitted, the kind
  is inferred from the id's prefix (`identifyArtifactKind` in
  `apps/kernel/src/lib/retrace/repository.ts`): `att_*` → `attestation`,
  `prov_*` → `agent_provision`, anything else → `bus_event` (opaque
  `randomUUID()` ids from `kernel.audit_log`).
- **404**: the starting artifact doesn't exist.
- **403**: the caller isn't authorized to read the starting artifact at all —
  retrace refuses to reveal even that it exists. This is the one hop that
  never becomes a tombstone (see §4).
- **200** body:

```jsonc
{
  "hops": [
    {
      "kind": "attestation",             // "attestation" | "agent_provision" | "bus_event" | "tombstone"
      "actorDid": "did:imajin:agent",
      "onBehalfOf": "did:imajin:owner",  // or null
      "grant": { "grantId": "grant_1", "capability": "messages:write" }, // or null
      "input": "att_parent",             // id of the artifact this hop consumed, or null (originating hop)
      "output": "att_child",             // id of this artifact
      "route": "attestation.created",    // the bus event / reactor chain this hop's creation fired
      "timestamp": "2026-01-01T00:00:00.000Z",
      "signature": "verified"            // "verified" | "invalid" | "unsigned"
    }
    // ... newest hop first, oldest last
  ],
  "terminal": {
    "reached": true,
    "ref": { "kind": "attestation", "id": "att_root" }, // null if not reached
    "reason": "No prev_event_ref, session predecessor, or context event — originating signed intent."
  },
  "truncated": false // true if the ~200-hop depth cap or a cycle was hit
}
```

## 3. Supported artifact kinds and the parent-link resolution rule

Retrace only walks parent links that already exist in the record — this is a
read-only feature with **no schema migration** (issue #1962's explicit
constraint). Where an artifact kind's existing columns aren't enough to
resolve a parent, it terminates there rather than growing new columns.

Implemented in `apps/kernel/src/lib/retrace/repository.ts`, one resolver
function per kind:

### `attestation` (`auth.attestations`, id prefix `att_`)

Priority order:
1. `prev_event_ref` — the explicit funnel/causal predecessor (#1885).
2. For `agent.turn.usage` rows only: the nearest earlier attestation with the
   same `type`, same `subject_did`, and the same `payload.session`, ordered
   by `issued_at` — the same "previous turn" the turn-usage rollup route
   (`GET /auth/api/attestations/usage`, #1863) computes `tokenDelta` against.
   This is the *branching* rule: a session can have many earlier turns, and
   the nearest one (not the oldest) is the parent.
3. `context_type === 'event'` — the `context_id` bus event this
   attestation's own creation was a reaction to.
4. None of the above → **terminal**: the originating signed intent.

Signature status is computed by re-deriving the same canonical payload
`POST /auth/api/attestations` signed at issuance
(`canonicalize({ subject_did, type, context_id, context_type, payload,
issued_at })`) and verifying it against the issuer's current public key —
`unsigned` if the row has no `signature`, `invalid` if the issuer identity or
the signature can't be verified, `verified` otherwise. `grant` is populated
from `delegation_grant_id` plus the capability
`capabilityForDelegatedAttestationType(type)` implies, when present.

### `agent_provision` (`auth.agent_provisions`, id prefix `prov_`)

Always **terminal** — a provisioning request (#1933) is session-authenticated
at request time, not itself a chained signed artifact, so it has no parent
link to walk further. `signature` is always `unsigned` for the same reason.
`actorDid` is the provision's `serving_did`; `grant` is the single grant the
provision issued (`grant_id`), if any.

### `bus_event` (`kernel.audit_log`, opaque ids)

`kernel.audit_log` (migration `0077_audit_log.sql`) is the durable projection
the generic `audit-log` bus reactor (`packages/bus/src/reactors/audit-log.ts`)
writes on any bus event matching a `bus_chain_configs` row that lists it.
`apps/kernel/src/db/schemas/bus.ts` adds a read-only Drizzle mapping onto
that existing table — no migration.

Priority order:
1. `payload.attestationId` — the attestation whose creation published this
   event (e.g. `attestation.created`).
2. `payload.provisionId` — the provision whose creation published this event
   (e.g. `agent.provisioned`).
3. The nearest earlier `audit_log` row sharing this row's `correlation_id`
   (by `created_at`) — the *branching* rule for events: a correlation id can
   have many earlier events, and the nearest one is the parent.
4. None of the above → **terminal**: the earliest known event in this chain.

`route` is the event's own `event_type`. `signature` is always `unsigned` —
`audit_log` rows are internal projections of published events, not
themselves signed artifacts.

### Not yet walkable

Per issue #1962's read-only constraint, these are explicitly out of scope
rather than backed by a new column:
- **Chat turns** beyond the `agent.turn.usage` attestation stream — the chat
  message tables (`chat`/`chat-v2` schemas) carry no signed-intent or
  chain-config linkage today.
- **Settlements / usage.incurred rows** (`usage` schema, #1956–#1958) — no
  parent-link column exists yet; `usage.incurred.session_id`/`turn_id` are
  present on the table but unpopulated by the current `harness:nanoclaw`
  mapper (see PR #1963's investigation).
- **`bus_chain_configs`** rows themselves are read as metadata (a hop's
  `route`), never walked as their own node — they're static routing
  configuration, not per-event artifacts.

## 4. Authorization and the tombstone contract

`apps/kernel/src/lib/retrace/authorize.ts`'s `canReadHop` decides, per hop,
whether the caller may see it — composed entirely from existing checks:
- the caller is the hop's `subjectDid`, `actorDid`, or `delegatorDid`
  (`isPartyToAttestation`, #1885);
- the caller holds an active `identity_members` row on the hop's subject or
  actor org (`isActiveGroupMember`, #1851);
- otherwise, the hop's `disclosure_scope` (attestations only —
  `resolveDisclosureAccess`, #1885) against the caller's trust-graph radius-1
  neighborhood, resolved once per walk.

A hop the caller can't read is **never dropped from the chain** — it's
replaced with an opaque tombstone:

```jsonc
{ "kind": "tombstone", "timestamp": "2026-01-01T00:00:00.000Z", "hash": "…sha256…" }
```

`hash` is `sha256(kind:id)` of the underlying artifact — stable and
non-reversible, so a caller can recognize the *same* hidden hop across two
retrace calls without learning what it is. This is what keeps a cross-org
chain walkable to the organizational boundary without leaking past it: the
walk keeps following the real (internally resolved) parent link behind a
tombstone, it just never renders that link's target to an unauthorized
caller.

The one exception is the **starting artifact**: if the caller can't read it,
the route returns 403 rather than a chain that opens with a tombstone —
learning *that something exists* at an id you queried directly is still a
disclosure the walk's own boundary case (mid-chain tombstones) is designed to
avoid granting for free.

## 5. Cycle and depth guard

`walkRetrace` (`apps/kernel/src/lib/retrace/walk.ts`) keeps a visited-set
keyed by `kind:id` and stops (`truncated: true`) the moment a ref repeats,
and separately caps the walk at `RETRACE_MAX_DEPTH` (200) hops regardless.
Both conditions are reported via the same `truncated` flag; `terminal.reached`
stays `false` when a cycle or the depth cap ends the walk before a true
origin (or dead parent link) is found.

## 6. UI

The "Retrace" pane on `/auth/agents`
(`apps/kernel/app/auth/agents/retrace-panel.tsx`): paste or select an
artifact id, submit, and the chain renders newest-to-oldest. Each hop is an
expandable row showing its linked `input`/`output` ids, `route`, and
signature status; a tombstone renders as a locked row showing only its hash
and timestamp. Every `ProvisionPanel` row (the existing #1933 Agent View
provision cards) offers a "Retrace" action that opens the pane pre-filled
with that provision's id and runs the walk immediately.
