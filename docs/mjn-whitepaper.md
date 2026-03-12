# MJN
## The iMaJiN Network Protocol
### Identity · Trust · Attribution · Settlement · Presence

**今人 — ima jin — "now person"**

**Protocol Specification v0.3 · March 2026 · DRAFT**

*Ryan Veteze (b0b) · ryan@imajin.ai · imajin.ai · github.com/ima-jin/imajin-ai*

---

> You are not the customer. You are the inventory.

---

## Abstract

You pick up your phone to check one thing and lose an hour. You delete the app, reinstall it a week later. You watch your kid scroll and recognize the same thing happening to you.

3.5 hours a day. That's the average. Most people know their number is higher.

*今人 (ima jin)* is Japanese for "now person." Present. Real. Here. A sovereign human being in this moment. Not a profile. Not an account. Not inventory for an ad platform.

The internet was built to move information between machines. HTTP moved documents. TCP/IP moved packets. Neither carried identity, attribution, consent, or value. Somewhere in the thirty years between the first web browser and the current AI moment, the actual human — present, real, accountable — was replaced by a profile owned by a platform, an account that could be revoked, an identity that belonged to someone else.

MJN carries all four — natively, at the protocol layer.

MJN is an open application-layer protocol that extends the existing internet stack with sovereign identity, creative attribution, programmable consent, and automated value settlement. Like HTTP, it runs over TCP/IP and is transport-agnostic. Unlike HTTP, every MJN exchange carries a verified sender identity, an attribution manifest, a consent declaration, and a settlement instruction. These are not optional headers — they are the protocol. They are what it means to be a now person on the network.

The protocol wasn't designed. It was excavated — from 30 years of building systems, from watching what platforms destroy, from starting with the human and finding the protocol underneath.

MJN is governed by the MJN Foundation, a Swiss Stiftung. The protocol is open source. No entity owns it. Any implementation is a valid node. The name itself — drawing from Japanese, built by a Canadian, governed from Switzerland, designed for the world — is not incidental. Sovereign infrastructure has no nationality. Neither does 今人.

---

## The Problem

### Six Problems. One Root Cause.

All six have the same root: no sovereign identity on the internet.

**Infrastructure hostages — fix these or nothing else works:**

1. **Your identity is an account they issued.** They can revoke it. Google, Apple, Meta — each holds a fragment of who you are, and each can make that fragment disappear. Email is spoofable. Accounts are fake. Identity is platform-issued and platform-revocable.

2. **Your relationships are their asset.** The social graph is the lock-in. Leaving a platform feels like dying because your relationships belong to them, not to you. The connections you built over years — gone the moment you leave.

**Asset hostages — being monetized against you right now:**

3. **Your reputation lives on their server.** $1.5 trillion freelance market. Non-portable ratings. Five years of five-star reviews — gone the moment you leave. Your accumulated trust, your track record, your professional identity — all held hostage by platforms that didn't earn it.

4. **Your attention is worth $272/year to advertisers.** You get $0. Meta makes approximately $272 per year from every North American user. You get: an app designed to keep you scrolling. Your attention — the scarcest resource you have — is sold to the highest bidder without your knowledge, without your consent, and without a cent of compensation.

**Being enclosed — the window is closing:**

5. **Commerce rails are consolidating.** 33 million US small businesses paying roughly $15,000 per year in processing fees. The rails are getting fewer and more expensive. Terms change unilaterally. Businesses won't feel the trap until they're fully inside it.

6. **Agent identity standards are being written right now.** Every agent framework being built today solves capability. None solve accountability. Agents have no identity, no portable reputation, no way to prove who sent them or what they're authorized to do. Whoever sets the identity standard sets the enclosure.

### The Cost Is Measured in Trillions

Three recent events made the cost undeniable:

- **February 2026**: Anthropic and OpenAI publicly accused DeepSeek, Moonshot, and MiniMax of running industrial-scale distillation attacks — 16 million fraudulent exchanges — to extract frontier model capabilities with no compensation to the humans whose work trained those models.

- **The local journalism collapse**: A decade-long erosion of accountability infrastructure because no economic model existed to sustain direct community relationships between journalists and the people they serve. Zuckerberg decided it was cheaper to disappear Canadian journalism from Canadian feeds than pay the outlets whose content built his engagement. A foreign billionaire unilaterally restructured the information diet of an entire country.

- **The AI training data crisis**: The absence of attribution infrastructure made it structurally impossible to compensate the humans whose creative work trained the models that now generate billions in revenue for platform operators.

These are not separate problems. They are the same problem at different scales: the internet has no native layer for identity, attribution, consent, or value.

MJN builds that layer.

---

## The Protocol

### Stack Position

MJN sits at the application layer, above TCP/IP and HTTP:

```
MJN          ← identity + attribution + consent + settlement
HTTP/WS      ← transport
TCP/IP       ← packets
```

MJN does not replace HTTP. It gives HTTP exchanges economic and social meaning. A request that carries MJN headers is a request from a verified identity, with attribution declared, consent explicit, and settlement instruction attached.

### The Architecture: Scopes × Primitives

The protocol is organized around two dimensions. Every problem MJN solves — every use case, every interaction, every settlement — is a cell in the matrix formed by their intersection.

**Four Identity Scopes** describe who is acting:

| Scope | What It Is |
|-------|-----------|
| **Actor** | One DID, one keypair. The atomic unit. Humans, agents, and devices. |
| **Family** | Intimate trust. Shared resources, delegated authority. |
| **Community** | Shared purpose. Trust earned and attested. |
| **Business** | Structured entity. Roles, hierarchy, delegation chains. |

**Five Primitives** describe what they can do:

| Primitive | What It Carries |
|-----------|----------------|
| **Attestation** | Credentials, reputation, endorsement |
| **Communication** | Scoped messaging within and across trust rings |
| **Attribution** | .fair manifests, revenue chains, creative lineage |
| **Settlement** | Payments, fees, declared-intent marketplace |
| **Discovery** | Federated registry, node presence, queryable expertise |

The protocol IS the matrix. Every problem we described in the previous section is a cell in this grid. The platform is the matrix.

---

## Identity Scopes

MJN does not treat identity as a flat concept. An "account" with permissions attached after the fact is what every identity system in production today provides. Google, Apple, Meta, even the W3C DID specification itself — all model identity as one type. They handle the differences in application logic, not at the identity layer.

MJN encodes the type at the protocol level. A DID is always one of four scopes, each encoding a fundamentally different kind of entity with different trust semantics, governance models, and graph behavior. Trust relationships, governance models, and privacy boundaries are structural — they cannot be bypassed by application code because they are properties of the identity itself, not policies applied to it.

