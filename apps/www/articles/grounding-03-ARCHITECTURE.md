# The Imajin Architecture

*How the pieces connect. When the whitepaper and this document disagree on implementation, this document is current.*

*Last updated: March 1, 2026*

---

## Layer Map

```
┌─────────────────────────────────────────────────────────────┐
│                      CONSUMERS / CLIENTS                     │
│         browsers, apps, agents, devices, other nodes         │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                     APPLICATION LAYER                        │
│                                                              │
│   www        profile      events       chat       learn      │
│   coffee     links        dykil                              │
│                                                              │
│   Any app that consumes the platform packages.               │
│   Standalone repos. Pluggable. Replaceable.                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                     PLATFORM LAYER                           │
│                                                              │
│   ┌─────────┐  ┌─────────┐  ┌──────────────┐  ┌─────────┐  │
│   │  auth   │  │   pay   │  │  connections  │  │registry │  │
│   │         │  │         │  │              │  │         │  │
│   │ keypair │  │ stripe  │  │ trust graph  │  │  node   │  │
│   │ DID     │  │ solana  │  │ vouching     │  │  disco- │  │
│   │ sign    │  │ settle  │  │ queries      │  │  very   │  │
│   │ verify  │  │         │  │              │  │         │  │
│   └─────────┘  └─────────┘  └──────────────┘  └─────────┘  │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                     SHARED PACKAGES                          │
│                                                              │
│   @imajin/auth    — identity primitives (keypair, DID, sig)  │
│   @imajin/db      — postgres-js + drizzle-orm                │
│   @imajin/pay     — payment abstractions                     │
│   @imajin/config  — shared configuration                     │
│   @imajin/ui      — shared components                        │
│   @imajin/trust-graph — graph queries + trust primitives     │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                     PROTOCOL LAYER (MJN)                     │
│                                                              │
│   DID        — sovereign identity (W3C spec, Ed25519)        │
│   .fair      — attribution manifests (embedded, signed)      │
│   Consent    — programmable, per-interaction                  │
│   Settlement — automated value flow through .fair chains     │
│                                                              │
│   See: docs/mjn-whitepaper.md for full protocol spec         │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                     INFRASTRUCTURE                           │
│                                                              │
│   Postgres (imajin-server, 192.168.1.193)                    │
│   pm2 process management                                     │
│   Caddy reverse proxy + auto-SSL                             │
│   GitHub Actions (self-hosted runner)                         │
│   Node.js v22 runtime                                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## The Four Primitives

Everything in the system is built from four protocol-level primitives. These are defined in the MJN whitepaper and implemented across the platform packages.

### 1. Identity (DID)

Every entity that acts gets a DID. Humans, agents, events, orgs — same primitive, different type label.

```
did:mjn:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

- **Generated by:** `@imajin/auth` → `generateKeypair()` → Ed25519
- **Stored:** Private key on owner's device. Public key in auth service.
- **Used by:** Every service. Every signed interaction. Every transaction.
- **Soft registration:** `did:email:user_at_domain.com` as onramp before full keypair generation.

### 2. Attribution (.fair)

A signed manifest embedded in the work itself. Not in a database. In the work.

```json
{
  "version": "1.0",
  "id": "fair_xxx",
  "contributors": [
    { "did": "did:mjn:...", "role": "author", "share": 0.7 },
    { "did": "did:mjn:...", "role": "editor", "share": 0.3 }
  ],
  "derives_from": ["fair_yyy"],
  "terms": { ... },
  "signature": "..."
}
```

- **Immutable** — once signed, the chain can't be altered
- **Portable** — travels with the work across any platform
- **Executable** — settlement instructions are embedded, not external

### 3. Consent

TODO: Programmable consent per interaction. Not a terms-of-service checkbox. A signed declaration attached to each exchange that says exactly what the sender permits.

### 4. Settlement

When value moves, it follows the .fair chain:

```
Consumer pays $10
    → .fair manifest splits: 70% author, 30% editor
    → Settlement executes: $7 → author DID, $3 → editor DID
    → Receipt generated: consumer sees full breakdown
```

- **Pluggable backends:** Stripe (now), Solana (next), any payment rail
- **Implemented by:** `@imajin/pay` package + `pay` service
- **Real-time:** No batching, no pool model. Transaction settles immediately.

---

## Service Map

### Platform Services (monorepo: `imajin-ai`)

