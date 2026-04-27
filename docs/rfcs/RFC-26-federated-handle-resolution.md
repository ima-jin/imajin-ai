---
title: Federated Handle Resolution
type: rfc
status: draft
author: Ryan Veteze, Jin
slug: RFC-26-federated-handle-resolution
topics:
  - legibility
  - identity
  - agents
  - dfos
  - settlement
  - governance
  - events
  - federation
  - sovereignty
refs:
  rfcs:
  - 19
  - 20
  - 22
---
# RFC-26: Federated Handle Resolution

**Status:** Draft  
**Author:** Ryan Veteze, Jin  
**Created:** 2026-04-13  
**Related:** RFC-19 (Kernel/Userspace), RFC-20 (Chain Types), RFC-22 (Federated Auth)

---

## Abstract

Handles (`@ryan`) are human-readable aliases for DIDs. On a single node they're trivially unique — a database constraint. Across a federated network of sovereign nodes, they need a resolution protocol that prevents impersonation, preserves sovereignty, and avoids centralized registries.

This RFC defines **handle claims as DFOS chain events**, giving handles the same cryptographic provenance as identity itself. Nodes gossip handle claims through the existing peering mesh. First-to-chain wins. Every handle carries verifiable provenance visible to users.

## Problem

1. **Handles are node-scoped today.** `@ryan` on `jin.imajin.ai` and `@ryan` on `brandon.clearbyte.io` are independent. No collision detection, no cross-node resolution.

2. **Impersonation risk.** Users trust handles more than DIDs. Someone grabs `@borzoo` on another node and messages people — the DID is different but the display name looks right. Most humans won't verify a base58 string.

3. **Centralized registry is antithetical.** A global handle database contradicts sovereign node architecture. DNS-based proof (Bluesky model) works but creates dependency on DNS infrastructure and domain ownership.

## Design

### Handle Claims as Chain Events

When an identity claims a handle on a node, the node publishes a signed event to the identity's DFOS chain:

```json
{
  "type": "handle.claim",
  "handle": "ryan",
  "node": "jin.imajin.ai",
  "nodeDid": "did:imajin:6Y6fwZeqe1wME3heZ2vy1cV3x9zwq4Gphqm6yKC95dBg",
  "timestamp": "2026-04-13T22:20:00Z"
}
```

The event is:
- **Signed** by the node's platform key (proves the node authorized it)
- **Appended** to the identity's DFOS chain (immutable, ordered)
- **Gossiped** to all peered nodes via standard DFOS relay sync

### Handle Releases

```json
{
  "type": "handle.release",
  "handle": "ryan",
  "node": "jin.imajin.ai",
  "timestamp": "2026-04-14T10:00:00Z"
}
```

Releases free the handle for future claims. The chain preserves the full history (claim → release → reclaim).

### Conflict Resolution

**First-to-chain wins.** When two nodes independently claim the same handle for different DIDs:

1. On peering/sync, both nodes discover the conflict
2. The earlier `handle.claim` timestamp takes priority
3. The losing node's handle enters a **contested** state
4. The losing node notifies the affected identity: "Your handle `@ryan` conflicts with an earlier claim. Choose a new handle or dispute."

**Dispute path (future):** Bilateral attestation from both parties, or community governance vote. Out of scope for v1 — timestamp priority is the default.

**Partition tolerance:** Two nodes that never peer can hold the same handle indefinitely. Conflict surfaces only on connection. This is acceptable — the mesh grows, conflicts resolve. Same as CRDT eventual consistency.

### Resolution Protocol

When node A encounters a DID from node B and needs to display a handle:

1. **Check local cache** — if A has synced B's chain, the handle claim is already local
2. **Chain lookup** — scan the DID's DFOS chain for the latest `handle.claim` event
3. **Fallback fetch** — query the originating node's profile endpoint (existing `GET /auth/api/lookup/:did`)

Resolution is always DID → handle (never handle → DID across nodes). Cross-node handle search is a discovery feature, not an identity feature.

