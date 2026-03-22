# Build Timeline: The Architecture of Trust

*How Imajin went from a glowing cube to a sovereign protocol — and when the builder realized what he was actually building.*

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

## Phase 9: The Convergence (March 9, 2026)

### March 9 — The Protocol Discovers Itself

Two realizations on the same day. The first came from Greg Mulholland's pressure testing:

**Typed Identity Primitives:** The flat "DID" concept in the whitepaper became four first-class primitive types — Individual, Family, Cultural, Org. Greg's key insight: "The cultural DID is actually the main point to restructure backwards from." Ryan's response: "When you query the graph from the POV of the primitives at the center — Individual, Family, Culture, Org — it helps shape the outputs."

The same trust graph, queried from different primitive types, yields fundamentally different shapes. This isn't a feature — it's the architecture. Whitepaper bumped to v0.2.

**The Wallet Discovery:** That evening, Ryan asked: "What if the app was also a wallet app?"

The answer stopped the conversation: **every Imajin DID keypair is already a valid Solana wallet.**

Ed25519 was chosen on Day 3 for identity — because it was the right cryptographic primitive for sovereign keypairs. Solana uses Ed25519 for wallet addresses. These were not coordinated decisions. The choice was made for identity, not settlement. But because both were solving for the same mathematical truth, every registered user — every DID, every backup file — was already a wallet. Nobody planned it. 37 days of building from the right principles, and the settlement layer was waiting inside the identity layer the whole time.

**What followed in the same session:**
- **MJN-scoped only** — the wallet transacts MJN tokens, nothing else. Blast radius structurally contained.
- **Hierarchical key derivation** — child keys for spending, savings, delegation, app sessions. Each revocable by the master.
- **Per-primitive wallet governance** — Individual wallets are simple. Family wallets are multi-sig. Cultural wallets require quorum. Org wallets have delegation hierarchy.
- **Token economics model** — reserve-backed utility token. Dual-currency (fiat + MJN). Mint on deposit, burn on withdrawal. Start at fixed rate, evolve to managed float.
- **Foundation clearinghouse** — the MJN Foundation holds fiat reserves, mints/burns, publishes rates. Not a bank — a protocol clearinghouse.

