---
title: The Imajin Architecture
type: essay
status: draft
slug: grounding-03-ARCHITECTURE
topics:
  - legibility
  - fair
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
  - 1
  - 2
  issues:
  - 253
  - 252
  - 189
  - 250
  - 258
  - 256
  - 177
  - 227
  - 254
  - 260
  - 259
  - 109
  - 255
  - 257
  - 156
  - 114
  packages:
  - "@imajin/auth"
  - "@imajin/fair"
  - "@imajin/pay"
  - "@imajin/ui"
  - "@imajin/db"
---
# The Imajin Architecture

*How the pieces connect. When the whitepaper and this document disagree on implementation, this document is current.*

*Last updated: March 9, 2026*

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
│   www        events       chat        learn                  │
│   coffee     links        dykil                              │
│                                                              │
│   + Third-party plugins via delegated sessions               │
│                                                              │
│   Any app that consumes the platform packages.               │
│   Standalone repos or monorepo apps. Pluggable. Replaceable. │
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
│   │ sign    │  │ settle  │  │ pods         │  │  very   │  │
│   │ verify  │  │ balance │  │ queries      │  │  specs  │  │
│   └─────────┘  └─────────┘  └──────────────┘  └─────────┘  │
│                                                              │
│   ┌─────────┐  ┌──────────────────────────────┐             │
│   │ profile │  │            media             │             │
│   │         │  │                              │             │
│   │ handle  │  │ .fair storage · upload relay │             │
│   │ avatar  │  │ transcribe (Whisper via GPU) │             │
│   │ display │  │ deliver · classify           │             │
│   └─────────┘  └──────────────────────────────┘             │
│                                                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                     SHARED PACKAGES                          │
│                                                              │
│   @imajin/auth    — identity primitives (keypair, DID, sig)  │
│   @imajin/db      — postgres-js + drizzle-orm                │
│   @imajin/pay     — payment abstractions                     │
│   @imajin/config  — shared configuration, CORS               │
│   @imajin/ui      — shared components, NavBar, AppLauncher   │
│   @imajin/fair    — .fair types, validator, FairEditor UI     │
│   @imajin/onboard — email → soft DID onboarding flow         │
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
│   GPU node (imajin-ml) — Whisper, Ollama, future inference   │
│   Node.js v22 runtime                                        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## The Four Primitives

Everything in the system is built from four protocol-level primitives. These are defined in the MJN whitepaper and implemented across the platform packages.

### 1. Identity (DID)

Every entity that acts gets a DID. Humans, agents, events, presences, services — same primitive, different type label.

