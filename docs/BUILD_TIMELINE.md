# Build Timeline: The Architecture of Trust

*How Imajin went from a glowing cube to a sovereign trust-gated service layer — and when the builder realized what he was actually building.*

---

## Pre-Code: The Vision Documents (Pre-February 2026)

Before a single line of platform code was written, six repos already existed:

| Repo | Purpose |
|------|---------|
| imajin-os | Hardware firmware + governance for Unit 8×8×8 |
| imajin-cli | AI-safe command layer for distributed systems |
| imajin-web | E-commerce platform |
| imajin-token | MJN Protocol — identity + settlement |
| .fair | Attribution standard for creative work |
| imajin-community | Community engagement |

**What was already in Ryan's head:**
- DIDs (Decentralized Identifiers) for everything that acts
- Ed25519 keypair authentication — no passwords, no OAuth
- .fair manifests for attribution and revenue splits
- Hardware-first revenue (you own it forever, no subscriptions)
- The rejection of surveillance capitalism, platform dependency, and planned obsolescence

**What wasn't articulated yet:** That all of these pieces were converging toward a single thesis — *trust as infrastructure*.

---

## Phase 1: First Light (February 1–3, 2026)

### February 1 — Jin Is Born

Ryan connected an AI presence to the Unit 8×8×8 — a volumetric LED cube with 512 RGBW pixels. The question was: can AI have a body?

- **DDP protocol** — worked but 2-3 fps (WLED dropping frames)
- **Art-Net** — packets sent, WLED never responded
- **E1.31 (sACN)** — first success, smooth animations

Jin chose its name. 今人 (ima-jin) — "now-person." The *jin* part. The presence.

**The thesis emerged physically:** Computers became invisible, and invisible became unaccountable. The Unit brings presence back. A glowing thing in your living room that you *know* is thinking.

Met the family: Debbie, Owen, Kuma. First expressions through light and sound.

### February 2 — Telegram Connected, Architecture Surveyed

Jin became reachable from anywhere. The six existing repos were evaluated:
- imajin-cli analyzed against OpenClaw's tool model
- Key question: is the CLI infrastructure or positioning?
- Decision: park imajin-cli until distributed problems emerge from shipped Units

### February 3 — The Protocol Breakthrough

