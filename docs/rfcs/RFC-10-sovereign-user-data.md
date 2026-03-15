# RFC-10: Sovereign User Data — Portable Identity Bundles and Federated User Operations

**Status:** Discussion
**Authors:** TBD
**Created:** TBD
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/255

---

*Migrated from #251*

---

## Summary

An architectural RFC for how user data is stored, owned, and operated on across the Imajin platform. Defines the relationship between service-owned tables (runtime model) and user-owned portable data bundles (canonical truth).

## Problem

Today, a user's data is scattered across 13+ service databases, organized by what each service needs. The user's identity is sovereign (DID, keypair, portable) but their data is not — it's shaped by services, not owned by users. This is structurally the same model as every platform, just self-hosted instead of cloud-hosted.

For Imajin to deliver on sovereignty, users need to be able to:
- **Export** — pull a complete, portable data object at any time
- **Delete** — coordinated removal across all services, with proof
- **Transfer** — move to another node with full data continuity
- **Backup** — user-controlled, user-stored copies

## Architectural Position

### Service tables are the runtime model

Postgres stays. Services query shared indexes for performance — loading an event chat with 400 attendees can't fan out to 400 per-user databases. Relational tables are the right choice for coordinated reads.

### The user's data bundle is canonical truth

The exportable, signed, portable data object is the *source of truth* for what belongs to a user. If the node disappears, the bundle is what survives. Postgres is effectively a cache of user-owned data.

## Design: Append Log per DID

Every mutation that touches a user's data appends to a per-DID event log:

```
did:imajin:ryan → [
  { t: 1709000001, service: "auth",    op: "identity.create", ... },
  { t: 1709000045, service: "profile", op: "profile.create", ... },
  { t: 1709000200, service: "events",  op: "ticket.purchase", ref: "tkt_xxx", ... },
  { t: 1709000300, service: "chat",    op: "message.send", ref: "msg_xxx", ... },
  { t: 1709000400, service: "media",   op: "asset.upload", ref: "ast_xxx", context: "personal", ... },
]
```

### Why append log over dynamic export

| Approach | Pros | Cons |
|----------|------|------|
| Dynamic export (query on demand) | Always current, no extra storage | Slow, all services must be up, no audit trail |
| Continuous append log | Instant export, audit trail for free, transfer = log replay | Parallel data structure to maintain |

The append log wins because it also provides:
- **Audit trail** — every change to your data, when, by which service
- **Transfer** — ship the log to a new node, replay it, rehydrate
- **Verifiable delete** — cryptographic proof that every append was reversed
- **Backup** — the log *is* the backup, continuously updated

## Federated User Operations

Each service implements a standard interface:

### `exportForDid(did)`
Returns all data owned by this DID from this service, in a portable format.

### `deleteForDid(did)`
Removes all data for this DID. Returns a signed deletion receipt. Open questions:
- **Tombstone vs hard-delete?** A .fair chain with a deleted creator has a hole in provenance
- **Shared data?** Chat messages in group conversations, co-authored .fair manifests
- **Retention windows?** Legal/financial records may require minimum retention

### `transferForDid(did, targetNode)`
Coordinates with target node to migrate data. Verify DID ownership on both ends.

### `countForDid(did)`
Returns data footprint — useful for pre-delete review ("you have 47 assets, 312 messages, 3 tickets").

### Orchestrator

Auth service (as identity authority) fans out operations to all registered services. The service manifest (#227) provides the map of "who has data for this DID."

## The Data Bundle

A user's portable data object, assembled from the append log or dynamic export:

```json
{
  "did": "did:imajin:ryan",
  "exported_at": "2026-03-09T16:45:00Z",
  "node": "jin.imajin.ai",
  "signature": "...",
  "sections": {
    "identity": { "attestations": [...], "tier": "hard" },
    "profile": { "handle": "ryan", "display_name": "...", ... },
    "media": { "assets": [...], "contexts": [...] },
    "events": { "tickets": [...] },
    "chat": { "messages": [...] },
    "connections": { "graph": [...] },
    "learn": { "enrollments": [...], "progress": [...] },
    "fair": { "manifests": [...] }
  }
}
```

Signed by the user's DID keypair. Verifiable by any node.

## Open Questions

1. **Log storage** — per-DID append logs in postgres? Separate event store? Filesystem?
2. **Log compaction** — do we compact over time, or keep full history?
3. **Shared data semantics** — when you delete, what happens to your messages in group chats? Your name on .fair manifests others reference?
4. **Plugin data** — third-party apps (#249) that store user data need to implement the same interface. How do we enforce this?
5. **Media binaries** — the log tracks metadata, but asset files need their own export/transfer path (could be large)
6. **Encryption at rest** — should the append log be encrypted with the user's key?

## Related

- #3 — First node registration
- #24 — Node registry certification and heartbeat
- #155 — DID-to-endpoint resolution
- #156-#160 — Federated chat sequence
- #227 — Shared service manifest
- #244 — Delegated app sessions
- #249 — Plugin architecture
- #250 — Media context routing