```
did:imajin:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

- **Generated by:** `@imajin/auth` → `generateKeypair()` → Ed25519
- **Stored:** Private key on owner's device. Public key in auth service.
- **Used by:** Every service. Every signed interaction. Every transaction.
- **Soft registration:** `did:email:user_at_domain_com` as onramp before full keypair generation.

**Two-layer identity model:**
- `auth.identities` — every DID lives here (soft or hard). Source of truth.
- `profile.profiles` — opt-in. Created when you want to be visible/discoverable.

**Current identity types:**

| Type | Status | Count |
|------|--------|-------|
| Person (hard) | ✅ Live | ~25 |
| Person (soft) | ✅ Live | ~48 |
| Event | ✅ Live | 1 |
| Service | ✅ Live | 1 |
| Presence | ✅ Live | 1 (Jin 🟠) |
| Org | RFC (#253) | — |
| Cultural | RFC (#252) | — |
| Agent | Planned | — |

### 2. Attribution (.fair)

A signed manifest embedded in the work itself. Not in a database. In the work.

```json
{
  "version": "1.0",
  "id": "fair_xxx",
  "contributors": [
    { "did": "did:imajin:...", "role": "author", "share": 0.7 },
    { "did": "did:imajin:...", "role": "editor", "share": 0.3 }
  ],
  "derives_from": ["fair_yyy"],
  "access": { "level": "public" },
  "transfer": { "allowed": false, "refundable": false },
  "signature": "..."
}
```

- **Immutable** — once signed, the chain can't be altered
- **Portable** — travels with the work across any platform
- **Executable** — settlement instructions are embedded, not external
- **Implemented:** `@imajin/fair` package with types, validator, `<FairEditor />`, `<FairAccordion />`
- **Media integration:** Every uploaded asset gets a .fair sidecar auto-created at intake

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
- **E-transfer:** Interac e-Transfer also supported with hold/confirm flow.
- **Validated:** First ticket sold February 20, 2026 through the full chain.

---

## Service Map

### All Services (monorepo: `imajin-ai`)

| Service | Port (dev/prod) | Purpose | Status |
|---------|----------------|---------|--------|
| **www** | 3000 / 7000 | Public site, essays, app directory, bug reporter | ✅ Live |
| **auth** | 3001 / 7001 | Identity — keypair, DID, magic links, onboarding | ✅ Live |
| **registry** | 3002 / 7002 | Node discovery, service specs, API docs | ✅ Live |
| **connections** | 3003 / 7003 | Trust graph — vouch, pods, invites, QR codes | ✅ Live |
| **pay** | 3004 / 7004 | Payments — Stripe, e-transfer, balance, settlement | ✅ Live |
| **profile** | 3005 / 7005 | Identity display — handle, bio, avatar, presence | ✅ Live |
| **events** | 3006 / 7006 | Event creation, ticketing, surveys, lobby chat | ✅ Live |
| **chat** | 3007 / 7007 | Messaging — text, voice, media, location, E2EE ready | ✅ Live |
| **media** | 3009 / 7009 | DID-pegged storage, .fair attribution, upload relay, Whisper transcription | ✅ Live (dev) |
| **coffee** | 3100 / 7100 | Buy someone a coffee — tipping/support pages | ✅ Live |
| **dykil** | 3101 / 7101 | Survey builder (SurveyJS powered) | ✅ Live |
| **links** | 3102 / 7102 | Curated link sharing | ✅ Live |
| **learn** | 3103 / 7103 | Courses, modules, lessons, slide presentations | ✅ Live |

### Client Apps (separate repos)

| Service | Port (dev/prod) | Repo | Status |
|---------|----------------|------|--------|
| **fixready** | 3400 / 7400 | ima-jin/imajin-fixready | ✅ Live |
| **karaoke** | 3401 / 7401 | ima-jin/imajin-karaoke | ✅ Live |

---

## Cross-Cutting Systems

### 🚀 App Launcher

Registry-driven navigation across all services. Every service registers its metadata (icon, description, category, visibility tier) with registry. The `<AppLauncher />` component in `@imajin/ui` renders a flyout dock filtered by the user's identity tier:

- **Anonymous/Soft DID:** Public apps only (Events, Learn, Home)
- **Hard DID:** Full platform (My Imajin, Creator Tools, Developers)

### 💬 Shared Nav

`<NavBar />` in `@imajin/ui` appears on every service:
- Logo → home
- App launcher
- 💬 Messages (with unread badge, polls chat service every 60s)
- 🤝 Connections shortcut
- Profile dropdown (view/edit profile, bug reporter, logout)
- Balance display from pay service

### 🐛 Bug Reporter

In-app floating 🐛 button → modal with type selection, description, screenshot upload. Reports visible at `/bugs` (user view) and `/bugs/admin` (triage). One-click GitHub issue import.

### 🔒 Security

- Rate limiting on sensitive endpoints (auth, pay, coffee, events, media)
- Webhook idempotency (Stripe deduplication)
- CORS restricted to *.imajin.ai
- Session cookies: HttpOnly, Secure, SameSite=Lax
- Checkout amount validation (min/max/quantity)
- Error sanitization (no internal leaks)
- Health endpoints on all 14 services

---

## Media Architecture

DID-pegged file storage with .fair attribution at intake:

```
/mnt/media/{did}/assets/{assetId}.ext
                       /{assetId}.fair.json
