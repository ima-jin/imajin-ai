# Build Timeline Summary & Pressure Test

*Compiled March 8, 2026. Updated March 22, 2026 — from the full [Build Timeline](./BUILD_TIMELINE.md), external analysis, and founder responses.*

---

## What This Actually Is

A build chronicle — part technical changelog, part philosophical memoir — documenting how one developer built a sovereign protocol in 50 days, largely alone, using AI as a parallel coding partner. Retrospective journalism written from the git history.

## The Core Thesis

Modern platforms extract from people by making their dependencies invisible. The antidote is radical transparency + owned infrastructure.

Every technical decision — DIDs, self-hosted hardware, invite-only registration, .fair attribution — flows from this. It's not a product company. It's an attempt to build alternative substrate.

---

## Layer-by-Layer Breakdown

### 1. Identity Layer (auth.imajin.ai)

The foundational choice: Ed25519 keypair cryptography + DIDs (Decentralized Identifiers) instead of email/password or OAuth.

**What this means practically:** You generate a cryptographic keypair. Your public key is your identity. You sign messages with your private key. Nobody issues you an identity — you generate it. No password resets, no "sign in with Google," no identity provider who can revoke your existence.

**The radical extension:** The same identity primitives apply to humans, AI agents, devices, organizations, and services. A bot and a person authenticate identically. This eliminates impersonation by design — every actor is typed and signed.

### 2. Payment Layer (pay.imajin.ai)

Wired to both Stripe (fiat) and Solana (crypto) from day one. This isn't monetization strategy — it's treating the ability to transact as infrastructure, like auth. The MJN token on Solana mainnet was reserved immediately, supply at zero, purely to prevent squatting.

### 3. Trust Graph (connections.imajin.ai)

Not a social graph — explicitly a trust topology. Who you connect to determines what you can see, who can reach you, and what service tiers you access. This is the architectural replacement for platform algorithms — instead of engagement optimization, access is determined by human-established trust relationships.

The invite-only registration enforces this structurally. You cannot self-register. Someone with an existing identity must extend an invite. The invite is the trust relationship. Consequence: the network can't be spammed, scraped, or flooded by bots — every identity has a human-accountable chain of trust behind it.

### 4. Attribution Layer (.fair)

Every piece of content, every event, every transaction carries a .fair manifest — a structured record of who created what, who contributed, and how revenue splits. This is provenance-by-default. It's a direct technical response to how platforms obscure who actually made things and extract value without attribution.

### 5. Physical Presence (Unit 8×8×8)

The LED cube isn't decorative. It's the conceptual anchor for the entire project. The argument: software became invisible, and invisible became unaccountable. A physical glowing object in your home that you know is an AI presence — that's legibility. You can't surveil what you can't hide.

The hardware-first revenue model (own it forever, no subscriptions) is a direct rejection of SaaS dependency cycles.

### 6. Self-Hosted Infrastructure

The HP ProLiant server running at home is the moment the project graduates from idea about sovereignty to actual sovereignty. Local Postgres, self-hosted CI/CD runners, GPU for local inference — these aren't performance choices, they're ownership choices.

---

## The Build Story

### The Constraint (30 years)

Ryan has been trying to build this for his entire career. Capital-gated every time. The architecture was always in his head — no capitalist was going to fund it from someone who couldn't articulate it in VC-speak.

Each attempt followed the same cycle: 10-14 days of intense building, burnout, pause, recharge. Starting in South Africa at WER1 (2025), the tools began approaching a tipping point. Each cycle included analysis and projection that development speed would keep accelerating, then level off — diminishing returns in inference that would need coherence in the rails.

### The Break (35 days)

OpenClaw dropped. The interface layer between architectural vision and working systems finally existed. 30 years of clarity, loaded and ready. 30 essays already in his head.

### The Execution

