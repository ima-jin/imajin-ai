# Work Order Series: Sovereign Agent Governance Stack

**Goal:** Build the infrastructure for sovereign, federated, structurally-governed AI agents.

**Critical path:**
```
#461 Attestations → #432 MFA/Keys → #366 Agent Pairing → #394 Delegation
  → #465 Sandbox → #336 Trust Graph → #364 @imajin/graph → #433 Gas → #405 Phase 2
```

**Estimated total:** 6-8 weeks of focused work across 5 work orders.

---

## Work Order 1: Trust Foundation
**Issues:** #461, #454
**Estimated effort:** 3-4 days
**Status:** Ready now

The attestation chain and relay auth are prerequisites for everything else. Without attestations at every seam, the trust graph has no data. Without relay auth, anyone can write to our identity infrastructure.

### #461 — Attestation chain coverage

**Break into 4 sub-tasks:**

#### 461a: Attestation helper package
- Create `packages/auth/src/attestation.ts`
- `emitAttestation({ type, fromDid, toDid?, context, bilateral? })`
- POST to `auth/api/attestations/emit` (internal endpoint)
- Non-fatal wrapper (try/catch, console.warn on failure)
- Unit tests

#### 461b: Events attestations (Batch 1 — before April 1)
- `ticket.purchased` — in `apps/events/app/api/webhook/payment/route.ts`
- `event.attended` — in `apps/events/app/api/events/[id]/tickets/[ticketId]/check-in/route.ts`
- `event.created` — in `apps/events/app/api/events/route.ts`
- `cohost.added` — in `apps/events/app/api/events/[id]/cohosts/route.ts`
- All bilateral (event DID + actor DID both sign)

#### 461c: Identity attestations (Batch 2)
- `profile.verified` — profile service, on email/phone verify
- `handle.claimed` — profile service, on handle set
- `session.new_device` — auth service, on unknown device login

#### 461d: Commerce + social attestations (Batch 3-4)
- `listing.created`, `listing.purchased` — market service
- `message.first` — chat service
- `pod.created`, `pod.joined` — connections service
- `course.enrolled` — learn service
- `node.registered` — registry service

### #454 — Relay authZ

**Break into 2 sub-tasks:**

#### 454a: Gate relay writes with JWT auth
- Relay writes require signed JWT from a verified DID
- Use existing `@imajin/auth` middleware
- Reads remain open (public identity chains are public)
- Leverage dfos-web-relay 0.4.0 built-in auth token verification

#### 454b: External DID write policy
- External DFOS DIDs (non-Imajin) can write with their own JWT
- Track external writes separately (attestation: `relay.external_write`)
- Rate limit external writes (prevent spam/abuse)

---

## Work Order 2: Secure Identity
**Issues:** #432 (already has work order), #306 (folded in)
**Estimated effort:** 3-4 days
**Status:** Ready now, work order exists at `wo-432-461-mfa-attestations.md`

See existing work order. Key additions:

### New sub-tasks for agent context:

#### 432e: Agent key storage
- When an agent is paired (#366), its keypair needs secure storage
- Agent keys use the same `auth.stored_keys` table
- Agent keys are encrypted with the principal's passphrase (not the agent's)
- This means revoking the principal's key access also revokes agent access

#### 432f: Session types
- Add `sessionType` to JWT claims: `'human' | 'agent' | 'service'`
- Every endpoint can check if the caller is human or agent
- Agent sessions carry `principalDid` in claims
- This is the protocol-level discrimination already spec'd in #394

---

## Work Order 3: Agent Identity
**Issues:** #366, #394, #465
**Estimated effort:** 5-7 days
**Depends on:** WO1 (attestations), WO2 (secure keys)

This is the core unlock. After this, agents exist as first-class identities on the network.

### #366 — Agent-principal pairing

**Break into 4 sub-tasks:**

#### 366a: Schema + DID creation
- Add `principal_did` column to `auth.identities` (nullable, only set for agents)
- Add `paired_at` timestamp
- `POST /api/agents/create` — creates agent DID, links to principal
- Requires principal to be `established` tier (vouched)
- Agent DID format: `did:imajin:agent:{randomId}`
- Agent gets own Ed25519 keypair (derived or generated)

#### 366b: DFOS chain entry
- Agent creation emits DFOS identity chain genesis op
- Chain links to principal's chain via countersignature
- `pairing.created` bilateral attestation (principal + agent sign)
- Agent's chain carries `type: agent` and `principal` in state

