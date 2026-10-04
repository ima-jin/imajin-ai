# `agent.turn.evidence` — tool I/O as the committed boundary of a turn

Issue #1978 · epic #1758 (RFC-31 v2, Agent Runtime) · sister to #1970 (mention ledger).

#1970 commits **what the agent said** (a signed per-turn event with `inputHash`/`outputHash`). This commits
**what the agent observed before saying it**: every tool call in the turn becomes a signed
`agent.turn.evidence` attestation (input hash, output hash, tool name, timestamp). A claim like "Jin verified
this contract is live on Sepolia" then resolves to a signed record over an actual `eth_getCode` call — and
anyone outside the room can check it without an account.

The kernel never reaches into a harness. The agent side publishes signed evidence; the kernel stores and
verifies it. No session keys are kernel concepts and no transcripts are scraped.

## Shape

One attestation per tool call (retrace granularity), stored in `auth.attestations` (type `agent.turn.evidence`,
no new table). The signed payload is a **closed vocabulary** — see `packages/auth/src/turn-evidence.ts`:

```json
{
  "type": "agent.turn.evidence",
  "turnEventId": "<#1970 turn event id>",
  "turnOutputHash": "sha256:<the turn's claim hash>",
  "agentDid": "did:imajin:...",
  "principalDid": "did:imajin:...",
  "tool": { "name": "web_fetch", "provider": "openclaw" },
  "inputHash": "sha256:...",
  "outputHash": "sha256:...",
  "outputRef": "<optional media asset id>",
  "usageRef": "<optional agent.turn.usage attestation id>",
  "observedAt": "2026-09-04T03:54:12Z",
  "seq": 3
}
```

Row mapping: `issuer = subject = agentDid`, `context_id = turnEventId`, `context_type = 'agent.turn'`,
`delegator_did = principalDid` (when different), `delegation_grant_id` = the grant that authorized it.
Subject is the agent so the existing usage authorization (subject or active `identity_members` member)
covers the evidence count shown next to the same turn's usage row.

### Redaction safety

Payloads carry hashes and references, **never raw secrets or content**. There is no field for tool arguments,
tool output, URLs or headers; `parseTurnEvidencePayload` rejects any key outside the list above (naming the
key, never echoing its value), hashes must be `sha256:` + 64 lowercase hex, and `tool.name`/`provider` are
charset-restricted identifiers. The public verify endpoint additionally omits `principalDid`, `outputRef` and
`usageRef`.

### Hashing

`hashToolIo(value)` (`@imajin/auth`): string → SHA-256 of its UTF-8 bytes; `Uint8Array` → SHA-256 of the bytes;
anything else → SHA-256 of canonical JSON (sorted keys), so property order never changes the hash. To retain a
raw output, retain exactly the bytes that were hashed so the asset's content hash equals `outputHash`.

### Hash by default, retain by exception

Raw output may be retained as a **principal-owned media asset** (`outputRef`) only for tools on the evidentiary
allowlist — config, not payload, so a publisher cannot self-declare a tool evidentiary:

- env `TURN_EVIDENCE_EVIDENTIARY_TOOLS` — comma-separated tool names; default `web_fetch,chain_read`; an
  explicitly empty value disables retention.
- the asset must exist, be `active`, be owned by `principalDid`, and its `hash` must equal `outputHash`.
  A missing asset and someone else's asset get the same 422 so asset ids are never confirmed.

## Ingest — the turn-finalization hook (plugin side)

`POST /auth/api/attestations/turn-evidence` — signed ingest, same model as the loops rail (`POST /api/loops`).
The signature is the credential; there is no session. One request per turn, **not per tool call**:

```ts
import { crypto, buildTurnEvidencePayload, hashToolIo, turnEvidenceSigningMessage } from '@imajin/auth';

const evidence = toolCalls.map((call, seq) => {
  const payload = buildTurnEvidencePayload({
    turnEventId, turnOutputHash: hashToolIo(replyText), agentDid, principalDid,
    tool: { name: call.name, provider: 'openclaw' },
    inputHash: hashToolIo(call.input), outputHash: hashToolIo(call.output),
    observedAt: call.finishedAt.toISOString().replace(/\.\d+Z$/, 'Z'), seq,
  });
  const issued_at = Date.now();
  const signature = crypto.signSync(turnEvidenceSigningMessage(payload, issued_at), agentPrivateKey);
  return { payload, issued_at, signature };
});
await fetch(`${kernel}/auth/api/attestations/turn-evidence`, { method: 'POST', body: JSON.stringify({ evidence }) });
```