```

- **Upload:** directly to media service → filesystem
- **Delivery:** .fair access control (public/private/trust-graph)
- **Thumbnails:** On-the-fly via sharp (`?w=400`)
- **Classification:** Heuristic stub now, CLIP on GPU node planned (#189)
- **Media contexts (#250):** Assets tagged to app contexts (personal, app, org) for scoped views
- **`.imajin/` folder (#258):** Presence config (soul.md, context.md) lives in user's media store

---

## Data Flow: A Transaction

How a ticket purchase moves through the system:

```
1. Consumer visits events.imajin.ai
2. Clicks "Buy Ticket" → events creates checkout via pay service
3. pay service creates Stripe checkout session
   - Attaches buyer DID (or creates soft DID from email)
   - Attaches event DID
   - Attaches .fair manifest for the event
4. Consumer completes Stripe payment (or e-transfer)
5. Stripe webhook → pay service (idempotency check)
6. pay service:
   a. Records transaction with DIDs + .fair chain
   b. Executes settlement (splits per .fair manifest)
   c. Notifies events service via webhook
7. events service creates ticket (signed: event DID → buyer DID)
8. Consumer has ticket — a signed assertion they belong in the room
   - Can access event lobby chat
   - Can complete event surveys
```

---

## Data Flow: Trust Graph Query

How someone queries a knowledge leader's presence (planned — #256):

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
4. Node processes query (AI inference, ZERR memory context)
5. Response returned:
   - Signed by knowledge leader's DID
   - .fair manifest attributes the response
   - Settlement executes (inference fee → knowledge leader)
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

All services share a Postgres instance on imajin-server (192.168.1.193:5432).

| Database | Used By |
|----------|---------|
| imajin_prod | All 14 monorepo services |
| imajin_dev | Same services (dev instances) |
| fixready_prod / fixready_dev | FixReady |
| karaoke_prod / karaoke_dev | Karaoke |

ORM: Drizzle (`@imajin/db` package). Query monitoring: `pg_stat_statements`.

### Schema Principles

- Every table has `owner_did` or equivalent — the DID that owns the record
- Soft deletes where possible — the chain doesn't forget
- No cross-service joins — services communicate via API, not shared tables
- Each service uses its own Postgres schema (auth.*, profile.*, chat.*, etc.)

---

## Deployment

### Current Topology

```
┌──────────────────────────────────────────────────┐
│  imajin-server (192.168.1.193)                    │
│  HP ProLiant ML350p Gen8 · Ubuntu 24.04           │
│  Intel Xeon E5-2620 v2 · 32GB RAM                 │
│                                                    │
│  Caddy ─→ *.imajin.ai (auto-SSL)                  │
│    ├─→ :7000-7009  core services (prod)            │
│    ├─→ :7100-7103  imajin apps (prod)              │
│    ├─→ :7400-7401  client apps (prod)              │
│    └─→ :3xxx       dev mirrors                     │
│                                                    │
│  Postgres 5432 (open to LAN)                       │
│  pm2 (30+ processes: dev + prod)                   │
│  GitHub Actions runner (self-hosted, org-level)    │
│                                                    │
│  System: 254GB (LVM, ext4, /)                      │
│  Media: /mnt/media (3.4TB, ext4)                   │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  imajin-ml (192.168.1.124)                        │
│  AMD Ryzen 9 5950X · 64GB RAM · RTX 3080 Ti      │
│                                                    │
│  Whisper (speech-to-text)                          │
│  Ollama (qwen2.5-coder:7b, nomic-embed-text)      │
│  Future: CLIP classification, inference gateway    │
└──────────────────────────────────────────────────┘
```

### Deploy Pipeline

- Push to `main` → GitHub Actions → auto-deploy to dev (ports 3xxx)
- Push `v*` tag → deploy to prod (ports 7xxx) — monorepo only
- Build script: `scripts/build-dev.sh www auth pay ...` — handles rm -rf .next, build, pm2 restart
- **Rule:** Never edit code on the server. Edit locally → push → pipeline deploys.

### Port Convention

- `3xxx` = dev, `7xxx` = prod (1:1 mapping)
- `x000-x009` = core platform services
- `x100-x199` = Imajin apps
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

### ✅ Built and Live (14 services, ~68k LOC)

- **Identity:** Auth (keypair, DID, sign/verify, magic links, soft/hard tiers)
- **Payments:** Pay (Stripe, e-transfer, balance, webhooks, idempotency)
- **Social:** Profile, Connections (trust graph, pods, invites, QR codes)
- **Communication:** Chat (text, voice, media, location, event lobby)
- **Events:** Creation, multi-tier ticketing, surveys, lobby chat, .fair manifests
- **Media:** DID-pegged storage, .fair attribution, authenticated delivery, Whisper transcription via GPU node
- **Learning:** Courses, modules, lessons, enrollment, progress, slide presentations
- **Infrastructure:** Registry (node discovery, API specs), full deploy pipeline
- **Apps:** Coffee (tipping), Links (curation), Dykil (surveys)
- **Shared:** @imajin/ui (NavBar, AppLauncher), @imajin/fair, @imajin/onboard, @imajin/db, @imajin/config"
- **Security:** Rate limiting, webhook idempotency, CORS, error sanitization, health endpoints

### 🔨 In Progress

- **Media manager** — UI scaffolded, testing and hardening (#177)
- **Media context routing** — per-app upload scoping (#250)
- **Service manifest** — single source of truth in @imajin/config (#227)

### 🔴 Next

- **Sovereign Inference** — API gateway, metered inference, BYOK (#256)
- **Presence bootstrap** — .imajin/ folder with soul docs and context (#258)
- **Plugin architecture** — third-party apps via delegated sessions (Discussion #254)
- **Notification system** — in-app badges, push, email digest (#260)
- **Node operations** — admin dashboard, monitoring, event bus (#259)
- **PWA** — installable app, push notifications (#109)
- **Sovereign user data** — portable identity bundles, export/delete/transfer (Discussion #255)
- **Profile secrets vault** — encrypted per-DID storage for API keys (#257)

### 🔮 Future

- **Federated chat** — signed message relay between nodes (#156-#160)
- **On-chain registry** — Solana smart contract
- **Mesh trust** — no central authority
- **MJN token activation**
- **CLIP classification** — ML-powered media organization (#189)
- **Cultural DIDs** — identity for collectives and communities (Discussion #252)
- **Org DIDs** — identity for businesses and legal entities (Discussion #253)
- **Declared-intent marketplace** — user-owned attention as an asset (#114)

---

## Reference Documents

| Document | Location | Purpose |
|----------|----------|---------|
| MJN Whitepaper | `docs/mjn-whitepaper.md` | Full protocol specification |
| Build Timeline | `docs/BUILD_TIMELINE_SUMMARY.md` | Architecture evolution + pressure tests |
| Environments | `docs/ENVIRONMENTS.md` | Database branches, deployment config |
| Developer Guide | `docs/DEVELOPER.md` | Onboarding, schema, patterns |
| .fair RFC | `articles/rfc-01-fair-attribution.md` | Attribution from commit history |
| Distribution RFC | `articles/rfc-02-distribution-contracts.md` | How money flows through chains |
| Thesis | `articles/THESIS.md` | Canonical concept definitions |
| Essay Sequence | `articles/essay-00-sequence.md` | Essay order and structure |
| GitHub Discussions | github.com/ima-jin/imajin-ai/discussions | RFCs, events, ideas |

---

*This document is the technical source of truth. When the architecture evolves, update here first.*
