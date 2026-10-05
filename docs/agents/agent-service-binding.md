# Agent DID and the `serviceOf` binding

Refs [#2407](https://github.com/ima-jin/imajin-ai/issues/2407) (RFC-31 v2 Phase 1) under the
Agent Runtime epic [#1758](https://github.com/ima-jin/imajin-ai/issues/1758). Spec: `docs/rfcs/RFC-31-agent-execution-sandbox.md`.

## 1. What this is

An agent is a first-class DID: `scope = 'actor'`, `subtype = 'agent'` on `auth.identities`. It is **in
service of** one or more principal DIDs (humans, groups, businesses, other agents). One agent may serve
many principals; one principal may have many agents.

That relation — `serviceOf` — is the binding between a principal and the harness instance running its
agent. **The kernel addresses the agent DID, never a gateway.** Where the instance runs (a laptop
OpenClaw today, a provisioned container tomorrow) is a property of the live connection, not of the
identity.

## 2. Data model — no new tables

`serviceOf` is a **read-only view** over rows that already exist:

```
serviceOf(agent → principal)  ≡  an active auth.identity_members row
                                  identity_did = <principal>, member_did = <agent>, role = 'agent',
                                  removed_at IS NULL
                                  AND the member is an actor/agent identity that is not suspended
```

This is the same row `resolveAgentAuthority()` (`src/lib/auth/agent-authority.ts`) already reads for
`X-Acting-For` / `register_also`, and the row `mintAgentIdentity()` / the envelope provisioner already
write. No migration was needed. Code: `apps/kernel/src/lib/auth/agent-service.ts`.

Not part of the view, by design:

- A `role='agent'` row whose member is **not** an `actor/agent` (forged or stale) — the row alone does not
  make an agent.
- A suspended agent, a removed binding, or any other role (`owner`, `member`, ...).
- A grant-only external agent (`delegation_grants` without a membership row, e.g. a knock-accepted
  foreign agent). Those are authorized by their grant; they are not "serving" in the `serviceOf` sense.

## 3. No new authority

Neither the `agent` subtype nor a `serviceOf` entry grants anything. Authority is still decided only by
`resolveAgentAuthority()` (active grant first, then the `role='agent'` membership fallback), which never
reads the subtype and never reads `agent-service.ts`. `agent-service.ts` performs no writes. This is
enforced by tests (`src/lib/auth/__tests__/agent-service.test.ts`, "authority" block).

## 4. API surface (what consumers use)

### Resolve an agent → `serviceOf`

`GET /auth/api/identity/{agentDid}` — existing public endpoint; returns `scope: "actor"`,
`subtype: "agent"`. When the caller is **authenticated and a party to the relation** it also returns
`serviceOf: string[]` (principal DIDs). Parties: the agent itself (its own session DID) and a principal it
serves (session DID, or the group DID via `X-Acting-As`; a principal sees only its own entry). Everyone
else gets the identity without the field. `X-Acting-For` never widens this — only the session DID counts.

This is what a plugin uses to verify "I am bound to principal P": call it with the agent's own
credentials and check `P ∈ serviceOf`.

### Principal → serving agents + connection state

`GET /auth/api/identity/{principalDid}/agents` (session cookie or bearer)

```json
{
  "principal": "did:imajin:…",
  "agents": [
    {
      "did": "did:imajin:…",
      "handle": "veteze-jin",
      "name": "Jin",
      "scope": "actor",
      "subtype": "agent",
      "servingSince": "2026-09-01T00:00:00.000Z",
      "connection": { "state": "connected" }
    }
  ]
}
```

- Only the principal may call it (its own session DID, or the group DID via `X-Acting-As`). `403`
  otherwise — including for an `actor/agent` session and for any call under `X-Acting-For`.
- `connection.state` is `connected | disconnected | unknown`. **`unknown` means the check itself failed**
  (internal key unset, ws-server unreachable); never treat it as `disconnected`.

### In-process (kernel code, e.g. the #2251 router)

`resolveServingAgents(principalDid)` in `src/lib/auth/agent-service.ts` returns the same `agents[]`.
`listServingAgents` / `listServiceOf` are the DB-only halves.

## 5. Live connection = the agent DID's own authenticated WebSocket

The plugin's existing outbound WS (`/ws`, authenticated by session cookie or a `ws-token` `auth` frame) as
the **agent DID** is the registration. `ws-server.js` tracks open sockets per DID (`didSockets`);
connection state is "this DID has ≥ 1 open own socket". Sockets that only hold a `register_also`
delegation for a DID do **not** count — an agent being online must never read as its principal being
online.

`ws-server.js` is a separate CJS process boundary, so Next routes read this through one internal,
read-only route (same family as `did-push`):

`POST /chat/api/internal/did-connections` — header `x-internal-key: $AUTH_INTERNAL_API_KEY`, body
`{ "dids": ["did:imajin:…"] }` (1–50), reply `{ "connected": ["did:imajin:…"] }`. Kernel client:
`src/lib/auth/did-connections.ts`. No new env var.

## 6. `onBehalfOf` convention

The agent acts; the principal delegates. New consumers of this relation record the **agent DID as the
actor** and the **principal DID as the delegator**, matching `delegation_grants.agentDid` /
`delegatorDid`. This PR does not change the meaning of the existing `onBehalfOf` field on any existing
write path (grants' `onBehalfOf` chain, connector/mail signing, `actingFor` attribution): retrofitting those
is a separate, behavior-changing step.

## 7. Known gap (pre-existing, not changed here)

`DELETE /auth/api/agents/:did` soft-removes the *owner* row on the agent identity but not the principal's
`role='agent'` row, and does not revoke grants. A revoked agent therefore still appears in `serviceOf`
(and still resolves under the membership fallback in `resolveAgentAuthority`, exactly as before). The view
tracks the authority rows faithfully; closing the revoke gap is a separate change to the kill switch.