Three RFCs created in one session: Whitepaper v0.2, Embedded Wallet (Discussion #268), Token Economics (Discussion #269).

### The sentence that was always true but took 37 days to say:

> **"Start from the human and you will find the protocol."**

The agent layer emerged from trust boundaries. The settlement layer emerged from identity primitives. The token economics emerged from the settlement layer. Each layer was discovered, not designed — excavated from the git history by building from the right principles.

The build timeline isn't a changelog. It's the protocol's provenance.

---

## What Exists (as of March 9, 2026)

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
- ~73 registered identities (~25 hard DIDs, ~48 soft DIDs)
- 3 tickets sold on the sovereign stack
- 30 essays written (9 published)
- 14 live services, 68,000+ lines of code
- $1,589 in inference costs (API spend)
- 190+ human hours across 37 build days
- Traditional estimate: $932,316 over 16.4 months with a 3-person team
- 37 days from first commit to protocol convergence
- Every registered user is already a Solana wallet holder (they just don't know it yet)

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

## Phase 10: The Platform Meets Reality (March 10–14, 2026)

### March 10 — Evening Hardening Sprint

The platform was live, but it wasn't *reliable*. Ryan's evening hardening sprint addressed the gap between "working demo" and "production system":

- Coffee payments routed through pay service (#154) — eliminating one-off payment flows
- 6 bug fixes shipped in rapid succession — media upload 404s, chat presence issues, stale CSS, null data crashes
- build.sh pre-flight env check added — dev environment validation before deployment
- Session cookie environment isolation — no more dev/prod cookie conflicts

The pitch deck loaded into Learn service: 25 slides mapping the complete vision. Revenue dependency chain documented. This wasn't feature work — it was foundation work. The difference between something that functions and something that *works*.

### March 11 — Chat Becomes a Primitive

Issue #278: "@imajin/chat as Universal Chat Consumer." Six phases, six PRs, two hours. Every conversation became a DID.

**Architecture shift:** DID as conversation primary key, deterministic DM DIDs (SHA-256 of sorted participant DIDs), auto-create on first message. WebSocket replaced 3-second polling. The old pod-based chat routing died — 556 lines removed.

`<Chat did="..." />` — a drop-in component. Any service could embed chat by passing a DID. Auth service became the single access control authority. Chat stopped being a service feature and became infrastructure.

**The deeper pattern:** Conversations aren't features of services. They're entities with identity. A DM between two humans has the same cryptographic primitives as a group chat or an agent conversation. `did:imajin:event:summer-camp`, `did:imajin:dm:a3f7b2c1`, `did:imajin:group:1fcab1a9` — all first-class citizens in the identity layer.

### March 12 — Chat Architecture Refined

Group membership via pods — the right approach after reverting the wrong approach (a `conversation_members_v2` table that duplicated what pods already did). The answer: membership lives in connections, communication lives in chat, pods bridge the two.

DID name resolution via `useDidNames` hook. WebSocket deferred auth (browsers don't send cookies on WS upgrade — so connect unauthenticated, fetch a short-lived token via same-origin XHR, authenticate over the wire). Real-time broadcast for deletes, reactions, edits.

### March 13 — Attestation Infrastructure Goes Live

**The day the trust graph gained substance.**

Three sovereignty roadmaps written in parallel: .fair, Identity, Settlement. All three converged on a single keystone — #316, auth signing utilities:

```
                    #316: @imajin/auth signing
                   /           |            \
      .fair Phase 1    Identity Phase 1    Settlement Phase 1
     (sign manifests)  (attestations)     (verify at settle)
```

Fee model designed: 0.75% total (0.25% protocol + 0.25% host + 0.25% dev), dev fee CAPS at $100/DID — once you've contributed, it drops to zero. Not extractive. Temporary. Micro-investment in a 10% Supporter Pool equity stake.

**Then all three Phase 0s shipped the same evening.** Identity tier model (soft/preliminary/established), .fair signature fields and templates, settlement chain math with platform fee calculation. The keystone turned out to already be 80% built in `packages/auth/` — just not exported.

**Attestation infrastructure LIVE:** Six types operational — `transaction.settled`, `customer`, `connection.invited`, `connection.accepted`, `vouch`, `session.created`. Settlement Phase 1 complete: cryptographic .fair signature verification at settlement time. Connection attestations wired (invited, accepted, vouch). Login attestations carrying auth strength metadata.

**The AttMart crystallized** that same evening. "The Attention Marketplace" — invert the ad industry. You're the vendor, not the product. Businesses query the attestation graph to find interested people, pay MJN per result, DID owners get micro-payments for their attention. No data leaves your node.

Academic validation arrived from Springer (2025): "The attention market — and what is wrong with it." The paper argued attention markets are ethically broken because they commodify the capacity that makes autonomy possible. The AttMart solved every problem they identified: explicit consent, user-as-vendor, revocable discovery, transparent pricing.

### March 14 — First Real User Friction

Two users — Jonathan and Kirstin — hit onboard token expiry. Corporate email scanners (Outlook Safe Links) were consuming magic link tokens before humans clicked them. Fix: 60-second grace window on recently-consumed tokens.

**Then the critical discoveries:**

Every ticket confirmation email had failed since the first ticket sold. A Date serialization bug — `${new Date(...)}` in a SQL tagged template instead of `.toISOString()`. The webhook crashed after ticket creation but before email send. Chain reaction: the crash also prevented `settleTicketPurchase()` from running.

**66 tickets across 2 events. Zero confirmations sent. Zero settlements recorded.**

The tickets themselves were fine — the data was correct, the money was collected. But the downstream chain was broken. Backfill scripts written, not yet run.

Pay settlement UI shipped: transaction history, two-bucket balance display (cash/credit), platform fee verification. `transpilePackages` missing from all 14 apps — workspace packages export raw TypeScript, Next.js needs to know.

> The sobering lesson: real users expose the gap between "works for me" and "works for everyone."

---

## Phase 11: The Architecture Matures (March 15–19, 2026)

### March 15 — RFC Consolidation and Agent Convergence

Media browser UX refined: multi-select, view modes, color-coded .fair badges (green=public, orange=trust-graph, red=private). Media inference tools shipped in `@imajin/llm`.

**RFC consolidation:** 16 RFCs scattered across three locations (articles/, docs/rfcs/, GitHub Discussions) pulled into canonical `docs/rfcs/` with INDEX.md and consistent numbering. Nine discussion-only RFCs given repo files. Old copies removed.

**RFC-16: Jin Workspace Agent** produced five connected insights:

1. **Knowledge cache + conversation memory** — two-layer memory solving the "re-derive everything every query" problem
2. **Jin as distinct identity** — separate agent DID (`did:imajin:jin:{handle}`), not a shadow of the user. Ryan talks TO Jin, not to himself.
3. **Workspace canvas replacing chat box** — spatial panels instead of linearized chat. Jin surfaces documents, calendars, photos as visual panels.
4. **OpenClaw as agent runtime** — convergence point between Imajin and OpenClaw. OpenClaw already has tools, memory, sessions, heartbeats, multi-surface messaging, node access.
5. **Pluggable runtime interface** — `AgentRuntime` interface that Imajin owns. Tier 1: built-in. Tier 2: OpenClaw-connected. Tier N: anything that implements the interface.

Postgres backups went live: hourly `pg_dump` of 3 production databases, local retention (30 days) + Synology NAS (90 days). No cloud dependencies for operational data.

**External validation arriving:** George Polzer (Imperial College London, AI Program Leader) interested in academic comparison between MJN and A2SPA. Ben Feist (NASA, creator of Apollo in Real Time) signed up and recommended CRDTs for multi-source data merging. Ownership roadmap drafted: founders reverse-vest DOWN from majority to 2-3% as protocol governance matures.

### March 16 — The Graph Layer

Late-night session. The `@imajin/graph` package — the missing architectural piece.

The sovereign presence agent (RFC-16) created a "mess of services colliding" problem. Multiple services needed trust-scoped queries. The answer: a shared package (not a service) that imports `@imajin/db` directly for trust checks. No HTTP hops.

**Intent documents** for multi-service write coordination — a saga pattern with CRDT-like semantics. Build plan → collect readiness from all services → execute atomically. For multi-agent read coordination: fan-out queries with conflict surfacing.

> **Key principle:** Conflicts are NEVER resolved silently — always surface disagreements with attribution.

Pressure tested against five scenarios: single-agent actions, background autonomous work, agent-to-agent settlement, multi-domain expert coordination (three Jins planning an event), and streaming latency.

> Ryan's insight: "CRDT may help with agent coordination — get all your ducks in a row and then execute."

This became the intent document pattern.

Zakat and Islamic finance surfaced as prior art for protocol-level redistribution. Added to RFC-14. CRDTs identified as the entry point for registry synchronization across federated nodes.

### March 17 — The OG Users

Wesley Small, Scott Cameron, Ben Feist, Chris, Lee. Dinner. Platform demoed live.

> "They love it. Genuine excitement, not polite interest."

But:

> "What is it" problem persists. The experience clicks when you see it. Hard to explain cold.

**The validation and the challenge simultaneously.** Five technically sophisticated people immediately understood it when they used it. But the elevator pitch remained elusive. Success was creating a new problem: the thing was too integrated, too interconnected to reduce to a tagline.

These five became the first wave of real users onboarded via connection keys — outside Ryan's immediate family.

### March 18 — The Bad Session

Registration form integration. Multiple rounds of wasted compute because existing components weren't reused. Custom `InlineRegForm` built instead of generalizing `EventSurveyAccordion`. Dykil embed modified unnecessarily. A fallback form nobody asked for.

> Had to be told THREE TIMES to reuse the existing component.

Ticket-scoping took 4 separate commits because each fix addressed one layer without tracing the full chain.

**Lessons burned in:**
1. Reuse existing components — search the codebase first, generalize with props
2. Trace the full chain — when fixing a scoping bug, find ALL layers that share the assumption
3. Don't build from issue specs without checking current code — the issue isn't the truth, the codebase is

62 tickets sold on prod. 55 unique owners. The platform was scaling despite the development friction.

### March 19 — Migration Crisis Forces Governance

**The crisis:** Drizzle migration system completely broken across 14 services.

Root causes cascading: All services shared a single `__drizzle_migrations` table — drizzle counted rows, not hashes, so it thought migrations were applied when they weren't. Introspection-generated `0000_` files had SQL wrapped in `/* */` comments that drizzle couldn't execute. Migration files were never committed to git — generated on server, invisible to the codebase.

**The fix:** Per-service migration tracking tables (`__drizzle_migrations_auth`, `__drizzle_migrations_chat`, etc.). Programmatic migrator using `createRequire` for correct module resolution. All 14 services' drizzle directories committed to git. Manually applied and seeded tracking on both dev and prod. 14/14 green.

**Stable DIDs decision (#371):** The identity architecture grew up. Every DID became `did:imajin:xxx` from birth — email is just a credential attached to it, not the identity itself. New `auth.credentials` table: `(id, did, type, value)`. Tier reflects credential strength, not DID format.

This was the decoupling that had to happen. `did:email:user_at_domain_com` meant the email WAS the identity. Graduating to a keypair-based DID would orphan every reference across every schema. Stable DIDs solved it: the DID is permanent, authentication methods are interchangeable.

Summer Camp data cleanup: 24 survey responses married to tickets via email matching.

---

## Phase 12: The First External Protocol (March 20–21, 2026)

### March 20 — Market Launch and DFOS Discovery

Market app scaffolded and shipped (#374) — consent-based local commerce, no feed, no infinite scroll. Six market bugs fixed with three parallel coding agents. Toast component shipped across 9 apps, replacing 48 `alert()` calls. CI fixed (missing `.eslintrc.json` on market was hanging the lint step).

**Then: DFOS.**

Metalabel/DFOS — Yancey Strickler's (Kickstarter co-founder) open source cryptographic identity protocol. Ed25519 signed chains, self-certifying DIDs (`did:dfos`), content chains, countersignatures, Merkle beacons. Cross-language verification (TS, Go, Python, Rust, Swift). MIT licensed, ~4,800 lines.

Ryan was already in their dev channel, showing them Imajin.

> **Key finding:** DFOS = crypto substrate (proofs, identity chains, verification). Imajin = application layer (payments, trust, events, market, profiles). Complementary stacks.

Brandon (Clearbyte, OG Dev Wizard) responded:

> "very very interesting"
> "sounds like things line up nicely"
> "excited to jam w you on this!"

Three integration doors identified:
1. **DID Bridge** — same Ed25519 keypair, derived DFOS chain (actionable immediately)
2. **Sideloading** — relay for proof gossip + MCP for content access
3. **Space provisioning** — needs their space creation API (soft-blocked)

Ryan dropped "localized internet infrastructure" in the dev channel. That's the VC pitch.

Stable DIDs shipped (#372). Places app designed (#392). DFOS DID bridge spec written — 9 child issues (#396-404).

**The significance:** This was the first external protocol integration. Not a library dependency or an API consumption — a real protocol-level interop. Imajin positioned as Layer 6: the economic, settlement, and inference layer on top of DFOS's L0–L5 proof substrate.

### March 21 — DFOS Epic Sprint

All DFOS bridge issues built in one session:

- **`@imajin/dfos` package** — full bridge between Imajin Ed25519 keypairs and DFOS chain format
- **Login-time bridging** — DFOS chain derived and stored when users authenticate
- **Resolution endpoints** — `GET /api/identity/:did/chain`, `GET /api/resolve/dfos/:dfosDid`
- **Chain-aware middleware** — `requireAuth(req, { verifyChain: true })`, opt-in verification
- **Key rotation** — `POST /api/identity/:did/rotate`, session invalidation, rate limiting
- **`@imajin/cid` package** — DAG-CBOR + SHA-256 content identifiers (CIDv1), 10 tests
- **Countersignature attestations** — author JWS + witness countersign + decline flow

PR #407 (Phase 1+2), PR #412 (#398), PR #413 (#403) — merged. PR #426 (consolidated: #401, #400, #402) — 31 tests, awaiting merge.

**CI fix chain:** 5 commits to resolve webpack bundling of Node built-ins from `@metalabel/dfos-protocol`. The lesson: when a workspace package in `transpilePackages` imports a node_module with Node built-ins, webpack follows the entire chain. `serverExternalPackages` doesn't help because transpilation happens first. Must use `resolve.fallback: { net: false, ... }` for client bundles.

**P25 DFOS Adoption Audit** written — 10 child issues across all 8 services. Registry as "DNS for the sovereign network" — nodes present chains, registry verifies, provisions subdomains. Chain updates = node migration (same identity, new location).

**Brandon's relay spec update incoming.** Countersignatures = JWS re-sign (matches what #402 built). VC auth for reads = `Authorization: Bearer` header. Delegated chain write auth = VC in the op payload. OSS update coming.

---

## The Arc: From Platform to Protocol Infrastructure

### What it looked like from outside (March 10–21):
A working platform adding features and fixing bugs. Chat improvements, market app, more bug fixes. Standard startup iteration.

### What was actually happening:

**Week 6 (Mar 10–14):** The platform met reality. Real users hit real friction — corporate email scanners eating magic links, Date serialization crashing the entire downstream chain. 66 tickets sold with zero confirmation emails. But the same week, attestation infrastructure went live — six cryptographic attestation types operational, settlement verification working. The trust graph gained *substance* while the platform gained *resilience*.

**Week 7 (Mar 15–19):** Architecture maturation. RFC consolidation brought intellectual coherence to the codebase. The graph layer was designed as infrastructure for agent coordination. Database governance was forced by crisis. Stable DIDs decoupled identity from authentication. The platform was growing up — not just in features, but in the governance and architectural patterns underneath.

**Days 48–49 (Mar 20–21):** External protocol integration. DFOS discovered and bridged in 48 hours. Market app shipped. The platform was mature enough to interop with other protocols, and that integration stress-tested everything — build system, migration system, CI pipeline, architectural boundaries.

### The deeper pattern:

The platform followed the same discovery arc as the first 37 days, but at a higher level of abstraction:

- **Phase 1–9:** Build from identity → discover the protocol
- **Phase 10–12:** Build from the protocol → discover interoperability

Each crisis produced better infrastructure. The migration crisis produced per-service governance. Real user friction produced graceful error handling. DFOS integration produced proper build system boundaries. The pattern: **adversity as architecture.**

### The numbers grew:

| Metric | Day 37 | Day 49 |
|--------|--------|--------|
| Services live | 14 | 15 (+market) |
| Lines of code | 68,000+ | 130,000+ |
| Total commits | 300+ | 830+ |
| Registered identities | ~73 | ~120 |
| Tickets sold | 3 | 66 |
| Attestation types | 0 | 6 (live) |
| External protocols | 0 | 1 (DFOS) |
| RFCs | 12 (scattered) | 16 (canonical) |

### The sentence this phase was writing:

> **"Build from the protocol and you will find the network."**

The first 37 days discovered the protocol from the human layer. The next 12 days discovered interoperability from the protocol layer. DFOS partnership, Brandon's relay spec, countersignature alignment — all emerged from building the protocol correctly, not from seeking partnerships.

---

## What Exists (as of March 21, 2026)

### Live Services (15)
auth, pay, www, profile, registry, events, chat, connections, media, input, learn, coffee, links, dykil, market

### Protocol Infrastructure
- DFOS bridge (Phase 1+2 merged, Phase 3 awaiting merge)
- `@imajin/dfos` package — chain creation, resolution, verification
- `@imajin/cid` package — DAG-CBOR content identifiers
- Key rotation + multi-device auth
- Countersignature attestations
- Stable DIDs (`did:imajin:xxx` from birth)
- 31 protocol tests passing

### Attestation Layer (LIVE)
- 6 types: transaction.settled, customer, connection.invited, connection.accepted, vouch, session.created
- Cryptographic .fair signature verification at settlement
- Login attestations with auth strength metadata
- Connection attestations with vouch primitives

### Infrastructure
- Self-hosted on owned hardware (HP ProLiant ML350p Gen8)
- Local Postgres with per-service migration governance
- GPU node (RTX 3080 Ti) for inference + transcription
- GitHub Actions self-hosted CI/CD runner
- Caddy reverse proxy with auto-SSL
- Postgres backups: hourly, local (30 days) + Synology NAS (90 days)
- MJN token reserved on Solana mainnet

### Key Numbers
- ~120 registered identities
- 66 tickets sold on the sovereign stack (2 events)
- 30 essays written (9 published)
- 15 live services, 130,000+ lines of code
- 830+ commits over 49 build days
- 328 issues tracked (113 open)
- 79 PRs shipped
- $25/PR average inference cost
- Traditional estimate: growing. The gap between AI-assisted and traditional execution widens daily.

### The Stack (Updated)

```
┌─────────────────────────────────────────┐
│           Trust-Gated Services          │
│ events · chat · media · learn · input   │
│ market · coffee · links · dykil         │
│            places(*)                    │
├─────────────────────────────────────────┤
│          Attestation Layer              │
│  6 live types · crypto verification     │
│  countersignatures · The AttMart(*)     │
├─────────────────────────────────────────┤
│           Trust Graph Layer             │
│  connections · @imajin/graph(*)         │
│      intent docs · fan-out(*)          │
├─────────────────────────────────────────┤
│    Identity + Commerce + Protocol       │
│  auth (stable DIDs) · pay (Stripe/SOL) │
│  DFOS bridge · key rotation · CID      │
├─────────────────────────────────────────┤
│       Attribution + Discovery           │
│    .fair · registry · search(*)        │
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

*Compiled March 8, 2026. Updated March 21, 2026. From git history (830+ commits), daily memory files (49 days), and 30 essays.*