| Service | Port (dev/prod) | Purpose | Key Package |
|---------|----------------|---------|-------------|
| **www** | 3000 / 7000 | Public site, essays, landing | @imajin/ui |
| **auth** | 3001 / 7001 | Identity — keypair, DID, signatures | @imajin/auth |
| **registry** | 3002 / 7002 | Node discovery — register, heartbeat, lookup | @imajin/auth |
| **connections** | 3003 / 7003 | Trust graph — vouch, query, relationship mgmt | @imajin/trust-graph |
| **pay** | 3004 / 7004 | Payments — Stripe, settlement, receipts | @imajin/pay |
| **profile** | 3005 / 7005 | Identity display — handle, bio, avatar | @imajin/auth |
| **chat** | 3007 / 7007 | Messaging — signed, between DIDs | @imajin/auth |
| **events** | 3006 / 7006 | imajin-events | Event creation, ticketing, attendance |

### Planned Applications

| Service | Repo | Purpose |
|---------|------|---------|
| **learn** | imajin-courses | Education — teach people how to teach |
| **coffee** | imajin-ai/apps/coffee | Local meetups |
| **links** | imajin-ai/apps/links | Curated link sharing |
| **dykil** | imajin-ai/apps/dykil | TBD |

---

## Data Flow: A Transaction

How a ticket purchase actually moves through the system. This is the flow validated on February 20, 2026 (first ticket sold).

```
1. Consumer visits events.imajin.ai
2. Clicks "Buy Ticket" → redirected to pay.imajin.ai
3. pay service creates Stripe checkout session
   - Attaches buyer DID (or soft registration)
   - Attaches event DID
   - Attaches .fair manifest for the event
4. Consumer completes Stripe payment
5. Stripe webhook → pay service
6. pay service:
   a. Records transaction with DIDs + .fair chain
   b. Executes settlement (splits per .fair manifest)
   c. Creates ticket (signed message: event DID → buyer DID)
   d. Generates receipt (full transparency)
7. Consumer receives ticket — a signed assertion they belong in the room
```

---

## Data Flow: Trust Graph Query

How someone queries a knowledge leader's presence on the network.

```
1. Querier has DID, is in knowledge leader's trust graph
2. Query sent to knowledge leader's node
   - Signed by querier's DID
   - Carries consent declaration
   - Carries settlement instruction (inference fee)
3. Node validates:
   a. Querier is in trust graph (connections service)
   b. Consent terms are acceptable
   c. Settlement instruction is valid
4. Node processes query (AI inference)
5. Response returned:
   - Signed by knowledge leader's DID
   - .fair manifest attributes the response
   - Settlement executes (inference fee → knowledge leader)
   - Receipt generated for querier
6. Knowledge leader's distribution chain executes:
   - Earnings flow downstream per their .fair chain
   - Environmental causes, local initiatives, friends — visible
```

---

## Node Architecture

A node is a self-hosted instance of the Imajin stack. Minimum viable node:

```
┌─────────────────────────────────┐
│           Your Node              │
│                                  │
│   auth    — your identity        │
│   profile — your presence        │
│   pay     — your transactions    │
│                                  │
│   + any apps you choose to run   │
│                                  │
│   Hardware: RPi, old laptop,     │
│   VPS, or HP ProLiant :)         │
└─────────────────────────────────┘
         │
         │ heartbeat (daily)
         ▼
┌─────────────────────────────────┐
│   registry.imajin.ai             │
│                                  │
│   Provisions: {you}.imajin.ai    │
│   Verifies: build attestation    │
│   Discovery: public directory    │
└─────────────────────────────────┘
```

### Registration Flow

1. Node generates keypair → creates DID
2. Node computes build attestation (hash of running binary)
3. POST `/api/node/register` → registry verifies build hash
4. If valid → provisions `{hostname}.imajin.ai` subdomain (Cloudflare)
5. Daily heartbeat to stay active
6. Registration renews every 30 days

### TTLs

| Purpose | Duration |
|---------|----------|
| Registration | 30 days |
| Heartbeat | 24 hours |
| Stale threshold | 3 days |
| Grace period | 7 days |

### Federation Model

**Federated first, decentralized later.**

- **Now:** Central registry for discovery. We can revoke bad actors. Single point of failure acknowledged.
- **Next:** On-chain registry (Solana). Registry becomes a smart contract.
- **Eventually:** Mesh trust. Optical verification. No central authority.

The exit door is always open. Registry is open source. Nodes work locally without a subdomain.

---

## Database Architecture