Checks, all-or-nothing (nothing is written if any fails):

1. Shape: 1–100 items, strict payloads, one shared turn/claim hash/agent/principal, distinct `seq`s.
2. Every signature verifies against the agent DID's **current** registered key (400 `evidence_signature_invalid`,
   `evidence_agent_unknown`).
3. Authority: `agentDid === principalDid`, or an active `evidence:publish` delegation grant from the principal
   (403 `evidence_publisher_unauthorized`) — same shape as `loops:publish` (#2358).
4. `usageRef`, if present, must be the agent's own live `agent.turn.usage` attestation, so emit usage first
   (422 `evidence_usage_ref_unresolved`).
5. `outputRef` rules above (422 `evidence_tool_not_evidentiary`, `evidence_output_ref_invalid`,
   `evidence_output_ref_mismatch`).

Replays are idempotent: a unique index on `(issuer_did, context_id, payload->>'seq')` plus
`ON CONFLICT DO NOTHING` means a retried batch stores nothing new (200, `duplicateSeqs` lists the skipped
items; 201 when anything new was stored). Rate limit: 60 batches/min per client IP.

## Verify — no auth

`GET /auth/api/verify/turn/:hash` — `:hash` is the turn's `outputHash` (the claim). Anyone can recompute the
hash of the text they were shown and look it up (model: trustless-ai `/verify-proof`).

- **200** — per matching `(turn, signer)`: the evidence chain (tool name, input/output hashes, observed-at,
  `retained` flag), signer DID + current key id, per-row `signatureValid`, overall `signatureValid`/`valid`, and
  `linkage` (`turn`: resolved/unresolved/mismatch, `usage`: resolved/unresolved/none). Signatures are re-verified
  from the stored row, so changing any stored byte reports `signatureValid: false`.
- **404** — nothing is committed under that hash. This is also what a claim altered by one byte yields.
- **400** malformed hash · **429** rate limited (30/min per IP, `Retry-After`).

## `/jin` dashboard

`GET /auth/api/attestations/usage` rows gain an optional `evidenceCount` (evidence rows whose signed `usageRef`
is that turn's usage attestation); the usage feed panel shows it as an "Evidence" column. Best-effort: if the
count lookup fails the feed still renders. Retrace (#1962) is where evidence itself is read.

## Migration

`migrations/0169_turn_evidence_indexes.sql` (owner: kernel; additive, idempotent, no new table): partial index
on `payload->>'turnOutputHash'` (the public lookup), the unique replay index, a `usageRef` index for the dashboard
count, and a seed row in `auth.attestation_type_registry` so the type is registry-gated — `GET
/auth/api/attestations` then applies `disclosure_scope` (evidence defaults to `parties`) instead of listing
evidence anonymously.

## Assumptions and follow-ups

- **#1970 has not landed.** `turnEventId` is an opaque id the agent supplies; there is no FK. The kernel looks
  the turn event up in `kernel.audit_log` by id (the mirror retrace uses for `bus_event` hops) restricted to
  `TURN_EVENT_TYPES` in `apps/kernel/src/lib/turn-evidence/turn-event.ts`. Until a matching event exists,
  `linkage.turn` is `unresolved` — never fabricated. When #1970 lands: set `TURN_EVENT_TYPES` to its bus kind,
  confirm the two payload fields read there (`outputHash`, `usageRef`), and add lookup-by-`outputHash` so a turn
  with zero tool calls (zero evidence rows) still resolves on the verify endpoint.
- **`turnOutputHash` on each row** is how a claim resolves to evidence from the hash alone before #1970 exists;
  it must equal the turn event's `outputHash`, and the verify endpoint reports a `mismatch` if the turn event
  disagrees.
- **`usageRef`** is a denormalized convenience link (checked at ingest). The issue's authoritative link is
  #1970 event → `agent.turn.usage`; once that exists the dashboard can count via it instead.
- **#2407 (agent DID subtype / `serviceOf`)** is in flight separately. This codes against existing DID types
  (identity/app keys via `resolveIssuerCredentials`, delegation via `evidence:publish`). `serviceOf` could later
  become a further accepted authority path in `authorize-publisher.ts`.
- **Plugin repo** (`openclaw-imajin-plugin`): emitting the batch at turn finalization is plugin-side work
  (out of scope for this repo); the contract above is what it must implement. Everything it needs is exported
  from `@imajin/auth`.
- Out of scope, per the issue: external anchoring (OTS/Bitcoin) of turn + evidence hashes; key-manifest history.