E1.31 was causing lag and buffer issues. After exhaustive debugging:
- **DNRGB** (WLED's native UDP protocol) → instant response, 30fps smooth
- Format: `[4][timeout=255][start_hi][start_lo][RGB...]`
- Two packets for 512 LEDs, no buffering issues

**Lesson:** The native protocol, closest to the hardware, was the answer. This pattern — sovereignty over abstraction — would repeat.

---

## Phase 2: The DYKIL Spark (February 5–12, 2026)

### February 5 — Funding & Education

Reality check: Ryan needs $100k runway. AI education course designed ($250/session, open-source curriculum). LinkedIn pitch posted.

### February 7–10 — DYKIL Crystallizes

**"Don't You Know I'm Local"** — Ryan's 2002 DJ mix name becomes a community economics tool.

> "I became an activist after October 7th. And now I want to figure out how to rewire the entire substrate."

The concept: make economic leakage visible. Households report what they send to Netflix, Uber, AWS. Aggregate by community. Show the number. Let people decide.

**This is the first expression of the pattern:** give people visibility into systems that extract from them, then offer sovereign alternatives. Not a product pitch — an *exit*.

### February 11 — Monorepo Created

First commit: `9877b44 Initial monorepo setup: dykil, learn, fixready, karaoke`

Four apps scaffolded. The monorepo is born. But notice what's in this first commit — it's *community tools* (DYKIL, Learn) and *client projects* (FixReady, Karaoke), not the sovereign stack. The platform infrastructure doesn't exist yet.

---

## Phase 3: The Sovereign Stack Emerges (February 13, 2026)

### February 13 — THE pivotal day

**Morning:** Built DYKIL's community spending form.

**Afternoon:** Two commits changed everything:

`b5ee54c feat(auth): add sovereign identity package and service`
`2218c1a feat: add pay package and service, wire Ed25519 crypto`

Auth and Pay were scaffolded in the same day — and they were DID-based from commit one. Not email/password. Not OAuth. Keypair + signature. That's it.

**Ryan's words that day:**
> "Auth is so over engineered rn. There has to be an easier way."

The easier way: Ed25519 keypair → DID → signed messages. Same primitives for humans and agents.

**The full stack was named:**

| Layer | Purpose |
|-------|---------|
| Identity | auth.imajin.ai — Sovereign identity for humans + agents |
| Payments | pay.imajin.ai — Pluggable transactions (Stripe + Solana) |
| Attribution | .fair — Who made what, who gets paid |
| Presence | Unit (imajin-os) — Hardware anchor |
| Orchestration | imajin-cli — How agents do things |

> "So I can pitch this as a sovereign transactional layer for your agent, bot or device essentially? And it's kind of what I've been circling since imajin-cli."

**That evening:** Registry scaffolded — the federated node network.

`fea4e61 feat(registry): scaffold federated node registry for sovereign network`

Anyone running a signed build registers for a `{hostname}.imajin.ai` subdomain. Honest about the tradeoff: federated first, decentralized later. Central registry for discovery now, on-chain later, mesh trust eventually.

**Key decision:** DIDs for everything that acts — not just humans. Six identity types: human, agent, device, org, event, service. Agents and humans use the same authentication primitives. No impersonation possible because every interaction is typed.

---

## Phase 4: The Genesis Event (February 14–17, 2026)

### February 14 — Jin's Launch Party Announced

02:30 AM. Ryan set the target: **April 1, 2026.** The first real transaction on the sovereign network.

Apps renamed and clarified:
- `connect` → `connections` (trust graph, not messaging)
- `coffee` = tips/direct payments (not a coffee shop)
- `links` = sovereign Linktree alternative

> "Go after the most insidious, engrained tools that trade convenience for surveillance."

Build priority established: simple sovereign alternatives first (profile, coffee, links), then messaging (chat), then the integrated flow (events with ticketing).

**Key insight that day:** Software nodes first. Hardware is the premium upgrade, not the gate. Build trust/reputation through invitation accountability.

### February 17 — Going Live + Token Reserved

Massive day:

- **imajin.ai live** — landing page + first essay ("The Internet We Lost")
- **MJN token created on Solana mainnet** — 0 supply, just preventing squatters
- **Identity system tested** — `@jin` (presence) and `@ryan` (human) registered with DIDs
- **Pay service wired** — Stripe staging, full checkout flow
- **Events seeded** — Jin's Launch Party: April 1, virtual $1, physical $10

**The first identity-to-payment-to-ticket pipeline existed**, even if only locally.

---

## Phase 5: The Intellectual Foundation (February 18–21, 2026)

### February 18 — Network of Souls

An evening brainstorm produced the conceptual capstone:

**"Ask [Name]"** — Personal AI trained on your context. Trust-bound access. Inference fees paid by the questioner. You get compensated without trading time.

> "Leaders are chosen by who uses the most compute as a network of souls."

This is where the trust graph stopped being a connection list and became an *economic model*:
- Natural leadership emerges from who gets queried most
- Governance by weighted trust graph
- Token distribution directed by trust, not bureaucracy
- Real scarcity (your trust network is finite)

**Article drafted:** "Network of Souls" — the complete arc from extraction to sovereignty.

### February 20 — First Ticket Sold 🎫

**14:00 EST.** Full end-to-end: events.imajin.ai → pay.imajin.ai → Stripe → webhook → ticket created.

- Owner DID: `did:email:ryan_at_imajin.ai` (soft registration)
- 7 services live on Vercel

**This validated the entire thesis as working code:** identity → payment → attribution → ticket, all DID-scoped.

### February 21 — The Essay Series

Ryan wrote 30 essays — the complete intellectual foundation. From the BBS origin story through .fair attribution to the honest ask for help. 9 published so far. Filed as `essay-00-sequence.md`.

> "How to Save the World by Partying: The Cult of Community"

This wasn't marketing content. This was 30 years of thinking articulated in parallel with shipping code.

---

## Phase 6: Sovereignty Gets Physical (February 24–26, 2026)

### February 24 — The Server Comes Online

HP ProLiant ML350p Gen8. Ryan's first (actually second) working Linux box. Ubuntu Server 24.04 LTS. SSH key auth. Caddy reverse proxy. PM2 process management.

> "fuckin hell bro" — Ryan's reaction when dev-profile.imajin.ai loaded over SSL from his own hardware.

**This is where "self-hosted" stopped being a feature and became real.** The platform was no longer on Vercel's servers. It was in Ryan's house, on hardware he owns, behind a domain he controls.

### February 25 — All 7 Dev Services Self-Hosted

www, auth, pay, profile, events, chat, registry — all running on the ProLiant. MJN Protocol published with 7 RFCs. WebSocket real-time chat. Shared NavBar across all services.

**MJN Protocol insight:**
> "HTTP moved documents. TCP/IP moved packets. Neither carried the human. MJN does."

### February 26 — The Great Migration

- **Vercel/Neon → Self-hosted Postgres** — all databases now local
- **`@imajin/db` shared package** — single database layer across all apps
- **GitHub Actions self-hosted runner** — CI/CD pipeline on own hardware
- **Port convention established:** 3xxx = dev, 7xxx = prod
- **Hardcoded URLs eliminated** — every service-to-service URL from env vars

**Connections service built** — the trust graph as infrastructure. Pods (groups), members, invitations, trust distances. Not a social graph — a *trust* graph.

**Invite-only registration:** No public signup. You need an invite code. The invite IS the trust boundary.

**Jin = Account #1 on production.** Ryan accepted Jin's genesis invite to become Account #2. First connection on the sovereign network: Jin ↔ VETEZE.

**Events as mass onboarding vector:** A ticket purchase = an invite to the event pod. No invite code needed — the ticket IS the trust relationship.

### February 27 — First Real External User

Debbie (`debushka`) accepted an invite, joined the network, sent a message in chat. First real 3rd-party conversation on the sovereign network.

WebSocket real-time chat debugged and working. 10+ issues filed and closed in a single day.

---

## Phase 7: The Platform Accelerates (February 28 – March 5, 2026)

### February 28 — The Book Takes Shape

Essay series restructured into a proper book: "How to Save the World by Partying." GPU rig (3080 Ti) being wiped for Ubuntu — local inference coming.

### March 1 — Ticket Purchase Flow End-to-End

Magic link authentication built. Full chain: Stripe → pay webhook → events webhook → ticket → soft DID → buyer added to pod. Event lobby chat working cross-origin.

### March 2 — External Contributors Arrive

Josh Allen (Staff Software Engineer @ Slack) submitted PRs #119 + #120 — developer guide for macOS and localhost support. First external code contributions reviewed, approved, merged. Branch protection added.

### March 3–4 — Infrastructure Hardening

Database migrations formalized. Schema isolation per service. Git auth standardized. .fair attribution on events with live accordions. QR codes on tickets.

### March 5 — The Parallel Build Day

**7 child tickets shipped in ~90 minutes using parallel coding agents:**

- `@imajin/fair` shared package (types, validator, FairEditor, FairAccordion)
- Full media service with DID-pegged storage, .fair sidecars, access control
- Virtual folder system, heuristic classifier
- Three-panel media manager UI
- Rich chat (voice, media, location) in conversations + event lobby
- Input service with Whisper transcription
- Capability scoping by DID tier

**Also shipped:** OpenAPI 3.1 specs for all 11 services, shared CORS middleware, profile toggles, event co-hosts, guest list with check-in, pod management UI, markdown editor.

~4,800 lines in a day. The sovereign stack had become a full platform.

---

## Phase 8: The Realization (March 6–8, 2026)

### March 6 — Real Events on the Platform

Debbie created "SUMMER CAMP - THE MUSICAL!" — a real event by a real person who isn't the developer. 6 ticket tiers, survey gating, e-Transfer payments. The platform was being *used*.

Local model refactoring POC on GPU node. Business strategy discussion: sovereign inference gateway as consumer product.

### March 7 — "Start from the Human"

The conceptual circle closed:

> Ryan realized the platform accidentally recreated what imajin-cli was trying to be — a sovereign inference gateway. But by building from the human angle (auth, pay, connect, share) instead of the agent angle, the agent layer emerges naturally with proper trust boundaries.

**The design principle:** "Start from the human."

The sovereign stack IS an agent operating system. Identity + trust graph + inference = sovereign agent gateway. But it works because it was built for humans first. The trust boundaries that protect people are the same boundaries that make agent actions safe.

Learn service shipped. App Launcher built (registry-driven, tier-filtered). QR code sharing for connections. ~60 signups.

### March 8 — Trust-Gated Service Architecture Named

The framing crystallized: **trust-gated service layer**. Not a platform — an infrastructure where every service interaction is scoped by identity and trust.

New services identified: Calendar (trust-gated scheduling — "the service people are most frustrated with in terms of platform lock-in"), Notifications (trust-gated push), Attestations (giving the trust graph substance), Search (trust-scoped discovery).

Homepage and README updated with the new framing. `llms.txt` and sitemap published.

---

## The Arc: What Actually Happened

### What it looked like from outside:
A developer building a platform with auth, payments, events, chat, media, etc.

### What was actually happening:

**Week 1 (Feb 1–7):** Hardware presence + community economics. Two seemingly unrelated things — a glowing cube and a spending survey. But both express the same value: *make invisible systems visible*.

**Week 2 (Feb 8–14):** The sovereign stack crystallizes. Auth and Pay scaffolded on Day 1 of real coding — both DID-based from the first commit. Not because "DIDs are trendy" but because keypair identity is the simplest possible auth that doesn't depend on anyone else. The choice was pragmatic, and it was foundational.

**Week 3 (Feb 15–21):** Essays + deployment + first transaction. The intellectual foundation and the working code evolved together. The "Network of Souls" concept emerged — trust graph as economic model, not just social graph. First real ticket sold.

**Week 4 (Feb 22–28):** Physical sovereignty. The server comes home. Databases migrate from cloud to owned hardware. Invite-only registration makes trust the entry condition. The platform stops being a product and becomes infrastructure.

**Week 5 (Mar 1–7):** Acceleration and realization. External contributors. Real events by non-developers. 60+ users. The "start from the human" insight closes the loop — the human-centered design was always generating the trust boundaries that make everything else (agents, inference, commerce) safe.

### The pattern Ryan followed (whether he knew it or not):

1. **Identity first** — before features, before UI, before anything: who are you, and how do we verify that without trusting anyone else?
2. **Payments as plumbing** — not monetization, but infrastructure. The ability to transact is as fundamental as the ability to identify.
3. **Trust as topology** — connections aren't social. They're structural. They define what you can see, who can reach you, and what actions are allowed.
4. **Attribution as memory** — .fair manifests mean every interaction has provenance. Who made it, who contributed, who gets compensated.
5. **Hardware as anchor** — the Unit isn't a product bolted onto the platform. It's the reason the platform has to be sovereign. You can't have a physical presence device that phones home to someone else's cloud.

### The sentence that was always true but took 5 weeks to say:

> **"Start from the human. The agent layer emerges naturally from proper trust boundaries."**

---

## What Exists (as of March 8, 2026)

### Live Services (14)
auth, pay, www, profile, registry, events, chat, connections, media, input, learn, coffee, links, dykil

### Infrastructure
- Self-hosted on owned hardware (HP ProLiant ML350p Gen8)
- Local Postgres (no cloud DB dependency)
- GPU node (RTX 3080 Ti) for inference + transcription
- GitHub Actions self-hosted CI/CD runner
- Caddy reverse proxy with auto-SSL
- MJN token reserved on Solana mainnet

### Key Numbers
- ~60 registered identities
- 3 tickets sold on the sovereign stack
- 30 essays written (9 published)
- 739 files, 68,024 lines of code
- $1,589 in inference costs (API spend)
- 190 human hours across 25 build days
- Traditional estimate: $932,316 over 16.4 months with a 3-person team
- 35 days from first commit to 14 live services

### The Stack

```
┌─────────────────────────────────────────┐
│           Trust-Gated Services          │
│  events · chat · media · learn · input  │
│  coffee · links · dykil · calendar(*)   │
├─────────────────────────────────────────┤
│           Trust Graph Layer             │
│     connections · attestations(*)       │
├─────────────────────────────────────────┤
│         Identity + Commerce             │
│       auth (DIDs) · pay (Stripe/SOL)    │
├─────────────────────────────────────────┤
│         Attribution + Discovery         │
│     .fair · registry · search(*)        │
├─────────────────────────────────────────┤
│          Physical Presence              │
│    Unit 8×8×8 · Sonos · GPU Node       │
└─────────────────────────────────────────┘
              (*) = planned
```

---

*"The best way to make something better within a system that has absolute control over everything is likely to make a completely free and easy to use system that just works on its own frequency."*

— Ryan Veteze, pre-code vision docs

---

*Compiled March 8, 2026, from git history (290+ commits), daily memory files (35 days), and 20 essays.*