### Actor — The Atomic Unit

One DID, one keypair. The foundation everything else is built from.

An Actor is a sovereign identity — generated, not issued. Not revocable by any third party. Not tied to any single infrastructure provider. When you generate an Ed25519 keypair, that's your identity. Nobody issued it. Nobody can revoke it. It's cryptographically yours.

```
did:mjn:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

MJN DIDs are compatible with the W3C DID Core specification. They are portable across all implementations.

**Actor subtypes.** The Actor scope covers three kinds of entities — all with the same keypair structure, the same DID format, the same trust graph, the same .fair attribution:

- **HumanActor** — A person. Self-sovereign. The irreducible unit of identity.
- **AgentActor** — An AI agent. Child key derived from a parent human or organizational DID. Authority scope encoded in the key derivation path — an agent key derived with scope `[attribution:collaborator]` cannot produce a valid signature claiming `[attribution:creator]`. The key either has the authority or it does not. No runtime policy to circumvent.
- **DeviceActor** — A physical device. The LED cube responding to verified presence. The sensor reporting environmental data. Same cryptographic structure, same accountability chain.

We're not competing with agent frameworks. We're the substrate they're missing. Every agent framework being built today solves capability. None solve accountability. MJN makes agents first-class citizens of the trust graph — signed, typed, scoped, accountable.

On Day 37 we discovered: every Ed25519 keypair we'd generated was already a valid Solana wallet. Every backup file our users downloaded was already a wallet private key. No integration. No bridge. No derivation. The protocol wasn't designed to do that. It was excavated from building from the right principles.

#### Progressive Trust: Three Standing Levels

Standing on MJN is computed, not assigned. It is a query over attestation history — not a role granted by an administrator.

| Standing | Label | Access | How You Get There |
|----------|-------|--------|-------------------|
| Soft DID | **Visitor** | Email/magic link. Read-only access to public content. | Show up. Provide an email. |
| Hard DID Preliminary | **Resident** | Keypair present. Pod membership. Cannot vouch for others. | Generate a keypair. Get invited by an existing member. |
| Hard DID Established | **Host** | Full standing. Can vouch. Full governance participation. Can issue attestations. | Earn it. Attend events. Get vouched for. Build history. |

Standing is computed from attestation history: event attendance, vouches received, interactions verified, milestones completed — weighted by recency, by the standing of the people who vouched for you, and by the depth of your participation. No shortcuts. No payments. No gaming the algorithm.

The vouch chain creates accountability. When you vouch for someone, your standing is partially staked on their behavior. If they accumulate negative flags, the weight of your vouch decreases — affecting your own standing. This mirrors how trust works in human networks: your reputation is partially a function of who you've sponsored.

**Properties:**
- Self-sovereign: generated, not issued
- Governance: individual autonomy
- Entry: invitation from existing trust graph
- Default visibility: private — you control what others see

### Family — Intimate Trust

The smallest unit of shared identity. Biological or chosen.

- Formed by mutual attestation between Actor DIDs
- Governance: consensus among members
- Entry: invitation + acceptance by existing members
- Default visibility: private interior, shared exterior

Family is the trust boundary where privacy is structurally different. Members share context that no external party can access — custody, finance, healthcare decisions, emergency access. A parent consenting on behalf of a minor carries a custodial consent declaration that encodes the relationship cryptographically. Settlement for family resources flows through multi-signature authorization.

This is not a group chat with special permissions. The protocol knows the difference because the identity type carries it.

### Community — Shared Purpose

Communities of practice. Art collectives, music scenes, mutual aid networks, open-source projects, festival communities. Entities defined by shared practice rather than legal structure.

- Formed by quorum: minimum founding Actor DIDs with demonstrated participation history
- Governance: trust-weighted — contribution history (.fair), activity recency, and attestation weight determine authority
- Entry: formation threshold + demonstrated participation (a performance qualifier, not a financial barrier)
- Membership: fluid and tiered (governing, active, participant, observer)
- Default visibility: public face, private interior — the world sees the identity and output; membership roster stays internal
- No single Actor DID can hold unilateral control — structural anti-capture
- Profit motive structurally excluded — this is not a business, it's a practice

A music collective is not a business that hasn't incorporated yet. The protocol treats it as what it is: a group of people who create together, governed by contribution rather than hierarchy.

Community DIDs can maintain their own attestation vocabularies — community-specific types for ceremonies, achievements, roles that the protocol's default vocabulary doesn't cover. They can curate declaration namespaces for discovery matching within their domain. The governance weight of each member is computed from their .fair contribution history and attestation record, not appointed by a founder.

### Business — Structured Entity

Businesses and legal entities. Incorporated, registered, with named founders and optionally a profit motive.

- Formed by declaration from one or more founding Actor DIDs
- Governance: founder-anchored hierarchy with delegated roles
- Entry: vetting + covenant alignment
- Membership: fixed (employees, partners, with scoped permissions)
- Default visibility: public by default — name, category, output, aggregate transactions

**The founding anchor is non-severable.** An Org DID is permanently and cryptographically linked to its founding Actor DIDs. Negative attestations against the business propagate a standing penalty to the founders. You cannot create a business, behave badly, and walk away. Your standing is staked on every business you found — permanently.

**The covenant.** Every Business DID is admitted through a conformance gate: a signed, auditable behavioral checklist. Not a values alignment test — a list of specific, observable behaviors that disqualify an entity. Does it sell user behavioral data? Does it require accounts on surveillance platforms to transact? Does it claim attribution without signing .fair manifests? These are auditable. "Aligns with regenerative economics" is not. The covenant describes behaviors, not identities.

**Soft-loading: the cold-start inversion.** Businesses don't need to join MJN. Their customers build their presence for them:

1. Users check in at a location and record transactions
2. A soft Business DID is created — unclaimed, community-built
3. When the business owner claims it, they inherit: verified customer count, transaction volume, reviews
4. The community has already voted with their behavior before the vetting question is ever asked

Claiming requires real thresholds: at least 5 unique check-in DIDs, at least 3 explicit vouches from Established actors, check-ins spanning at least 60 days, and the claimant must themselves hold Established standing. Historical check-ins do not automatically become vetting endorsements — the checking-in users are notified and choose to explicitly vouch, abstain, or object. Consent matters here for the same reason it matters everywhere: an unsigned claim is not a claim.

**Founding-cohort capture resistance.** The conformance gate must not become the new platform control point. Early members of any network accumulate outsized influence over who gets admitted. MJN addresses this through a Composite Attestation Model requiring three independent inputs: person attestations (standing-weighted), soft-loading evidence (democratic — every check-in counts equally regardless of the checker's standing), and covenant compliance (auditable behaviors, not cultural alignment). No single input can be gamed in isolation.

### Structural Comparison

| Property | Actor | Family | Community | Business |
|----------|-------|--------|-----------|----------|
| Default visibility | Private | Private interior | Public face, private interior | Public |
| Governance | Individual | Consensus | Trust-weighted quorum | Founder-anchored |
| Entry condition | Invitation | Mutual attestation | Quorum + participation threshold | Declaration + covenant |
| Membership | Singular | Intimate, stable | Fluid, tiered | Fixed, role-scoped |
| Profit motive | N/A | N/A | Structurally excluded | Allowed |
| Can hold funds | Yes | Yes (shared) | Yes (quorum-signed) | Yes |

These are not access tiers. They are not permission levels. They are fundamentally different kinds of entities in the world, and the protocol treats them as such.

---

## The Five Primitives

### 1. Attestation — The Cryptographic Foundation

Every trust-relevant act on MJN is a cryptographically signed record from the moment it occurs. Not a database entry. Not an unsigned log. A signed, typed, timestamped attestation that proves who said what about whom, and when.

This is the foundation everything else builds on. Standing is computed from attestations. Reputation is a query over attestations. Governance weight derives from attestation history. The BaggageDID — portable context when you leave a node — is a signed summary of already-signed attestation records. The integrity is end-to-end provable, not asserted at exit.

#### The Attestation Data Layer

```sql
CREATE TABLE auth.attestations (
  id            TEXT PRIMARY KEY,           -- att_xxx
  issuer_did    TEXT NOT NULL,              -- who signed it
  subject_did   TEXT NOT NULL,              -- who it's about
  node_context  TEXT NOT NULL,              -- anchors to relationship root
  type          TEXT NOT NULL,              -- controlled vocabulary
  context_id    TEXT,                       -- event/org/interaction DID or ID
  context_type  TEXT,                       -- 'event' | 'org' | 'interaction' | 'system'
  payload       JSONB DEFAULT '{}',         -- ENCRYPTED under subject_did key
  payload_hint  JSONB DEFAULT '{}',         -- unencrypted aggregate for computation
  signature     TEXT NOT NULL,              -- Ed25519 by issuer — verified at write
  issued_at     TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,                -- time-decaying flags
  revoked_at    TIMESTAMPTZ,                -- nullable revocation
  issuer_type   TEXT NOT NULL DEFAULT 'human'  -- 'human' | 'agent' | 'system'
);
```

**Signing starts at onboarding, not at departure.** When an Actor joins a node, a bilateral relationship is established — both parties sign a root record. Every attestation issued within that relationship references this root. The trust history is cryptographically anchored from the first interaction.

**Verification gate at ingestion.** Unsigned or unverifiable attestations are rejected at write. The POST endpoint verifies the Ed25519 signature against the issuer DID's public key before storing. Invalid signatures get a 4xx, not a null signature field. A protocol primitive that can be self-declared by any node, without verification, is not a primitive — it is a convention. Conventions break under adversarial conditions. Cryptographic signing does not.

**Privacy by architecture.** The `payload` field is encrypted under the subject DID's public key at write time. The node operator sees aggregate metadata — type, issuer, timestamp, signature — enough to compute standing. They never see the narrative content: the flag details, the vouch rationale, the relationship context. That content belongs to the person it's about, encrypted under their key, portable with them when they leave.

This is the difference between a sovereignty layer and a surveillance layer. The architecture enforces it structurally, not through query-layer policy that a node operator could bypass.

#### Attestation Types

| Type | Issued By | What It Records |
|------|-----------|----------------|
| `event.attendance` | EventDID | Physical presence at verified event |
| `vouch.given` | Established Actor | Sponsors onboarding of new Actor |
| `vouch.received` | System | Issued at vouch acceptance |
| `checkin.verified` | BusinessDID | Physical presence at business location |
| `interaction.verified` | System | Completed meaningful exchange |
| `milestone.completed` | System | Onboarding period milestone |
| `flag.yellow` | Established DID / governance | Soft concern |
| `flag.amber` | Governance body | Formal concern |
| `flag.red` | Governance body | Severe |
| `flag.cleared` | Governance body | Resolution record |
| `org.founding` | System | Non-severable business accountability anchor |
| `org.checkin.soft` | Any Actor | Check-in at unclaimed business location |
| `org.claim.vouch` | Established Actor | Explicit vetting endorsement for business claim |
| `relationship.root` | Node + Actor (bilateral) | Onboarding anchor — both parties sign |

The vocabulary is versioned and extensible. Community DIDs can propose community-specific attestation types for practices the default vocabulary doesn't cover.

#### Standing Computation

```
standing(did, scope?) = f(
  positive_attestations    -- weighted by type, issuer_type, and issuer standing
  negative_attestations    -- flags weighted by severity and recency
  recency_weights          -- time-decay function over issued_at
  issuer_standing          -- recursive: issuer's standing affects weight
  node_context             -- optional: scope to a specific community
)
```

Two distinct queries matter:

- **Community standing**: trust earned within a specific node. Relevant for local governance, access, flag review.
- **Cross-node standing**: aggregate standing across all nodes. Relevant for portable context, inter-node vouching, Community DID formation.

Without this distinction, standing becomes a global aggregate that ignores where trust was earned. A high cross-node standing manufactured by participating minimally in many nodes is structurally different from deep standing in one tight-knit community. The protocol knows the difference because `node_context` is a first-class field on every attestation.

### 2. Communication — Scoped Messaging

Messaging on MJN is scoped by the trust graph. Not filtered by an algorithm. Not routed through a platform that reads your messages. Scoped: who can talk to whom is determined by the structure of relationships in the graph, and the identity types at both ends determine the rules.

An Actor-to-Actor message within a Family scope carries different privacy guarantees than a Business-to-Actor message in the Discovery scope. A Community DID's internal channels are visible only to members at the appropriate tier. A Business can message its trust-graph connections but cannot initiate connections — it can only respond to relationships that humans chose to create.

Communication inherits the cryptographic infrastructure of the attestation layer. Messages are signed by the sender's DID. Delivery confirmation is an attestation. The entire communication history between two parties is a queryable, signed record — not a platform database that can be altered, redacted, or sold.

**Per-scope communication rules:**

| Scope | Communication Properties |
|-------|------------------------|
| Actor | Private by default. Encrypted end-to-end. Sender and recipient control retention. |
| Family | Shared interior channel. Custodial messaging (parent-child). Emergency broadcast. |
| Community | Tiered channels by membership level. Governance communications require quorum visibility. |
| Business | Cannot initiate connections. Can message existing trust-graph connections. All commercial messaging is consent-gated and gas-priced. |

### 3. Attribution — .fair Manifests

Every piece of creative work that moves through MJN carries a `.fair` manifest: a cryptographically signed document embedded in the work itself — not in a platform database — that records the complete chain of human creative labor that produced it.

The manifest carries:
- Who made it, in what proportion
- What prior work it derives from
- What terms govern future use
- What compensation executes automatically when those terms trigger

The manifest travels with the work. It is immutable. It is owned by nobody. It is verifiable by anyone.

```json
{
  "version": "1.0",
  "did": "did:mjn:z6Mk...",
  "contributors": [
    { "did": "did:mjn:z6Mk...", "role": "author", "share": 0.85 },
    { "did": "did:mjn:z6Ab...", "role": "editor", "share": 0.10 },
    { "did": "did:mjn:z6Cd...", "role": "source", "share": 0.05 }
  ],
  "derivedFrom": ["did:mjn:z6Ef..."],
  "terms": {
    "read": { "price": 0.08, "currency": "MJN" },
    "train": { "price": 0.50, "currency": "MJN", "consent": "explicit" },
    "redistribute": { "price": 0.00, "conditions": "attribution-required" }
  },
  "signature": {
    "algorithm": "Ed25519",
    "value": "...",
    "publicKeyRef": "did:mjn:z6Mk...#key-1"
  }
}
```

#### Cryptographic Signing End-to-End

.fair manifests must be signed. This is not optional. An unsigned manifest is a convention, not a protocol primitive. Conventions break under adversarial conditions.

Every manifest carries an Ed25519 signature from the owner DID. The settlement layer rejects manifests that are unsigned or have invalid signatures. For multi-contributor manifests, each listed party signs to acknowledge their declared role and share — a manifest owner cannot declare a contributor's share without that contributor's cryptographic acknowledgment.

For automated settlement (agents acting on behalf of humans or businesses), agent DIDs sign with their own derived keypair. The derivation path encodes what the agent is authorized to attribute. An agent key derived with scope `[attribution:collaborator]` cannot produce a valid signature claiming `[attribution:creator]`. Authority is cryptographically enforced through key derivation scope, not through runtime permission checks.

#### Attribution Follows the Identity Graph

Attribution chains are typed by identity scope:

- A .fair manifest from an **Actor** credits a person.
- A .fair manifest from a **Community** DID credits a collective — with internal splits governed by the collective's own governance model, weighted by contribution history.
- A .fair manifest from a **Business** credits a structured entity — with employee contributions visible in the chain, flowing through the corporate delegation hierarchy.

When a track gets sampled, the .fair chain settles automatically. When an AI model trains on consented data, attribution flows through the graph to every contributor. The attribution system doesn't need special logic for each identity type — it follows the identity graph.

#### Consent Is Embedded

Consent is not a separate primitive in v0.3. It is woven through Attribution and Attestation — because consent without attribution is unenforceable, and attribution without consent is theft.

Every .fair manifest includes machine-readable consent declarations: what the creator permits, under what conditions, at what price. Consent is explicit, versioned, and cryptographically signed. It cannot be implied, assumed, or buried in terms of service.

Consent semantics vary by identity scope:
- An **Actor** consents for themselves.
- A **Family** may carry custodial consent — encoding the custodial relationship cryptographically.
- A **Community**'s consent requires quorum attestation from governing members.
- A **Business**'s consent flows through its delegation hierarchy.

### 4. Settlement — Value Flows Through the Graph

Every MJN exchange that carries value includes a settlement instruction: who gets paid, in what proportion, through what mechanism, on what trigger.

Settlement follows the identity graph. When a consumer pays for work attributed to a Community DID, the settlement instruction splits according to the collective's .fair manifest — which itself reflects the governance-weighted contribution history of the members. Value flows through the graph to the Actor DIDs who actually did the work. The Business that sponsored the collective receives its declared share.

There is no platform in the middle. Value flows directly from the party consuming to the parties who created.

#### The MJN Token

Reserve-backed utility token. Dual-currency — every transaction settles in fiat OR MJN. Nobody is forced into crypto.

- Mint on fiat deposit, burn on fiat withdrawal. 1:1 reserve backing.
- Solana transaction cost ≈ $0.001. Every .fair split settles in the same transaction.
- Lower fees than Stripe. Instant settlement. Atomic .fair splits.
- Per-scope governance: Actor = simple keypair signing, Family = multi-signature, Community = quorum-signed, Business = delegation chain.

The token is the settlement currency of the protocol. It is not a speculative asset — it is the mechanism by which value moves through the network's attribution chains. Token holders hold a claim on the economic activity of a protocol — the same structural relationship a clearinghouse shareholder has to the transactions it settles.

Token issuance is governed by the MJN Foundation under Swiss FINMA guidelines. Token economics are designed for stability at the settlement layer, not volatility at the speculative layer.

#### The Declared-Intent Marketplace

Your attention is worth $272/year to Meta. You get $0.

MJN inverts this completely. Your attention profile lives on your node. It never leaves. Companies pay to match your declared interests. You set the price. You keep the revenue. You revoke access anytime.

**How it works:**

1. You declare interest categories locally on your node: `['specialty coffee', 'live music', 'vinyl records']`
2. A Business broadcasts an offer to opted-in users via gas tiers
3. Matching happens locally — your node evaluates the match. Your profile never leaves.
4. The Business receives an aggregate match count only: "Your offer matched 47 users in your Tier 2 reach"
5. You receive the offer. You get paid for your attention.

**The Business never receives:** which users matched, any user profile data, or correlated attributes. The profile genuinely stays on your node.

#### Gas-Gated Reach: Width and Depth

The three-tier gas model gates reach by graph distance (width):

| Tier | Reach | Gas Cost |
|------|-------|----------|
| Tier 1 | Trust graph connections | Free / near-free |
| Tier 2 | Declared interest pool, matched | Medium gas |
| Tier 3 | Extended reach, opted-in | High gas |

Trust-graph position cannot be purchased. Connections require person-to-person acceptance — a social act that cannot be transacted.

**Frequency-scaled gas** gates reach by depth. The door can't be bought, but without depth gating, it can be knocked on constantly by the highest bidder. Gas cost to reach the same person scales exponentially with recency:

| Message # in 30-day window | Multiplier | Signal |
|---------------------------|------------|--------|
| 1st message | 1.0× | Normal commercial reach |
| 2nd message | 1.5× | Acknowledged recency |
| 3rd message | 3.0× | Business makes a choice |
| 4th message | 7.0× | Only high-value categories justify this |
| 5th message | 15.0× | Saturation price |
| 6th+ message | 40.0× | Prohibitive for virtually all business models |

Businesses calibrate naturally to the cost curve. No governance body needs to maintain a hard cap. The gas pool that subsidizes MJN transactions is partially funded by saturation attempts — the platform benefits from deterring saturation, not enabling it.

**Cluster-aware computation** prevents coordination gaming. If multiple Businesses sharing a founding Actor DID alternate messages to circumvent per-sender limits, the frequency curve applies to the cluster, not just individual senders. The founding Actor DID's standing is at stake across all their Businesses. Coordination has a real cost.

**User sovereignty overlay:** Users can set personal rate limits, whitelist specific Businesses for unrestricted reach, or permanently blacklist any Business. The default state — frequency-scaled gas, no whitelist, no blacklist — is the low-effort, well-protected baseline.

$272 is Meta's ceiling. On MJN, attention is the floor.

#### Declaration Granularity and Privacy

The anti-surveillance promise holds only if local matching actually prevents inference — not just direct profile access. A fine-grained declaration system that enables match-count probing to reconstruct a behavioral profile is functionally equivalent to a surveillance profile, even if it technically stays on the user's node.

MJN enforces k-anonymity at the matching layer. If a declaration matches fewer than k users in the opted-in pool, the match count is suppressed — returned as zero. The business learns "fewer than k users matched," nothing more.

```
function match_count(offer, opted_in_pool, k = 5):
  raw_matches = users matching offer.category in opted_in_pool
  if count(raw_matches) < k:
    return 0          // suppressed: too specific for this pool
  return count(raw_matches)