### Current: Self-Hosted Postgres

All services share a Postgres instance on imajin-server (192.168.1.193:5432).

| Database | Used By |
|----------|---------|
| imajin_prod | www, auth, registry, pay, profile, events, chat, connections |
| imajin_dev | Same services (dev instances) |

ORM: Drizzle (`@imajin/db` package). Query monitoring: `pg_stat_statements`.

### Schema Principles

- Every table has `owner_did` — the DID that owns the record
- Every mutation is signed — the signature is stored alongside the data
- Soft deletes where possible — the chain doesn't forget
- No cross-service joins — services communicate via API, not shared tables

---

## Deployment

### Current Topology

```
┌──────────────────────────────────────────────────┐
│  imajin-server (192.168.1.193)                    │
│  HP ProLiant ML350p Gen8 · Ubuntu 24.04           │
│                                                    │
│  Caddy ─→ *.imajin.ai (auto-SSL)                  │
│    ├─→ :7000 www                                   │
│    ├─→ :7001 auth                                  │
│    ├─→ :7002 registry                              │
│    ├─→ :7003 connections                           │
│    ├─→ :7004 pay                                   │
│    ├─→ :7005 profile                               │
│    ├─→ :7006 events                                │
│    ├─→ :7007 chat                                  │
│                                                    │
│  Postgres 5432                                     │
│  pm2 (process management)                          │
│  GitHub Actions runner (self-hosted, org-level)    │
│                                                    │
│  Media: /mnt/media (3.4TB)                         │
└──────────────────────────────────────────────────┘
```

### Deploy Pipeline

- Push to `main` → GitHub Actions → auto-deploy to dev (ports 3xxx)
- Push `v*` tag → deploy to prod (ports 7xxx) — monorepo only
- Manual: `ssh → git pull → pnpm build → pm2 restart {service}`
- **Rule:** Never edit code on the server. Edit locally → push → pipeline deploys.

### Port Convention

- `3xxx` = dev, `7xxx` = prod (1:1 mapping)
- `x000-x099` = core platform services
- `x400+` = client applications

---

## The MJN Token

Reserved on Solana mainnet. Not active yet.

| Field | Value |
|-------|-------|
| Token Address | `12rXuUVzC71zoLrqVa3JYGRiXkKrezQLXB7gKkfq9AjK` |
| Network | Solana Mainnet |
| Supply | 0 (nothing minted) |
| Mint Authority | Ryan |
| Symbol | MJN |

**Roadmap:** Hardware first → utility → token (Year 3). The token represents participation, not speculation. Tokenomics TBD.

---

## What's Built vs. What's Planned

### ✅ Built and Live

- Auth (keypair, DID, sign/verify)
- Pay (Stripe integration, checkout, webhooks)
- Profile (identity display)
- Registry (node registration, heartbeat, lookup)
- Connections (trust graph basics)
- Events (creation, ticketing) — first ticket sold Feb 20, 2026
- Chat (signed messaging)
- www (essays, landing page)
- Full deploy pipeline (GitHub Actions → pm2)

### 🔴 Next

- .fair manifest implementation (RFC open: `rfc-01-fair-attribution.md`)
- Distribution contracts (`rfc-02-distribution-contracts.md`)
- Trust graph queries with inference fees
- Consumer profile model (toggle, receipt, two-stream validation)
- Node self-hosting package (RPi target)
- MJN protocol headers on HTTP exchanges
- Solana settlement backend

### 🔮 Future

- On-chain registry
- Mesh trust (no central authority)
- MJN token activation
- Learn platform (education)
- Headless platform APIs (the Save the Platforms thesis)

---

## Reference Documents

| Document | Location | Purpose |
|----------|----------|---------|
| MJN Whitepaper | `docs/mjn-whitepaper.md` | Full protocol specification |
| Identity Model | `docs/IDENTITY.md` | DID architecture details |
| Environments | `docs/ENVIRONMENTS.md` | Database branches, deployment config |
| .fair RFC | `articles/rfc-01-fair-attribution.md` | Attribution from commit history |
| Distribution RFC | `articles/rfc-02-distribution-contracts.md` | How money flows through chains |
| Thesis | `articles/THESIS.md` | Canonical concept definitions |
| Sequence | `articles/essay-00-sequence.md` | Essay order and structure |
| Timeline | `articles/essay-00-master-timeline.md` | Biographical chronology |

---

*This document is the technical source of truth. When the architecture evolves, update here first.*