### Local Nicknames

Nodes can maintain local aliases independent of chain handles. If you want to call `did:imajin:xyz` something different on your node, that's a presentation-layer decision. The chain handle is the *canonical* name; local nicknames are overrides.

## Handle Provenance Badge

Every handle in the UI carries a provenance indicator — the 🌟 badge.

### Rollover / Tooltip

Hovering or tapping the badge reveals:

```
@ryan 🌟
├─ DID: did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU
├─ Registered: 2026-03-08 on jin.imajin.ai
├─ Home node: jin.imajin.ai
├─ Trust tier: established ✓
├─ Controls:
│  ├─ @imajin (business) — owner
│  └─ @mooi (community) — admin
└─ Chain: 47 events, last sync 2m ago
```

### Badge States

| Badge | Meaning |
|-------|---------|
| 🌟 | Verified handle claim on home node, synced via DFOS |
| ⚡ | Local handle (your own node, not yet synced to peers) |
| 🔗 | Foreign handle (resolved from remote node, cached) |
| ⚠️ | Contested handle (timestamp conflict with another claim) |
| 👤 | No handle — displaying DID or local nickname |

### Provenance Data

The badge tooltip shows:
- **DID** — the canonical identity (truncated with copy button)
- **Registration** — when and where the handle was first claimed
- **Home node** — the node that authorized the claim
- **Trust tier** — soft / preliminary / established
- **Controlled identities** — group/business/community DIDs this identity has owner/admin role on (from `identity_members`)
- **Chain health** — event count and last sync time

This gives users an at-a-glance way to verify someone is who they claim to be, without needing to understand DIDs or chain mechanics.

## Chain Type

Handle claims use a new DFOS chain type (per RFC-20):

```
chain_type: "handle"
```

Properties:
- **Single-writer** — only the owning node can append (via platform key)
- **Append-only** — claims and releases, no edits
- **Lightweight** — small events, no content payloads
- **Per-identity** — each DID has at most one handle chain

This keeps handle data separate from the identity's main chain, which may carry heavier payloads (attestations, delegation, etc.).

## Migration Path

### Phase 1: Local + Display (now)
- Handles remain node-local (SQL unique constraint)
- Cross-node: display remote handle from profile fetch, no chain integration
- Badge shows ⚡ (local) or 🔗 (remote fetch)

### Phase 2: Chain Claims (next)
- Handle claims written to DFOS chains on creation/change
- Gossip propagates claims to peered nodes
- Conflict detection on sync
- Badge shows 🌟 for chain-verified handles

### Phase 3: Global Resolution (later)
- Handle search across the mesh
- Dispute resolution protocol
- Handle reservation / premium handles via MJN staking

## Security Considerations

- **Node impersonation:** A malicious node could forge handle claims with backdated timestamps. Mitigation: chain events include the node's DID and signature. Peered nodes can verify the signing key matches the node's known identity.
- **Timestamp manipulation:** Nodes control their own clocks. For v1, we trust that peered nodes are honest (same trust model as DFOS generally). Future: use chain ordering rather than wall-clock time.
- **Handle squatting:** First-to-chain means someone could squat on handles. Mitigation: contested handles can be challenged through governance (Phase 3). MJN staking for premium handles creates economic friction.
- **Privacy:** Handle claims are public chain data. If you don't want your handle visible on the mesh, don't claim one — use DID-only identity.

## Open Questions

1. **Should handle changes require the old handle to be released first?** Or can you just claim a new one (implicitly releasing the old)?
2. **Handle format restrictions across nodes** — should all nodes enforce the same regex (`[a-z0-9_]{3,30}`), or can nodes have different rules?
3. **Reserved handles** — should protocol-level handles (`@admin`, `@system`, `@imajin`) be reserved across all nodes?
4. **Handle transfer** — can a handle be transferred to another DID? If so, same chain or new claim?

---

*"Your identity shouldn't be defined by which server you're on."*