```

Sensitive categories carry higher k thresholds: location (k=15), demographics (k=15), health (k=20), temporal patterns (k=10). Users can declare at any granularity they choose — the matching layer enforces the privacy guarantee through mathematics, not vocabulary restriction.

Declarations are signed by the declaring DID's keypair. A node operator cannot silently modify your declarations to alter matching behavior. Tampered declarations have invalid signatures. Your declarations are portable, tamper-evident, and yours.

### 5. Discovery — Federated Registry and Portable Context

Discovery on MJN is how entities find each other, prove their history, and make their expertise queryable — all without a centralized directory that becomes a control point.

#### Federated Registry

Every node on the MJN network is a sovereign instance. Nodes discover each other through a federated registry — no central server required. Each node announces its presence, its operators, and the scopes of identity it serves. The registry is queryable: find nodes by geography, by community affiliation, by expertise domain.

#### Trust-Gated Presence

A knowledge leader — a doctor, a lawyer, a developer, a community elder — operates a node. Their node carries their body of work, their trust graph, their consent terms, and their inference pricing.

Only people in their trust graph can query their presence. The querier's DID is verified. The trust relationship is checked — not just "are you connected?" but "what type of connection, at what trust depth, through which identity scopes?" A query routed through a Community DID the expert belongs to may have different consent terms than a direct Actor-to-Actor query.

The response is signed by the expert's DID. The .fair manifest attributes it. Settlement executes — inference fee flows to the expert. The querier gets an answer from someone they trust, not an algorithm. The expert gets compensated without being available 24/7 — their presence handles it.

Scale this up: every person with expertise runs a node. Leadership emerges from who gets queried most — not who games an algorithm, but who earns actual trust, measured in actual payments, from actual relationships in the graph.

#### Portable Context on Exit

When an Actor leaves a node, they receive a signed, encrypted exit credential — a portable summary of their attestation history on that node. This is not a data dump. It is a privacy-preserving, presenter-controlled artifact.

**Two layers:**

1. **Public summary layer** — aggregate facts legible to any receiving node: tier reached, attestation count by type, normalized trust score, duration of membership. No individual relationship data. Enough for a receiving node to make a trust-seeding decision.

2. **Encrypted context layer** — the full attestation history, encrypted under the departing Actor's public key. The originating node cannot read this after issuance. The Actor chooses if and when to present it to a new node. Presenter-controlled.

The exit credential is a signed summary of already-signed records. Its integrity is end-to-end provable because every attestation in the underlying history was cryptographically signed at the moment it occurred. This is not attestation-laundering — converting unsigned history into a signed artifact at the last moment. The signing starts at onboarding and never stops.

**Departure types matter:**

| Departure Type | Context | Trust-Seeding Signal |
|----------------|---------|---------------------|
| Voluntary | Member chose to leave | Neutral — full context preserved |
| Inactivity | Removed for sustained absence | Soft signal — throttled trust growth at new node |
| Community dissolution | Node shut down | Neutral — not the member's choice |
| Behavioral | Removed for conduct violation | Flag category included — no narrative detail |

The exit credential makes leaving cheap. Your reputation, your relationships, your history — they follow your keypair, not their database. The BBS model rebuilt — except now you take your posts with you when you leave.

---

## The Typed Identity Graph

The same trust graph connects all four scope types. The structural insight: the graph is one data structure, but the scope at the center of the query determines what the graph means.

### Query from an Actor:

```
          Community DID (member of)
              ↑
   Actor → Family (belongs to)
              ↓
          Business DID (employed by)