| Day | Milestone |
|-----|-----------|
| 1 | Unit 8×8×8 connected — AI presence through light |
| 3 | Auth (Ed25519 → DID) + Pay (Stripe + Solana) — same afternoon |
| 4 | Registry — federated node discovery |
| 7 | First ticket sold — full identity→payment→attribution→ticket pipeline |
| 14 | Server comes home — self-hosted on owned hardware |
| 16 | Invite-only registration — trust as entry condition |
| 20 | First external contributor (Staff Engineer at Slack) |
| 23 | 7 features shipped in 90 minutes using parallel coding agents |
| 25 | First non-developer creates a real event with ticket sales |
| 35 | 14 live services, ~60 identities, 68,024 lines of code |
| 36 | Typed identity primitives — Individual, Family, Cultural, Org |
| 37 | **The protocol discovers itself** — Ed25519 DID keypairs are Solana wallets |
| 39 | Chat becomes a primitive — every conversation is a DID |
| 41 | Attestation infrastructure LIVE — 6 types, trust graph gains substance |
| 43 | RFC consolidation — 16 RFCs canonical, Jin workspace agent designed |
| 45 | OG users see it live — "genuine excitement" + "what is it" problem |
| 47 | Stable DIDs — identity decoupled from auth method forever |
| 48 | DFOS discovered — Imajin positioned as L6 above external protocol |
| 49 | **DFOS epic sprint** — full protocol bridge built in one session, 31 tests |
| 50 | **DFOS relay live** — registry IS the relay. P26 complete (10 issues). 43 auth tests. Chain-aware identity on every service |

### The Numbers

| Metric | Value |
|--------|-------|
| Services live | 15 |
| Lines of code | 130,000+ |
| Total commits | 830+ |
| Inference cost | ~$6K ($25/PR avg) |
| Build days | 50 |
| Total issues | 328+ |
| PRs shipped | 90+ |
| Traditional estimate | $932,316+ over 16.4 months (3-person team) |
| Essays written | 31 (9 published) |
| Registered identities | ~120 |
| Tickets sold | 66 across 2 events |
| Attestation types live | 8+ |
| External protocols | 1 (DFOS — relay live, bridge complete) |
| Auth integration tests | 43 |
| RFCs | 16 (canonical) |
| Solana wallets (latent) | Every hard DID — they just don't know it yet |

---

## The DYKIL Concept

"Don't You Know I'm Local" — the community economics tool. Aggregate what households spend on extractive platforms (Netflix, Uber, AWS). Make the number visible. Let people choose.

This is exit theory rather than reform theory. Not "let's regulate Netflix" — let's show people what they're surrendering and offer a door out. The sovereign stack is the alternative.

---

## The "Network of Souls" Concept

The most philosophically ambitious piece:

- Every person with a DID can train a personal AI on their own context
- Others can query that AI, paying inference fees to the person
- Trust-graph topology determines who can query whom and at what tier
- Leadership emerges naturally from who gets queried most — not from votes, titles, or token holdings
- Governance flows through weighted trust, not bureaucracy

This is a direct challenge to both democratic (majority rule) and plutocratic (token-weighted) governance models. It proposes epistemic authority — you lead because people trust your thinking enough to pay for it.

---

## The "Start From the Human" Insight

The pivotal realization: Ryan had been trying to build a sovereign agent layer with imajin-cli. It wasn't cohering. But by building for humans first — auth, payments, connections, events — the agent layer emerged naturally, with proper trust boundaries already in place.

**The implication:** Safe AI agents are a byproduct of sovereign human infrastructure, not a separate problem to solve. If every action is scoped by identity, signed by a keypair, and bounded by trust-graph topology, then agents operating on that substrate are inherently accountable. The human-protection layer and the agent-safety layer are the same layer.

---

## Five Revenue Streams

Revenue from day one. No critical mass required. Every stream produces income from the first transaction.

### 1. Settlement Fees (#113)
Protocol percentage on every transaction. Ticket sales, tips, service calls. Revenue from transaction one.

### 2. Declared-Intent Marketplace (#114)
Users own their attention as an asset — not data harvested by platforms, but a profile they consciously build and rent out. Like owning property with a billboard on it: you decide what goes up, you get paid, you can take it down tomorrow.

Three tiers of commercial reach:

- **Trust graph (free/low cost)** — You're connected to a coffee shop. They post "new blend, $12/bag." You see it because you chose to connect. Settlement fee on resulting transactions. This isn't advertising — it's the graph working.
- **Declared interest (medium gas)** — Users opt into categories: "I care about specialty coffee, vinyl, local restaurants." Businesses pay to reach matching users. User gets a cut. The profile never leaves the user's node — matching happens locally, not in an exchange.
- **Extended reach (high gas)** — Business wants to reach beyond their direct graph. Higher cost per impression, larger user cut. Still requires the recipient to have opted in — you can't burn gas to reach someone who hasn't opened the door.

**The structural difference from surveillance advertising:** The profile stays on the user's node. There's no exchange, no intermediary holding attention profiles, no auction. .fair manifest on every commercial interaction — full attribution chain, who paid what, where the user's cut went. Revocable at any time, granular control over what's shared.

### 3. Headless Service Settlement (#115)
Machine-to-machine. Every API call between nodes is a settlement event. Bots, translation services, embedding services, notification routers — each call settles through .fair. This is where the agent economy lives.

### 4. Education Settlement (#116)
Direct knowledge transactions. Courses, tutorials, consultations through learn.imajin.ai. .fair attribution chains mean building on someone's teaching compensates them.

### 5. Trust Graph Queries (#117)
"Ask [Name]." Domain expertise as queryable infrastructure. A doctor's clinical intuition, a mechanic's 30 years of pattern recognition — none of this is in training data. The trust graph makes it findable and routes value back. The revenue stream with no ceiling.

**Key property:** Streams 1-4 don't require running personal AI. The base layer is transactions, not inference. The 90% who never touch inference still generate and capture value through every other channel.

---

## Node Model

Not everyone needs a node. A single node can host hundreds or thousands of users.

| Tier | Model | Cost | Earns From |
|------|-------|------|------------|
| 1 | Use someone else's node | Free | Own transactions, attention, knowledge |
| 2 | Run your own node | ~$50 (Raspberry Pi) | All of above + full data sovereignty |
| 3 | Run a community node | Server + Unit hardware | All of above + settlement fees from all users |

The Unit isn't a consumer device everyone buys. It's the physical interface to a community node — how you know the node is there. Maps directly to the BBS model: sysop ran the board, users dialed in. The trust was with the operator.

The difference from 1991: if the operator betrays trust, you take your DID and walk. Your identity, reputation, and data are portable.

---

## Pressure Test

### Q: Does query volume just recreate influence dynamics?

Raw query count would recreate follower-count economics. Three structural differences:

1. **Queries are bidirectional cost.** You pay to ask, and you can only ask people in your trust graph. This kills the viral loop that creates influencer dynamics. You can't cold-query a stranger.

2. **Trust graph has depth limits.** 2-3 hops max for resolution. You can't accumulate millions of queryable connections. The topology physically constrains concentration.

3. **Self-correcting feedback.** Bad answers erode trust connections, which reduces future queries. The mechanism is self-correcting in a way follower counts aren't.

**Honest assessment:** Relied-upon-ness is a better proxy than followers. It's not a perfect proxy for wisdom. This is the thing that needs the most real-world testing.

### Q: Does sovereignty hold without hardware?

The answer has to be yes, or the project doesn't scale. The Unit is the proof of concept for *legibility* — making the invisible visible. But the sovereignty guarantee comes from:

- **DIDs are portable** — your identity isn't locked to any host
- **.fair manifests travel with content** — attribution doesn't depend on where it's stored
- **A Raspberry Pi is sovereign** — physical hardware isn't the Unit or nothing
- **Cloud burst is pragmatic** — use cloud when your home node is off, come back anytime
- **The exit door test** — can you leave and take everything with you? If yes, you're sovereign even on borrowed infrastructure

Software nodes are sovereign. The cube is sovereign *and undeniable*.

### Q: Is philosophical clarity the actual scarce resource?

Yes. The 30 essays are the moat, not the 68K lines of code. Anyone with architectural clarity and modern AI tools could rebuild the stack. But the *coherence* — every decision pointing the same direction — comes from 30 years of seeing the pattern. That can't be rebuilt in 35 days.

Imajin's real defensibility isn't code. It's thesis. The essays, the .fair standard, the trust graph design, the revenue model. Protected by being *published*, not patented. Open source as immune system.

The execution barrier being near zero is a feature, not a threat. It means anyone with clarity can build. That's the whole point.

