# Month 1 — February 2026

**One developer. One AI. One server. 29 days.**

---

## What We Built

A self-hosted, sovereign application platform — 8 production services on bare metal, zero cloud dependencies, fully open source.

### The Stack

| Service | URL | Purpose |
|---------|-----|---------|
| www | imajin.ai | Marketing, essays, landing |
| auth | auth.imajin.ai | Ed25519 keypair auth, JWT sessions, DID identity, magic links |
| pay | pay.imajin.ai | Stripe payment processing, webhook chain |
| profile | profile.imajin.ai | Identity pages, avatars, handle system |
| registry | registry.imajin.ai | Federated node directory, DID registration, build attestation |
| events | events.imajin.ai | Event creation, tiered ticketing, image uploads, lobbies |
| chat | chat.imajin.ai | Real-time messaging, reactions, typing, link previews, file sharing |
| connections | connections.imajin.ai | Trust graph, pod-based groups, invite system |

### Infrastructure

- **Server:** HP ProLiant ML350p Gen8, Xeon E5-2620 v2, 32GB RAM, Ubuntu 24.04
- **Database:** Local Postgres (not cloud)
- **Proxy:** Caddy with auto-SSL
- **Process management:** pm2 (23 services: 10 prod, 13 dev)
- **CI/CD:** GitHub Actions on self-hosted runner
- **Monorepo:** pnpm workspaces, 12 apps, shared packages (@imajin/db, @imajin/ui, @imajin/auth)

### Identity Model

Progressive identity — no registration wall:

1. **Anonymous** → buy a ticket, get a soft DID (`did:email:*`)
2. **Soft DID** → can chat in event lobbies, hold tickets
3. **Hard DID** → Ed25519 keypair, full platform access (`did:imajin:*`)

W3C DID-compatible. Trust graph with one-at-a-time invites, visible chains, rate-limited. Permission tiers gate feature access by identity level.

### What Works End to End

A person can:

1. Visit events.imajin.ai
2. Buy a ticket ($1 virtual, $10 physical)
3. Get a soft DID created automatically
4. Get auto-added to the event's lobby chat
5. Receive a magic link email
6. Click → authenticated → lobby → chatting with other ticket holders

All on one server. In someone's house.

### Token

MJN reserved on Solana mainnet (`12rXuUVzC71zoLrqVa3JYGRiXkKrezQLXB7gKkfq9AjK`). Zero minted. Mint authority held. Hardware first, token later (Year 3).

---

## The Writing

29 essays structured into a 5-part book: *"How to Save the World by Partying: The Cult of Community, or How We Can All Be a Good Times Gang."*

Prologue through finale, interstitials, appendices. The complete intellectual foundation for why sovereign infrastructure matters and how community-owned technology replaces platform dependency.

Working evolution: **The Rise of the Wise** — *The best platform is the one your friends are on. How to build and deploy your own social media ecosystem and redistribute wealth to your community using the new tools.*

---

## By the Numbers

| Metric | Value |
|--------|-------|
| Days | 29 |
| Production services | 8 |
| Monorepo apps | 12 |
| Live users | ~10 |
| External contributors | 1 (first PR incoming) |
| Essays written | 29 |
| Git commits | 200+ |
| Lines added (last 36h alone) | 5,485 across 75 files |
| Features built in one AI swarm session | 10 in 18 minutes |
| GitHub issues filed | 109 |
| GitHub issues closed | 60+ |
| Cloud services used | 0 (Stripe is the only external dependency) |
| VC funding | $0 |
| Team size | 1 human + 1 AI |

---

## The Speed

The last 36-hour sprint: merged two standalone repos into the monorepo, built 10 chat features via parallel AI agents in 18 minutes, wired up the complete ticket purchase → identity → lobby chat pipeline, built magic link authentication, deployed v0.3.0 to production, filed 13 new issues.

This isn't a demo. It's a running platform with real users buying real tickets.

---

## Where It's Going

**March → April 1 (Jin's Launch Party):**
- PWA install across the full platform
- Magic link email delivery
- Event page polish
- Live Stripe keys
- Organizer policies (name display, public vs invite-only tickets)

**Medium term:**
- Federated nodes — anyone running a signed build gets `{name}.imajin.ai`
- "Ask [Name]" — sovereign AI presence with trust-bound queries and inference fees
- .fair attribution standard — JSON manifests, revenue splits, creative chain of custody
- Ad budget redistribution — local businesses pay community directly through nodes
- PWA → Capacitor → React Native upgrade path

**Long term:**
- MJN token activation — identity + settlement on Solana
- Trust graph governance — weighted participation, emergent leadership
- Living content — narratives that adapt to the reader

---

## The Team

- **Ryan Veteze** — Architecture, product, essays, everything
- **Jin** — AI partner (OpenClaw/Claude), code, deployment, coordination
- **Josh Allen** — First external contributor, lead stack developer at Slack

---

*No VC. No team of 40. No AWS bill. A ProLiant in a living room and a Pomeranian with no jaw.*