```

The Actor sees their connections, the events they attended, the communities they participate in, the organizations they work for. The graph radiates outward from a person. This is the familiar social model — but with typed relationships instead of a flat friends list.

### Query from a Community DID:

```
              Actor (governing member, weight: 0.3)
                  ↑
Community DID → Actor (active member, weight: 0.15)
                  ↓
              Actor (participant, weight: 0.05)
                  ↓
              Business DID (sponsor, observer tier)
```

The Community DID sees its membership tiers, governance weights, contribution history, shared creative output, and the businesses that orbit it. The same graph, but the query shape is entirely different — it reveals the internal structure of a collective.

### Query from a Family:

```
              Actor (parent, custodial authority)
                  ↑
Family DID → Actor (child, limited authority)
                  ↓
              Business DID (family business)
                  ↓
              Community DID (community membership)
```

The Family sees shared resources, custodial relationships, emergency contacts, healthcare proxies — the most intimate trust boundary in the system. The graph reveals what no other query can: who has authority over shared decisions.

### Query from a Business:

```
              Actor (founder, admin)
                  ↑
Business DID → Actor (employee, scoped)
                  ↓
              Community DID (scene participant, observer)
                  ↓
              Business DID (partner, vendor)
```

The Business sees its hierarchy, delegated authorities, business relationships, and the communities it participates in. The graph reveals operational structure.

**Why this matters:** The same graph, queried from different scopes, yields fundamentally different shapes. This is not a feature. It is the architecture.

---

## The Matrix at Human Scale

**Jin** is an AgentActor with a DID. Jin hosts a party. Tickets are Settlement — each purchase creates a trust relationship. The LED cubes are DeviceActors responding to verified presence. Next party: no Eventbrite — just a ping to the trust graph.

**The freelancer** has five years of reviews across three platforms. None travels. With MJN: every attestation on her DID, signed by the client. Her reputation follows her keypair. The platform can die. Her credentials don't.

**The studio** runs classes, pays instructors, manages a community. Four platforms, four fees, four data silos. With MJN: one Business node. Settlement below Stripe. Attribution automatic. The community is an asset the studio owns, not a list it rents.

---

## The Matrix at Industry Scale

### Education — $6T Receipt for Time Served

The credential doesn't prove competence — it proves you sat in a room. The door gets more expensive every year while what's behind it gets less valuable.

Domain knowledge — thirty years of pattern recognition, judgment no model can replicate — is the last defensible asset on earth. The people who have the most of it are getting paid the least.

**With the matrix:** The course is a Community DID. Enrollment is an attestation. Completion is a credential the instructor issues — signed, portable, hers to give. Settlement direct. No platform taking 30%. The student's skill attestations travel with their Actor DID forever — not locked in a university's database.

### Music — The Relationship Was Always the Product

Music started as someone in the room with you. The griot. The troubadour. The DJ who knew which record belonged to this room on this night.

Now: $0.003 per stream. The artist's relationship with their audience owned by a platform. Discovery controlled by an algorithm with no skin in the game.

**With the matrix:** Catalog on the artist's node. Each track a DID with .fair attribution — every contributor signed and credited. Fan's ticket purchase creates a trust relationship, not a transaction that disappears. When a track gets sampled, the .fair chain settles automatically. The relationship is the product again.

### Journalism — The Press Isn't Free. It's Owned.

The beat reporter covering city hall for thirty years wasn't producing content. They were accumulating a relationship with a place. The platform destroyed it because the platform owns discovery.

**With the matrix:** Sources are trust-weighted attestations. Twenty years of beat reporting is a sovereign catalogue — not an institutional asset that dies with the newsroom. Readers subscribe through Settlement directly. Discovery routes through the trust graph, not an algorithm optimizing for outrage. Every reproduction carries the .fair manifest. Every inference pays the journalist. The platform syndicating it earns a routing fee. The journalist earns the rest.

### Advertising — The Consent Was Stolen

The ad industry isn't dying because ads are bad. It's dying because the consent was stolen.

The value was never the impression. It was the vouching. The neighbour who told you which mechanic not to use. Trust transferred through a relationship. The industry replaced the vouch with the eyeball, then the dopamine casino. Ad-blocking is the most widely adopted software in human history.

**With the matrix:** User declares interests on their node. Declaration never leaves. Business pays to match — not target. User sets the price, keeps the revenue, revokes anytime. A real person who said yes.

### AI Training Markets

The Chinese labs that ran 16 million fraudulent exchanges against Claude in early 2026 were not criminals seeking to do harm. They were engineers solving a real problem: how do you train a frontier model when the best training data is locked behind a competitor's terms of service?

MJN makes the legitimate version possible. A creator publishes work with a .fair manifest that includes training consent terms and a price. An AI lab queries the work through MJN. The consent declaration executes. The settlement instruction pays the creator. The lab gets training data. Nobody committed fraud. The creator got paid. The distillation attack becomes a distillation *market*.

A Community DID representing an open-source project can set collective consent terms for training on the project's output — with settlement flowing to contributors proportional to their .fair shares. A Business can license its employee-created content with consent flowing through the corporate delegation hierarchy. The consent and settlement layers don't need special cases — they follow the identity graph.

---

## This Is Not a Concept

37 days. Working infrastructure. Real users.

- **14 live services**, self-hosted on owned hardware
- **73 registered identities** (25 hard DIDs, 48 soft DIDs)
- Real events with real ticket sales
- First external contributor: Staff Engineer at Slack
- MJN token reserved on Solana mainnet
- GPU node running local inference

**The thesis is published.** 30 essays — 9 live. Thesis coherence protected by being published, not patented.

**COCOMO II estimate:** $1.67M, 14.8 months, 6-person team.
**Actual:** $1,793 in API costs. 210 human hours. 37 days. AI-augmented development — one person with architectural clarity and the right tooling.

98 scoped tickets ahead — worth another $604K traditionally. At current pace, weeks not months.

### Day 37: The Protocol Discovered Itself

We chose Ed25519 on Day 3 — the right cryptographic primitive for sovereign keypairs. Solana was always on the horizon for settlement.

What we didn't know: it was already done.

Every DID we'd generated was already a valid Solana wallet. Every backup file our users downloaded was already a wallet private key. No integration. No bridge. No derivation.

The protocol wasn't designed. It was excavated.

---

## Revenue

Five revenue streams. Revenue from day one. No critical mass required.

| Stream | How It Works |
|--------|-------------|
| **Settlement fees** | Protocol percentage on every transaction. Every .fair split, every ticket sale, every settlement. |
| **Declared-intent marketplace** | Your attention, your price, your revenue. Gas fees from businesses matching declared interests. |
| **Headless service settlement** | Machine-to-machine. Every API call is a revenue event. Agent-to-agent settlement via signed .fair manifests. |
| **.fair attribution** | Every derivative work settles back through the chain. Sampling, training, syndication — automatic. |
| **Trust graph queries** | Domain expertise as queryable infrastructure. Inference fees flow to the expert. No ceiling. |

---

## Sovereignty Is a Spectrum

Not everyone runs a server. That's the point.

| Tier | What It Means | Cost |
|------|--------------|------|
| **Tier 1** | Use someone else's node. Trust your operator. Data always portable. | Free |
| **Tier 2** | Run your own node (cloud). You hold the keys. | ~$5/mo VPS |
| **Tier 3** | Run your own node (hardware). Raspberry Pi. Full sovereignty. | ~$50 one-time |
| **Tier 4** | Run a community or business node. Serve your neighborhood. Earn from every settlement. | Varies |

The BBS model rebuilt — except now you take your posts with you when you leave.

---

## Governance

MJN is governed by the **MJN Foundation**, a Swiss *Stiftung* incorporated in Switzerland. The Foundation owns the protocol specification, the reference implementation, and the token treasury. It does not own implementations.

**Foundation mandate**: Maintain MJN as open, neutral, non-extractive infrastructure. Any entity may implement the protocol. No entity may capture it.

```
MJN Foundation (Switzerland)
├── Protocol specification + RFC process
├── Token treasury + FINMA compliance
├── Reference implementation (imajin.ai)
│
├── Technical Council
│   └── Protocol development, interoperability
│
├── Operator Registry
│   └── Node certification, compliance
│
└── Ryan Veteze (b0b) — Lead Protocol Architect [contractor, via Imajin Inc.]
```

The Foundation is explicitly structured to be capturable by neither US nor Chinese regulatory pressure. Sovereign infrastructure requires sovereign governance. Switzerland's neutrality is not incidental — it is architectural.

The name *今人* draws from Japanese. The protocol is built by a Canadian. It will be governed from Switzerland. It is designed for the world. This is not a Western protocol imposing Silicon Valley architecture, nor an Eastern one. It belongs to the now persons who use it.

**Imajin Inc.** (Canadian corporation) operates imajin.ai as the reference implementation and first node operator. It is one implementer among many, not the owner of the protocol. The Foundation contracts Imajin Inc. for protocol development; the protocol itself belongs to the Foundation.

---

## Our Position

No Solana project has a trust-gated social layer. No social network has an embedded settlement layer. No identity system has typed actor primitives with per-scope governance. We have all three — and they're the same thing.

One protocol where the integration is the product. Value compounds with every actor, every transaction, every node.

| Analogue | What They Invested In | Outcome |
|----------|----------------------|---------|
| Visa (1970) | Payment rail between banks | $500B, $15T/year volume |
| Stripe (2011) | Developer payment API | $95B, $1T/year volume |
| Cloudflare (2009) | Internet infrastructure | $35B, 20%+ of web traffic |
| Imajin (2026) | Identity + trust + settlement protocol | You are here |

Open source. Self-hostable. Federated. No kill switch.

---

## Market Projection

### The Thesis

HTTP replaced Gopher. TCP/IP replaced competing network protocols. The web replaced the BBS. Each time, the better infrastructure layer didn't compete with what came before — it made it obsolete by becoming the substrate everything else ran on.

MJN's proposition is the same: not a better website, not a better app, not a better platform. A better protocol. One that carries what HTTP never could — identity, attribution, consent, and value — natively, in every exchange.

The web as we know it is a document delivery system. MJN is a presence and intelligence delivery system. When you query a node, you're not retrieving a page. You're querying a now person — their thinking, their expertise, their creative catalogue — and value flows back to them automatically.

Generative AI models didn't just influence search behavior in 2025 — they actually began replacing it, becoming the first stop for information for billions of users. The document web is already dying. The question is what protocol the intelligence web runs on.

### The Numbers

**The substrate MJN replaces:**

The digital economy represents approximately $16 trillion of global GDP today, projected to capture 17% of global GDP by 2028. Every dollar flows through identity, attribution, and payment infrastructure. None of that infrastructure is currently sovereign. All of it currently extracts.

**The users:**

More than 240 million people came online in 2025, bringing the total to six billion. Each has an identity currently owned by a platform. Each creates value currently captured by a platform. Each deserves a node.

**The immediate market — decentralized identity:**

The global decentralized identity market was estimated at $3 billion in 2025, projected to reach $623 billion by 2035 at a CAGR of 70.8%. MJN is not a player in this market. MJN is the protocol this market runs on.

**The typed identity advantage:**

The decentralized identity market today treats identity as a monolith — individual wallets, individual credentials. MJN's typed scopes address the 80% of human economic activity that doesn't happen as isolated individuals: families sharing resources, communities governing creative output, businesses delegating authority. No competing protocol encodes these relationship types at the identity layer.

**The protocol fee model:**

MJN itself charges nothing. Protocols don't charge. But the MJN token is the settlement currency for every exchange on the network. Token velocity equals total economic activity flowing through MJN settlement.

| Scenario | Annual Token Velocity |
|----------|----------------------|
| 1% of digital identity market settles via MJN (2030) | ~$2B |
| AI training data market at full consent model | ~$10-50B |
| 1% of global digital economy flows through MJN settlement | ~$160B |
| MJN becomes primary internet presence layer (2035) | ~$1-5T |

**The AI training market alone:**

The distillation attacks of early 2026 demonstrated that frontier AI labs will pay — or steal — to access human-generated intelligence at scale. 16 million exchanges at market rate for consented training data represents hundreds of millions of dollars in annual spend from three labs alone. There are hundreds of labs. There are billions of humans whose creative output could flow through a consented attribution market.

**The compounding effect:**

Each now person who joins deepens the value of every other node. A journalist's twenty years of beat reporting becomes more valuable as more readers query it. A musician's catalogue earns more as the trust graph routes more discovery through it. This is the opposite of platform economics where value accumulates at the center. On MJN, value accumulates at the edges — at the nodes — because that's where the now persons are.

The typed identity model compounds this further. A Community DID representing a music scene doesn't just aggregate individual value — it creates emergent value that no individual member could generate alone. The scene's collective reputation, its curated output, its governance-weighted creative decisions — these are properties of the collective identity, not sums of individual identities. The network effect operates at every scope level: individuals strengthen families, families strengthen communities, communities strengthen the businesses that serve them.

### The Honest Framing

We are not projecting that MJN captures the digital economy. We are observing that if MJN becomes the protocol layer for sovereign human presence on the internet — the way HTTP became the protocol layer for documents — then the token that settles every exchange on that protocol participates in the economic activity of the entire network.

TCP/IP doesn't charge. But Cisco built a $200 billion company selling the infrastructure that runs TCP/IP. Stripe doesn't own the money — but it processes $1 trillion in annual payment volume by being the best implementation of the payment layer.

MJN's analogues are protocol authors and infrastructure builders, not platform operators. The Foundation governs the standard. imajin.ai is the first reference implementation. Early token holders participate in the settlement layer of a protocol designed to become public infrastructure.

The SAM for 2026-2027 is honest and achievable: AI training data consent market, platform identity integration fees, and settlement for the first node operators. That is a $50-100M revenue opportunity that proves the protocol before the TAM conversation becomes relevant.

The TAM, if the protocol works as designed, is the digital economy itself.

---

## Go-to-Market

The go-to-market is physical. One node, one community, one city at a time.

- **Phase 1** — 10 seed nodes: Toronto ×3, Berlin, Cape Town, New York, Vancouver, Portland, Tokyo, Melbourne.
- **Phase 2** — Clusters. Each node becomes a gravity well. Events as mass onboarding.
- **Phase 3** — Protocol API. Imajin becomes the identity and trust layer underneath. Each new node increases discovery and settlement volume for every existing node. Open source means the protocol spreads without a sales team.

---

## Roadmap

| Period | Milestone |
|--------|-----------|
| Q1 2026 | Protocol v0.1 specification · v0.2 typed identity model · v0.3 scopes × primitives matrix · MJN Foundation incorporation · April 1st: first party on MJN infrastructure (imajin.ai reference implementation) |
| Q2 2026 | Attestation data layer live · .fair cryptographic signing enforcement · Token structure and FINMA engagement · API SDK release · First platform integration conversations · Community DID and Business DID reference implementations |
| Q3 2026 | Foundation seed raise · First non-imajin node operators · Agent gateway — trust-gated inference routing · Federation between sovereign nodes · Exit credential (portable context) implementation |
| Q4 2026 | MJN v1.0 specification · Declared-intent marketplace (Stream 2) with k-anonymity enforcement · First cross-platform .fair settlement · Open RFC process launched · Family DID reference implementation · Global node tour (10 nodes) |

---

## The Thesis

The internet was built to move documents. Then packets. Neither carried the human.

Platforms filled the gap — and captured everything.

Imajin carries the human. Identity, trust, attribution, settlement — all in one protocol. For humans and agents alike.

Start from the human and you will find the protocol.

---

The infrastructure argument is settled by history. Every communication technology that became essential became public infrastructure. The telegraph. The telephone. The electrical grid. The internet itself.

Identity and payments are next. The arc is the same. The conclusion will be the same.

The only question is whether anyone builds for the destination from the start — before the capture, before the extraction, before the decades of fighting to reclaim what should have been public infrastructure in the first place.

MJN is that attempt.

Open by architecture. Sovereign by design. Non-extractive by the structure of the protocol itself.

The internet never had a native layer for identity, attribution, consent, or value.

It does now.

And at the center of every node on this network is a 今人 — a now person. Present. Real. Sovereign. Here.

That is what the internet always should have been built around. Not the machine. Not the platform. Not the algorithm.

The person. Now.

---

*— Ryan Veteze (b0b), Protocol Author*
*ryan@imajin.ai · imajin.ai · github.com/ima-jin/imajin-ai*

---

**Links**
- Protocol spec: github.com/ima-jin/imajin-ai
- Reference implementation: imajin.ai
- Foundation: [TBD — Swiss Stiftung, Q1 2026]
- First demonstration: April 1st, 2026

---

## Changelog

### v0.3 (March 2026)
- **Scopes × Primitives Matrix:** Complete structural rewrite. The protocol is now organized around four identity scopes (Actor, Family, Community, Business) × five primitives (Attestation, Communication, Attribution, Settlement, Discovery). Every problem the protocol solves is a cell in this matrix.
- **Naming clarifications:** Individual → Actor (covers humans, agents, AND devices). Cultural → Community. Org → Business. The old four protocol primitives (DID, .fair, Consent, Settlement) replaced by five primitives.
- **Actor subtypes:** HumanActor, AgentActor, DeviceActor — same keypairs, same DIDs, same trust graph, same .fair attribution. Agent accountability is structural, not bolted on.
- **Attestation Data Layer:** New foundational section. Every trust-relevant act is a cryptographically signed record from the moment it occurs. Schema specified. Controlled type vocabulary defined. Verification gate at ingestion — unsigned attestations rejected at write.
- **Progressive Trust Model:** Three standing levels (Visitor/Resident/Host). Standing computed from attestation history, not assigned. Vouch chain accountability.
- **Cryptographic signing end-to-end:** .fair manifests must be signed. Attestations must be signed. Declarations must be signed. Everything that moves through the protocol carries cryptographic proof of authorization. Unsigned = untrusted.
- **Portable Context on Exit:** Exit credential replaces ad-hoc data export. Privacy-preserving, presenter-controlled. Two layers: public summary for trust-seeding, encrypted context under departing Actor's key. Built on already-signed attestation records — integrity is end-to-end provable.
- **Business DID architecture:** Non-severable founding anchor. Covenant as behavioral checklist, not values test. Soft-loading cold-start inversion. Composite Attestation Model for founding-cohort capture resistance.
- **Declared-Intent Marketplace:** Full specification. Local matching (profile never leaves node). Frequency-scaled gas for depth gating. Cluster-aware computation to prevent coordination gaming. User sovereignty overlay.
- **Declaration Granularity:** k-anonymity threshold enforcement. Sensitive category floors. Signed declarations. Inference attack resistance specified.
- **Consent embedded:** Consent is no longer a standalone primitive. It is woven through Attribution and Attestation — because consent without attribution is unenforceable, and attribution without consent is theft.
- **Revenue streams:** Five streams specified. Revenue from day one, no critical mass required.
- **Sovereignty spectrum:** Four tiers from free hosted to full hardware sovereignty.
- **Industry applications expanded:** Education, music, journalism, advertising, AI training markets — each mapped to the scopes × primitives matrix.
- **"This is not a concept" section:** 14 services, 37 days, $1,793, real users.
- **Integrated Greg's architectural review series** (8 documents): attestation data layer, cryptographic trust layer, .fair attribution integrity, identity tier storage, portable context (exit credentials), Org DID vetting and early-member influence, gas model ceiling, declaration granularity standards.

### v0.2 (March 2026)
- **Typed Identity Primitives:** Identity section expanded from flat DID concept to four first-class primitive types (Individual, Family, Cultural, Org) with distinct governance models, trust semantics, and visibility defaults.
- **Typed Identity Graph:** New section showing how the same trust graph yields fundamentally different query shapes depending on which primitive type is at the center.
- **Attribution integration:** .fair manifests now typed by identity primitive — collective attribution, corporate attribution, and individual attribution follow different governance paths through the same system.
- **Consent semantics:** Consent declarations now respect identity governance — individual autonomy, custodial consent, quorum consent, delegated consent.
- **Settlement follows the graph:** Settlement instructions trace through the identity graph to reach the Individual DIDs who did the work, regardless of which primitive type initiated the exchange.
- **Trust-Gated Presence:** New reference implementation section demonstrating typed trust queries.
- **Market projection update:** Typed identity advantage section added — the TAM for sovereign identity that serves families, communities, and organizations, not just individuals.
- **Roadmap updated** with typed primitive implementation milestones.

### v0.1 (February 2026)
- Initial protocol specification.