#### 366c: Principal management API
- `GET /api/agents` — list my agents
- `DELETE /api/agents/:agentDid` — revoke agent (marks chain as revoked)
- `PATCH /api/agents/:agentDid` — update agent metadata (name, image, etc.)
- Revoking an agent emits `pairing.revoked` attestation
- Revoked agents cannot authenticate

#### 366d: Protocol enforcement
- Every endpoint checks `identity.type` — some actions human-only
- Agent requests always carry `principalDid` in session
- Services can check `identity.principal` to trace accountability
- Human-only actions: account deletion, key rotation, agent creation, MFA changes

### #394 — VC delegation

**Break into 3 sub-tasks:**

#### 394a: Delegation VC schema
```json
{
  "type": "AgentDelegation",
  "issuer": "did:imajin:human-abc",
  "subject": "did:imajin:agent-xyz",
  "scope": ["chat.send", "events.read", "pay.spend:100"],
  "constraints": { "maxSpend": 100, "conversationDids": ["did:imajin:group:xxx"] },
  "validFrom": "...",
  "validUntil": "...",
  "revocable": true
}
```
- Store in `auth.delegation_credentials` table
- VC signed by principal's key
- Verifiable by any service without calling auth (self-contained JWT)

#### 394b: Scope enforcement middleware
- `packages/auth/src/delegation.ts` — shared middleware
- `requireScope(request, 'chat.send')` — checks agent's delegation VC
- Human requests bypass scope checks (humans have full access to their own stuff)
- Returns 403 with clear message: "Agent not authorized for chat.send"

#### 394c: Delegation management UI
- Profile page section: "My Agents"
- Create agent, set name/avatar
- Configure delegation scopes (checkboxes for service access)
- Set spending limits
- Revoke button (immediate, emits attestation)

### #465 — Agent sandbox

**Break into 3 sub-tasks:**

#### 465a: Design decision — pick Option A/B/C
- Prototype each approach with a single agent (Jin)
- Measure resource overhead of OpenClaw-per-agent (Option A)
- Evaluate if scoped service context (Option B) is sufficient for v1
- **Recommendation:** Start with Option B (scoped context), graduate to Option C (hybrid) when agents need persistent background processing

