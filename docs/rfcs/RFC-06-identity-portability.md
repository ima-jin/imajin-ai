# RFC-06: Identity Portability & Backup Nodes

**Status:** Draft
**Author:** Ryan Veteze, Jin
**Date:** 2026-03-05
**Discussion:** none
**Related:** Federation (#registry), MJN Token, Network of Souls

---

## Why Existing Standards Aren't Enough

The open web has spent years trying to solve social identity portability. The results are instructive failures:

**ActivityPub / Fediverse:** The W3C-backed protocol behind Mastodon, Lemmy, Pixelfed, and others. Identity is `@user@instance.tld` — structurally bound to the server operator. If your instance shuts down, your identity, followers, and content go with it. Migration exists but it's manual, lossy, and requires the old instance to cooperate. The protocol solves *federation* (servers talking to each other) but not *sovereignty* (you owning your identity independent of any server).

**AT Protocol / Bluesky:** Improves on ActivityPub with portable DIDs and signed data repositories. Closer to the right idea. But in practice, identity resolution still funnels through Bluesky's PLC directory — a centralized service that maps DIDs to hosting servers. The protocol *could* be decentralized, but the implementation concentrates control. And there's no native payment layer, no attribution standard, no concept of trust-bound access.

**Solid / Tim Berners-Lee:** Personal data pods where you control your storage. Philosophically aligned but academically complex, low adoption, and no clear path to social features people actually want. Solving storage without solving identity, payments, or trust.

**The common thread:** These projects solve parts of the problem (federation, data hosting, protocol interop) but none of them deliver full context portability — your identity, connections, trust graph, attribution records, payment history, and media as a single sovereign package that survives any single server failure.

## Problem

Today, Imajin identities (DIDs + keypairs) are structurally independent from any server, but practically dependent on a single registry node. If imajin-server goes down:

- DID resolution fails (nobody can look you up)
- Connections / trust graph is lost
- Media assets are inaccessible
- .fair attribution records disappear
- Transaction history is gone

The keypair survives on the user's device, but an identity without context is just a key that proves nothing useful. We have the same single-point-of-failure as ActivityPub instances, just with different furniture.

**The difference:** Our identity model (keypair-based, not `username@host`) means portability is *buildable* without redesigning the protocol. But until it's built, "sovereign identity" is a promise, not a fact.

## Goals

1. **No single point of failure** — one node going down doesn't kill an identity
2. **User-controlled redundancy** — you choose who holds your mirrors (not us)
3. **Full context portability** — not just the key, but connections, data, trust graph, .fair, transactions
4. **Sovereignty-consistent** — no mandatory cloud dependency, no corporate custody
5. **Automatic failover** — backup nodes promote seamlessly

## Design

### Identity Context Package

Everything that constitutes "you" beyond the keypair:

```
identity-package/
├── identity.json          # DID document, public key, metadata
├── connections.json       # Trust graph (who you know, trust levels)
├── fair/                  # .fair manifests (attribution records)
├── media/                 # Asset references + optional encrypted blobs
├── transactions.json      # Payment/settlement history
├── conversations.json     # Chat metadata (not content if E2EE)
└── manifest.json          # Package version, created_at, signature
```

The entire package is signed by the user's keypair and encrypted with their key. Nobody can read it but them (and nodes they explicitly grant access to).

### Three Tiers of Resilience

#### Tier 1: Encrypted Export
- User downloads their full identity context as an encrypted package
- Store anywhere: USB drive, cloud storage, email to yourself
- Restore by importing to any Imajin node
- **Tradeoff:** Manual, point-in-time snapshot, no automatic failover

#### Tier 2: Backup Nodes
- User designates 1-3 backup nodes (friend's server, own RPi, VPS)
- Primary node syncs encrypted context to backups on a schedule
- Backup nodes can't read the data — they're encrypted storage
- If primary goes down, user points their DID at a backup node
- **Tradeoff:** Requires trust in availability (not confidentiality) of backup operators

```
Primary node ──encrypted sync──→ Backup node 1
                              ──→ Backup node 2
                              ──→ Backup node 3 (cloud VPS)
```

#### Tier 3: On-Chain Registry + Mesh
- DID → public key mapping on Solana (or similar)
- Resolution doesn't depend on any single node
- Backup node addresses registered on-chain
- Automatic failover: if primary doesn't heartbeat, clients try backups
- **Tradeoff:** Requires token/chain infrastructure

### Sync Protocol

```
1. Primary packages identity context
2. Encrypts with user's public key
3. Signs package with user's private key
4. Pushes to registered backup nodes via HTTPS
5. Backup nodes verify signature, store encrypted blob
6. Backup nodes heartbeat to confirm they're holding the package
7. On restore: user decrypts with private key, imports to new primary
```

**Sync frequency:** Configurable. Default daily, with event-driven sync on significant changes (new connection, large transaction, etc.)

### Failover Flow

```
1. Primary node goes offline
2. User still has keypair on device
3. User connects to backup node
4. Authenticates with keypair (challenge-response)
5. Backup decryption happens client-side
6. User either:
   a. Promotes backup to primary, or
   b. Exports and imports to a fresh node
7. Updates DID resolution (registry or on-chain) to point to new node
```

### Comparison with ActivityPub

| Aspect | ActivityPub | Imajin (with this RFC) |
|--------|-------------|----------------------|
| Identity model | `@user@server` | Keypair (DID) |
| Portability | Request export, hope new instance imports it | Encrypted sync, automatic failover |
| Who holds your data | Instance operator (plaintext) | You choose, encrypted at rest |
| Server goes down | Identity gone | Switch to backup, keep going |
| Trust relationships | Per-instance followers | Portable trust graph |
| Payment history | N/A | Included in context package |

## Value Flow

The missing piece in every open standard to date: **who pays for the infrastructure?**

ActivityPub instance operators run on donations and goodwill. When the money or motivation runs out, the instance dies — and every identity on it dies too. The protocol is technically sound; the economics are not. AT Protocol concentrates hosting at Bluesky because nobody else has incentive to run relay infrastructure at scale.

Imajin solves this by making value flow naturally through the network as a consequence of people doing things:

```
User activity (message, file share, ticket purchase, query)
  → .fair records attribution
  → Transaction settles (fiat now, MJN when ready)
  → Fees distribute to infrastructure operators
```

### Who Gets Paid

| Role | Value Created | Revenue |
|------|--------------|---------|
| **Primary node operator** | Hosts your identity, serves your data | Storage + compute fees from your activity |
| **Backup node operator** | Holds encrypted redundancy | Redundancy fee (tiny, automatic, per-sync) |
| **DID resolver** | Answers "who is this?" lookups | Resolution fee per query |
| **Relay node** | Routes messages between nodes | Relay fee per message |
| **Content creator** | Produces things people want | .fair attribution splits on every transaction |

### Why This Works

Every node in the network is economically motivated to stay online. Backup nodes aren't charity — they're paid participants. The more active your identity, the more your infrastructure earns. This creates a natural market:

- Popular identities generate more queries → node operators compete to host them
- Redundancy has a price → users choose their backup level (1 node = cheap, 3 nodes = resilient)
- Resolution is a service → more nodes = faster lookups = better network

The economic model *is* the resilience model. Nodes stay up because they earn. Identities survive because keeping them alive is profitable.

This is fundamentally different from "run a server and hope people donate." It's infrastructure that pays for itself.

## Dependencies

- **Registry service** — needs backup node registration endpoints
- **Identity context packaging** — new service/library to assemble + encrypt
- **Sync protocol** — encrypted push to backup nodes
- **Client-side decryption** — for restore flow
- **On-chain registry** (Tier 3) — Solana DID resolution (depends on MJN token)

## Open Questions

1. **E2EE chat content** — Chat messages are end-to-end encrypted. Backup includes metadata (conversations, participants) but message content requires the conversation keys. How do we handle key escrow for backup?
2. **Media blobs** — Do we sync actual media files or just references? Full sync = large packages. References = dependent on media service availability.
3. **Revocation** — If a backup node goes rogue (serves stale data), how does the user revoke it?
4. **Discovery** — How do new contacts find you after a failover? DNS update? On-chain pointer?
5. **Incremental sync** — Full package on every sync is wasteful. Delta sync adds complexity. What's the right tradeoff?

## Tickets (to be created when RFC is accepted)

- [ ] Identity context package format specification
- [ ] `GET /api/identity/export` — encrypted package download (Tier 1)
- [ ] `POST /api/identity/import` — restore from package
- [ ] Backup node registration in registry
- [ ] Encrypted sync protocol (Tier 2)
- [ ] Backup node heartbeat monitoring
- [ ] Failover flow (client-side)
- [ ] On-chain DID resolution (Tier 3)

---

*"What Portable Actually Means" — not just moving your key, but moving your life.*