### Q: If 90% never run personal AI, does the trust graph still produce equitable outcomes?

Yes — because inference is stream 5 of 5, not the foundation.

Streams 1-4 (settlement fees, declared-intent marketplace, headless service settlement, education) don't require running personal AI. Users earn from transacting, sharing attention on their terms, offering services, and teaching.

Stream 5 (trust graph queries) is the high-upside path for people who invest in building their sovereign presence — but it's additive, not gatekeeping. The base layer is transactions, not inference. The network produces equitable outcomes because value flows through multiple channels, not a single mechanism.

The asymmetry between those who run AI and those who don't exists — but it's the same asymmetry as between someone who writes a book and someone who reads it. The author captures more value. That's not inequitable. It's proportional to contribution.

### Q: Isn't sovereign ad routing still surveillance capitalism with better consent forms?

*(Greg's follow-up, March 9 — the hardest question in the stack.)*

The original framing of Stream 2 — "Sovereign Ad Routing" — had a structural contradiction. The project rejects surveillance capitalism, but advertising is surveillance capitalism's revenue model. Calling it "consent-based" reframes the tension without dissolving it. If Imajin routes ads from external advertisers to users based on attention profiles, it's a cleaner version of the same game. Better consent model, same master-servant dynamic.

**The revision:** Stream 2 isn't ad routing. It's a **declared-intent marketplace where users own their attention as an asset.**

The structural differences that make this not-surveillance-capitalism:

1. **The profile never leaves the user's node.** There's no central attention database. No exchange. No auction house. Matching happens locally — the user's node evaluates whether a business's offer matches their declared interests. The business never sees the profile. They see a match count and pay for delivery.

2. **The user gets paid, not the platform.** Current model: platform harvests data → builds profile → sells access → keeps the money. This model: user declares interests → profile stays on their node → business pays to match → user gets a cut. The economics flow to the person, not the intermediary.

3. **Businesses are just nodes with DIDs.** No special advertiser class. No capital → reach pipeline. A business earns trust-graph position the same way a person does — through connections, not through spending. A company with $10M has the same graph mechanics as a person with $0.

4. **Gas cost scales with distance.** Reaching your own connections is cheap. Reaching people who've opted into your category costs more. Reaching further costs significantly more. This is the inverse of current advertising, where reach is cheapest at scale (bulk buys, programmatic) and most expensive for small players.

5. **Revocable at any time.** Not "delete your account" revocable. Instant, granular: stop sharing with this business, stop this category, stop everything. No dark patterns, no 30-day waiting periods.

**The honest tension that remains:** Does the incentive to earn from your attention profile pressure people into sharing more than they would otherwise? Yes, probably. But the pressure exists today with zero compensation and zero control. This puts the asset in their hands and lets them decide. The sovereignty guarantee holds because the *choice* is real — you can opt out entirely and the network still works for you through every other stream.

**To Greg's specific sub-questions:**

- *Can an advertiser become a node?* Yes — but they're a node like everyone else. Subject to the same trust dynamics. Betraying trust costs connections. No special privileges.
- *Does capital give trust-graph weight?* No. Trust is connection-based, not stake-based. You can't buy connections. A large advertiser can burn more gas to reach opted-in users at higher cost, but they can't buy *position* in anyone's trust graph.
- *Serving two masters?* The user and the business aren't being served by Imajin — they're transacting directly through the graph. Imajin takes a settlement fee. There's no optimization function trying to maximize both engagement and ad revenue. The match is declared by the user, not inferred by the platform.

**The concession:** The original "Sovereign Ad Routing" name was wrong. It implied Imajin routes ads. Imajin doesn't route anything — users declare, businesses offer, the graph connects them. Updated to "Declared-Intent Marketplace" to reflect the actual mechanics.

---

## The Convergence (March 9, 2026)

On Day 37, two things happened that reframed everything that came before.

**First:** Greg Mulholland's pressure testing crystallized the typed identity model. The flat "DID" in the whitepaper became four first-class primitives — Individual, Family, Cultural, Org — each with different governance, trust semantics, and graph behavior. The same trust graph, queried from different primitive types, yields fundamentally different shapes. Whitepaper bumped to v0.2.

**Second:** Ryan asked whether the app should have wallet functionality. The answer: **every Imajin DID keypair is already a valid Solana wallet.**

Ed25519 was chosen on Day 3 for identity — the right primitive for sovereign keypairs. Solana uses Ed25519 for wallet addresses. Nobody coordinated this. The choice was made for identity, not settlement. But because both were solving for the same mathematical truth, every registered user was already a wallet holder. The settlement layer was hiding inside the identity layer for 34 days.

This is the punchline the build timeline was writing toward without knowing it:

- Day 3: Ed25519 keypair → sovereign identity
- Day 7: First ticket → settlement works
- Day 14: Server comes home → sovereignty is physical
- Day 35: "Start from the human" → the agent layer emerges from trust boundaries
- **Day 37: The protocol discovers itself** → the settlement layer emerges from the identity layer

Each layer was discovered, not designed. Excavated from the git history by building from the right principles.

**What followed in one session:**
- MJN-scoped wallet (blast radius contained — not a general crypto wallet)
- Hierarchical key derivation (child keys for spending, delegation, sessions — each revocable)
- Per-primitive wallet governance (Family = multi-sig, Cultural = quorum, Org = delegation)
- Reserve-backed token economics (dual-currency, mint/burn, fixed rate → managed float)
- Foundation clearinghouse model

Three RFCs in one evening. Not designed from a whiteboard — discovered from the build.

> **"Start from the human and you will find the protocol."**

---

## What This Is Challenging

A direct counter-stack to:

| Incumbent | Imajin Layer |
|-----------|-------------|
| Google/Apple OAuth, Auth0 | auth — keypair identity, no provider |
| Stripe-as-platform | pay — settlement engine, Stripe as plumbing |
| Eventbrite, Luma | events — trust-gated ticketing |
| Linktree | links — sovereign link pages |
| Discord, Slack | chat — real-time messaging on owned infrastructure, DID-based conversations |
| S3, Cloudflare R2 | media — DID-pegged storage with .fair |
| Etsy, Facebook Marketplace | market — consent-based local commerce, no feed, no infinite scroll |
| Google Calendar, Outlook | calendar — trust-gated scheduling (planned) |
| Google Ads, Meta Ads | The AttMart — user-as-vendor attention marketplace |
| Every platform that ties your existence to a corporate account | The entire stack |

---

## The New Convergence (March 10–22, 2026)

The first 37 days discovered the protocol from the human layer. The next 13 days discovered interoperability from the protocol layer.

**Attestation infrastructure went live (Day 41):** Six cryptographic attestation types operational. The trust graph stopped being a connection list and became a live cryptographic record. Settlement verification working. Login attestations carrying auth strength metadata. The AttMart concept validated by academic literature.

**Stable DIDs (Day 47):** Identity decoupled from authentication method. Every DID is `did:imajin:xxx` from birth — email is just a credential. This was the architectural prerequisite for everything that followed.

**DFOS bridge (Days 48–49):** First external protocol integration. Yancey Strickler's DFOS = crypto substrate (proofs, identity chains). Imajin = Layer 6 (economic, settlement, inference layer on top). Same Ed25519 curve, complementary architectures. Built and tested in one session — 31 tests, key rotation, content addressing, countersignatures.

**P26 complete + relay live (Day 50):** Greg's P27 proposal adopted — DFOS as cryptographic substrate, not external integration. `did:imajin` becomes an alias, chain is canonical. All 10 P26 issues shipped across 4 batches. Every service now chain-aware. Registry mounted the DFOS web relay — Imajin is running a live relay node. 43 auth integration tests. The posture shift: from "waiting for spec" to "we integrated, here's what we built."

**The sentence this phase was writing:**

> **"Build from the protocol and you will find the network."**

The first 37 days: "Start from the human and you will find the protocol." Days 38–50: build from the protocol and external networks discover you. DFOS partnership emerged from building correctly, not from seeking partnerships.

---

*"The best way to make something better within a system that has absolute control over everything is likely to make a completely free and easy to use system that just works on its own frequency."*

— Ryan Veteze

---

*Based on analysis by Greg [surname redacted], founder responses, and the [full build timeline](./BUILD_TIMELINE.md). March 8–22, 2026.*