#### 465b: Agent workspace
- Each agent DID gets a workspace directory (like OpenClaw's `~/.openclaw/workspace/`)
- SOUL.md, MEMORY.md, TOOLS.md — agent's own identity files
- Stored in media service, scoped to agent DID
- Principal can read agent's workspace (audit), agent can't read principal's

#### 465c: Agent runtime integration
- Define how an OpenClaw instance authenticates as an agent DID
- Agent's OpenClaw config includes: agent DID, principal DID, delegation VC path
- Every tool call authenticated as the agent DID
- Channel messages from agent carry `type: agent` in metadata

---

## Work Order 4: Trust Graph
**Issues:** #336, #364
**Estimated effort:** 5-7 days
**Depends on:** WO1 (attestations populate the graph), WO3 (agents are graph participants)

This is the "agents talking to agents" layer.

### #336 — Trust graph query engine

**Break into 3 sub-tasks:**

#### 336a: Graph data model
- Attestations ARE the graph edges
- Nodes = DIDs (human + agent)
- Edges = attestations (vouch, transaction, connection, pairing)
- Edge weights: vouch (10), transaction.settled (5), connection.accepted (3), session.created (1)
- Build adjacency query from `auth.attestations` table

#### 336b: Query API
- `GET /api/trust/:did/score` — weighted sum of attestations
- `GET /api/trust/:did/vouches` — vouch chain (who vouched, depth)
- `GET /api/trust/path/:from/:to` — BFS shortest trust path
- `GET /api/trust/:did/graph?depth=2` — local neighborhood
- All queries scoped to requester's own trust radius

#### 336c: Standing computation
- Standing = function of attestation diversity × age × volume
- Transparent formula, shown to user: "Your standing: 47 (12 vouches, 8 transactions, 3 events attended)"
- Standing determines capabilities (what tier you're in, what you can do)
- Agent standing derived from: own attestations + fraction of principal's standing

### #364 — @imajin/graph package

**Break into 3 sub-tasks:**

#### 364a: Core query engine
- `packages/graph/src/query.ts`
- `graph.query({ requesterDid, ownerDid, action, targets })` — trust-scoped query
- Resolves trust distance, checks delegation, returns scoped response
- In-process (no network hop), imported by any service

#### 364b: Intent documents
- `graph.createIntent({ requesterDid, actions: [...] })` — multi-service action plan
- Each service validates its piece independently
- Conflict detection: "Agent A wants to book the last ticket, Agent B wants it too"
- Resolution: first-come-first-served with attestation proof of order

#### 364c: Agent coordination protocol
- Agent-to-agent message format (signed, typed, trust-scoped)
- Discovery: "Which agents can I talk to?" (trust graph query)
- Negotiation: "Can your principal's agent do X for my principal?" (delegation check)
- Settlement: action completed → bilateral attestation

---

## Work Order 5: Economic Layer
**Issues:** #433, #405 (partial), #344
**Estimated effort:** 5-7 days
**Depends on:** WO3 (agents exist), WO4 (trust graph works)

### #433 — Gas credits

**Break into 3 sub-tasks:**

#### 433a: Virtual MJN ledger on DFOS chain
- Credit/debit operations as DFOS chain entries
- `Credit(100, 'account_creation')` on identity genesis
- `Debit(amount, action_type)` on metered actions
- Balance = replay chain (no mutable DB field)
- Chain entries are the mint proof for Year 3 token launch

#### 433b: Gas metering middleware
- `packages/auth/src/gas.ts` — `requireGas(request, action, amount)`
- Checks virtual MJN balance before allowing action
- Deducts on success, no deduction on failure
- Actions and their gas costs (configurable per node):
  - Email login: 0.01 MJN
  - Stored key login: 0.001 MJN
  - Agent API call: 0.001 MJN
  - Relay write: 0.01 MJN
  - Presence query: 0.1 MJN (most expensive — inference cost)

#### 433c: Balance UI + top-up
- Profile page: "MJN Balance: 94.73 / 100"
- Transaction history (chain entries, transparent)
- Top-up via pay service (fiat → virtual MJN)
- Minimum participation threshold display for future token mint

### #344 — Presence boundaries

**Break into 2 sub-tasks:**

#### 344a: Boundary detection + refusal
- System prompt injection for presence agents
- Model-based detection (off-topic, probing, extraction, jailbreak)
- Graceful refusal: "I'm [name]'s presence, not a general assistant"
- Configurable sensitivity per presence

#### 344b: Abuse attestations
- `query.out_of_scope` attestation on requester's DID chain
- `query.abuse` attestation after repeated violations
- Trust graph consequence: accumulated abuse attestations lower standing
- Network-wide: abuse at one presence visible to all presences (via trust graph query)

### #405 — DFOS Phase 2 (partial)

**Only the gas metering portion — other items (MCP, gossip) are separate sprints:**

#### 405-gas: Cross-protocol gas metering
- Every relay read/write metered at our edge
- Fee split: Imajin node (infrastructure) + content source (if applicable)
- Settlement via pay service
- Requires: gas credits (#433) + relay auth (#454)

---

## Execution Timeline

| Week | Work Order | Key Deliverable |
|------|-----------|----------------|
| 1 | WO1: Trust Foundation | Attestations emitting everywhere, relay gated |
| 1-2 | WO2: Secure Identity | MFA, device tracking, agent key storage |
| 2-3 | WO3: Agent Identity | Agent DIDs, pairing, delegation VCs, sandbox design |
| 4-5 | WO4: Trust Graph | Query engine, standing computation, @imajin/graph |
| 5-6 | WO5: Economic Layer | Gas credits, metering, presence boundaries |

**After this series:** The network has sovereign agents with structural governance. Every agent traces to a human. Every action is attested. Trust limits reach. Gas limits spend. The governance IS the architecture.

---

## New Sub-Issues to File

These sub-tasks should be filed as individual issues for tracking:

| Parent | Sub-task | Title |
|--------|----------|-------|
| #461 | 461a | Attestation helper package (`packages/auth/src/attestation.ts`) |
| #461 | 461b | Events attestations (ticket.purchased, event.attended, event.created, cohost.added) |
| #454 | 454a | Gate relay writes with JWT auth |
| #366 | 366a | Agent DID schema + creation endpoint |
| #366 | 366b | Agent DFOS chain entry + pairing attestation |
| #366 | 366c | Principal management API (list/revoke/update agents) |
| #366 | 366d | Protocol enforcement (human-only actions, agent session claims) |
| #394 | 394a | Delegation VC schema + storage |
| #394 | 394b | Scope enforcement middleware |
| #336 | 336a | Graph data model (attestations as edges) |
| #336 | 336b | Trust query API (score, vouches, path, neighborhood) |
| #336 | 336c | Standing computation (transparent formula) |
| #433 | 433a | Virtual MJN ledger on DFOS chain |
| #433 | 433b | Gas metering middleware |
| #465 | 465a | Agent sandbox design decision |
| #465 | 465b | Agent workspace (SOUL.md, MEMORY.md per agent DID) |
