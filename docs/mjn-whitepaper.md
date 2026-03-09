# MJN
## The iMaJiN Network Protocol
### Identity · Attribution · Settlement · Presence

**今人 — ima jin — "now person"**

**Protocol Specification v0.2 · March 2026 · DRAFT**

*Ryan Veteze (b0b) · ryan@imajin.ai · imajin.ai · github.com/ima-jin/imajin-ai*

---

> HTTP moved documents. TCP/IP moved packets. Neither carried identity, attribution, consent, or value. MJN carries all four — natively, at the protocol layer.

---

## Abstract

*今人 (ima jin)* is Japanese for "now person." Present. Real. Here. A sovereign human being in this moment.

The internet was built to move information between machines. It was not built to carry people. Somewhere in the thirty years between the first web browser and the current AI moment, the actual human — present, real, accountable — was replaced by a profile owned by a platform, an account that could be revoked, an identity that belonged to someone else.

MJN restores the now person to the network.

MJN is an open application-layer protocol that extends the existing internet stack with four capabilities the web was never designed to carry: sovereign identity, creative attribution, programmable consent, and automated value settlement.

Like HTTP, MJN runs over TCP/IP and is transport-agnostic. Unlike HTTP, every MJN exchange carries a verified sender identity (DID), an attribution manifest (.fair), a consent declaration, and a settlement instruction. These are not optional headers — they are the protocol. They are what it means to be a now person on the network.

MJN is governed by the MJN Foundation, a Swiss Stiftung. The protocol is open source. No entity owns it. Any implementation is a valid node. The name itself — drawing from Japanese, built by a Canadian, governed from Switzerland, designed for the world — is not incidental. Sovereign infrastructure has no nationality. Neither does 今人.

---

## The Problem

The internet stack was designed to move information reliably between machines. It was not designed to answer four questions that every human exchange on the internet implicitly raises:

| Question | Current Answer |
|----------|---------------|
| Who is actually sending this? | Nobody knows. Email is spoofable. Accounts are fake. Identity is platform-issued and platform-revocable. |
| Whose creative work is in this? | Unknown. Attribution lives in external databases controlled by platforms, labels, and rights systems with private interests. |
| Did the creator consent to this use? | Implied, assumed, or buried in terms of service nobody reads. Consent is extracted, not given. |
| Who gets paid when value moves? | Whoever owns the rails. Platforms extract a percentage from every exchange for being in the way. |

The consequences are measured in trillions of dollars extracted from the humans who create value, and in the systematic destruction of trust infrastructure that functioning societies depend on.

Three recent events made the cost undeniable:

- **February 2026**: Anthropic and OpenAI publicly accused DeepSeek, Moonshot, and MiniMax of running industrial-scale distillation attacks — 16 million fraudulent exchanges — to extract frontier model capabilities with no compensation to the humans whose work trained those models.
- **The local journalism collapse**: A decade-long erosion of accountability infrastructure because no economic model existed to sustain direct community relationships between journalists and the people they serve.
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

---

### Four Protocol Primitives

#### 1. DID — Sovereign Identity

Every MJN node has a Decentralized Identifier (DID). DIDs are cryptographically self-sovereign — not issued by platforms, not revocable by third parties, not tied to any single infrastructure provider. A DID proves you are who you say you are without asking anyone's permission.

MJN DIDs are compatible with the W3C DID Core specification. They are portable across all implementations.

```
did:mjn:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

##### Typed Identity Primitives

MJN does not treat identity as a flat concept. A DID is always one of four typed primitives, each encoding a fundamentally different kind of entity with different trust semantics, governance models, and graph behavior:

**Individual** — the person. The atomic unit of identity. A human being with a keypair, a body, a presence.

- Self-sovereign: generated, not issued
- Governance: individual autonomy
- Entry: invitation from existing trust graph
- Default visibility: private — you control what others see
- The foundation everything else is built from

**Family** — intimate trust. Biological or chosen. The smallest unit of shared identity.

- Formed by mutual attestation between Individual DIDs
- Governance: consensus among members
- Entry: invitation + acceptance by existing members
- Default visibility: private interior, shared exterior
- Shared resources: custody, finance, healthcare decisions, emergency access
- The trust boundary where privacy is structurally different — members share context that no external party can access

**Cultural** — communities of practice. Art collectives, music scenes, mutual aid networks, open-source projects, festival communities. Entities defined by shared practice rather than legal structure.

- Formed by quorum: minimum founding Individual DIDs with demonstrated participation history
- Governance: trust-weighted — contribution history (.fair), activity recency, and attestation weight determine authority
- Entry: formation threshold + demonstrated participation (a performance qualifier, not a financial barrier)
- Membership: fluid and tiered (governing, active, participant, observer)
- Default visibility: public face, private interior — the world sees the identity and output; membership roster stays internal
- No single Individual DID can hold unilateral control — structural anti-capture
- Profit motive structurally excluded — this is not a business, it's a practice

**Org** — businesses and legal entities. Incorporated, registered, with named founders and optionally a profit motive.

- Formed by declaration from one or more founding Individual DIDs
- Governance: founder-anchored hierarchy with delegated roles
- Entry: vetting + covenant alignment
- Membership: fixed (employees, partners, with scoped permissions)
- Default visibility: public by default — name, category, output, aggregate transactions
- Can receive reviews, issue .fair manifests on products, hold balances, transact
- Can be soft-loaded: community-built from check-in and transaction data before the owner claims it

##### Structural Comparison

| Property | Individual | Family | Cultural | Org |
|----------|-----------|--------|----------|-----|
| Default visibility | Private | Private interior | Public face, private interior | Public |
| Governance | Individual | Consensus | Trust-weighted quorum | Founder-anchored |
| Entry condition | Invitation | Mutual attestation | Quorum + participation threshold | Declaration + covenant |
| Membership | Singular | Intimate, stable | Fluid, tiered | Fixed, role-scoped |
| Profit motive | N/A | N/A | Structurally excluded | Allowed |
| Can hold funds | Yes | Yes (shared) | Yes (quorum-signed) | Yes |

These are not access tiers. They are not permission levels. They are fundamentally different kinds of entities in the world, and the protocol treats them as such. A music collective is not a business that hasn't incorporated yet. A family is not a group chat with special permissions. The protocol knows the difference because the identity type carries it.

##### The Typed Identity Graph

The same trust graph connects all four primitive types. The structural insight: the graph is one data structure, but the primitive type at the center of the query determines what the graph means.

**Query from an Individual:**
```
          Cultural DID (member of)
              ↑
Individual → Family (belongs to)
              ↓
          Org DID (employed by)
```
The Individual sees their connections, the events they attended, the communities they participate in, the organizations they work for. The graph radiates outward from a person. This is the familiar social model — but with typed relationships instead of a flat friends list.

**Query from a Cultural DID:**
```
              Individual (governing member, weight: 0.3)
                  ↑
Cultural DID → Individual (active member, weight: 0.15)
                  ↓
              Individual (participant, weight: 0.05)
                  ↓
              Org DID (sponsor, observer tier)
```
The Cultural DID sees its membership tiers, governance weights, contribution history, shared creative output, and the businesses that orbit it. The same graph, but the query shape is entirely different — it reveals the internal structure of a collective.

**Query from a Family:**
```
              Individual (parent, custodial authority)
                  ↑
Family DID → Individual (child, limited authority)
                  ↓
              Org DID (family business)
                  ↓
              Cultural DID (community membership)
```
The Family sees shared resources, custodial relationships, emergency contacts, healthcare proxies — the most intimate trust boundary in the system. The graph reveals what no other query can: who has authority over shared decisions.

**Query from an Org:**
```
              Individual (founder, admin)
                  ↑
Org DID    → Individual (employee, scoped)
                  ↓
              Cultural DID (scene participant, observer)
                  ↓
              Org DID (partner, vendor)
```
The Org sees its hierarchy, delegated authorities, business relationships, and the communities it participates in. The graph reveals operational structure.

**Why this matters:** Every identity system in production today treats identity as a flat concept — an "account" with permissions attached after the fact. Google, Apple, Meta, even the W3C DID specification itself — all model identity as one type. They handle the differences in application logic, not at the identity layer.

MJN encodes the type at the protocol level. This means trust relationships, governance models, and privacy boundaries are structural — they cannot be bypassed by application code because they are properties of the identity itself, not policies applied to it.

The same graph, queried from different primitive types, yields fundamentally different shapes. This is not a feature. It is the architecture.

#### 2. .fair — Attribution Manifest

Every piece of creative work that moves through the MJN network carries a `.fair` manifest: a cryptographically signed document embedded in the work itself — not in a platform database — that records the complete chain of human creative labor that produced it.

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
  "signature": "..."
}
```

Attribution chains are typed by the identity primitives. A .fair manifest from an Individual credits a person. A .fair manifest from a Cultural DID credits a collective — with internal splits governed by the collective's own governance model. A .fair manifest from an Org credits a business entity, with employee contributions visible in the chain. The attribution system inherits the identity graph's structure.

#### 3. Consent Declaration

Every MJN exchange includes a machine-readable consent declaration: what the sender permits the receiver to do with the content of this exchange. Consent is explicit, versioned, and cryptographically signed. It cannot be implied, assumed, or buried in terms of service.

Consent declarations execute automatically via the settlement layer when their conditions are met. No platform required to enforce them. No legal dispute needed to trigger them.

Consent semantics vary by identity type. An Individual consents for themselves. A Family DID may carry custodial consent — a parent consenting on behalf of a minor, with the consent declaration encoding the custodial relationship. A Cultural DID's consent requires quorum attestation from governing members. An Org's consent flows through its delegation hierarchy. The consent primitive respects the governance model of the identity that signs it.

#### 4. Settlement Instruction

Every MJN exchange that carries value includes a settlement instruction: who gets paid, in what proportion, through what mechanism, on what trigger. Settlement executes automatically via the MJN token layer. There is no platform in the middle. Value flows directly from the party consuming to the parties who created.

Settlement follows the identity graph. When a consumer pays for work attributed to a Cultural DID, the settlement instruction splits according to the collective's .fair manifest — which itself reflects the governance-weighted contribution history of the members. Value flows through the graph to the Individual DIDs who actually did the work. The Org that sponsored the collective receives its declared share. The settlement layer doesn't need special logic for each identity type — it follows the .fair chain, and the .fair chain follows the identity graph.

---

### The MJN Token

The MJN token is the settlement currency of the protocol. It is not a speculative asset — it is the mechanism by which value moves through the network's attribution chains.

Every inference fee, every `.fair` contract execution, every consent-triggered payment settles in MJN tokens. Token holders hold a claim on the economic activity of a protocol — the same structural relationship a clearinghouse shareholder has to the transactions it settles.

Token issuance is governed by the MJN Foundation under Swiss FINMA guidelines. Token economics are designed for stability at the settlement layer, not volatility at the speculative layer.

---

## Reference Implementations

### AI Training Data Markets

The Chinese labs that ran 16 million fraudulent exchanges against Claude in early 2026 were not criminals seeking to do harm. They were engineers solving a real problem: how do you train a frontier model when the best training data is locked behind a competitor's terms of service?

MJN makes the legitimate version possible. A creator publishes work with a `.fair` manifest that includes training consent terms and a price. An AI lab queries the work through MJN. The consent declaration executes. The settlement instruction pays the creator. The lab gets training data. Nobody committed fraud. The creator got paid.

At scale: every Claude conversation, every Substack article, every GitHub commit that carries a `.fair` manifest becomes part of a consented, attributed, compensated training data marketplace. The distillation attack becomes a distillation *market*.

The typed identity model deepens this. A Cultural DID representing an open-source project can set collective consent terms for training on the project's output — with settlement flowing to contributors proportional to their .fair shares. An Org can license its employee-created content with consent flowing through the corporate delegation hierarchy. The consent and settlement layers don't need special cases — they follow the identity graph.

### Platform Identity Layer

Substack, 1Password, Anthropic, and DeepSeek each hold a fragment of an identity that belongs to a single human. MJN connects them. A user's DID is their identity on all four platforms simultaneously. Their `.fair` manifest carries attribution across all four. Their consent declaration governs what each platform can do with their presence. Their settlement instruction ensures value flows back to them from all four.

Platforms implement MJN as an auth layer. They don't surrender their users — they give users sovereignty, and gain access to a trust graph that makes their platform more valuable than it was before.

### Sovereign Publishing

A journalist publishes with a `.fair` manifest recording their DID as author, sources compensated, prior work cited, terms governing reproduction, price for full access, price for inference against their body of work. The article syndicates anywhere. Every reproduction carries the manifest. Every inference pays the journalist. The platform syndicating it earns a routing fee. The journalist earns the rest.

Twenty years of beat reporting is no longer an institutional asset that dies with the newsroom. It is a sovereign catalogue that earns for as long as it is queried.

### Trust-Gated Presence

A knowledge leader — a doctor, a lawyer, a domain expert, a community elder — operates a node on the MJN network. Their node carries their body of work, their trust graph, their consent terms, and their inference pricing.

Only people in their trust graph can query their presence. The querier's DID is verified. The trust relationship is checked — not just "are you connected?" but "what type of connection, at what trust depth, through which identity primitives?" A query routed through a Cultural DID the expert belongs to may have different consent terms than a direct Individual-to-Individual query.

The response is signed by the expert's DID. The .fair manifest attributes it. Settlement executes — inference fee flows to the expert. The querier gets an answer from someone they trust, not an algorithm. The expert gets compensated for their knowledge without being available 24/7 — their presence handles it.

Scale this up: every person with expertise runs a node. Every query flows through the trust graph. Leadership emerges naturally from who gets queried most — not who games an algorithm, but who earns actual trust, measured in actual payments, from actual relationships in the graph.

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
└── Ryan Veteze (b0b) — Lead Protocol Architect [contractor]
```

The Foundation is explicitly structured to be capturable by neither US nor Chinese regulatory pressure. Sovereign infrastructure requires sovereign governance. Switzerland's neutrality is not incidental — it is architectural.

The name *今人* draws from Japanese. The protocol is built by a Canadian. It will be governed from Switzerland. It is designed for the world. This is not a Western protocol imposing Silicon Valley architecture, nor an Eastern one. It belongs to the now persons who use it.

**imajin.ai** operates as the reference implementation and first node operator. It is one implementer among many, not the owner of the protocol.

---

## Roadmap

| Period | Milestone |
|--------|-----------|
| Q1 2026 | Protocol v0.1 specification · v0.2 typed identity model · MJN Foundation incorporation · April 1st: first party on MJN infrastructure (imajin.ai reference implementation) |
| Q2 2026 | Token structure and FINMA engagement · API SDK release · First platform integration conversations (Substack, 1Password, Anthropic) · Cultural DID and Org DID reference implementations |
| Q3 2026 | Foundation seed raise · First non-imajin node operators · Chinese lab engagement via neutral Foundation channel |
| Q4 2026 | MJN v1.0 specification · First cross-platform `.fair` settlement · Open RFC process launched · Family DID reference implementation |

---

## Market Projection: If MJN Becomes the Web

### The Thesis

HTTP replaced Gopher. TCP/IP replaced competing network protocols. The web replaced the BBS. Each time, the better infrastructure layer didn't compete with what came before — it made it obsolete by becoming the substrate everything else ran on.

MJN's proposition is the same: not a better website, not a better app, not a better platform. A better protocol. One that carries what HTTP never could — identity, attribution, consent, and value — natively, in every exchange.

The web as we know it is a document delivery system. MJN is a presence and intelligence delivery system. When you query a node, you're not retrieving a page. You're querying a now person — their thinking, their expertise, their creative catalogue — and value flows back to them automatically.

The question is not whether this transition happens. Generative AI models didn't just influence search behavior in 2025 — they actually began replacing it, becoming the first stop for information for billions of users. The document web is already dying. The question is what protocol the intelligence web runs on.

---

### The Numbers

**The substrate MJN replaces:**

The digital economy represents approximately $16 trillion of global GDP today. It is projected to reach $16.5 trillion and capture 17% of global GDP by 2028. Every dollar of that flows through identity, attribution, and payment infrastructure. None of that infrastructure is currently sovereign. All of it currently extracts.

**The users:**

More than 240 million people came online in 2025, bringing the world's total number of internet users to six billion. Each of them has an identity currently owned by a platform. Each of them creates value currently captured by a platform. Each of them deserves a node.

**The immediate market — decentralized identity:**

The global decentralized identity market was estimated at $3 billion in 2025, projected to reach $623 billion by 2035 at a CAGR of 70.8%. MJN is not a player in this market. MJN is the protocol this market runs on — the same structural position TCP/IP holds to the internet.

**The typed identity advantage:**

The decentralized identity market today treats identity as a monolith — individual wallets, individual credentials. MJN's typed primitives address the 80% of human economic activity that doesn't happen as isolated individuals: families sharing resources, communities governing creative output, organizations delegating authority. No competing protocol encodes these relationship types at the identity layer. The total addressable market for typed sovereign identity — families, communities, and organizations, not just individuals — is structurally larger than what current DID solutions can serve.

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

Each now person who joins the network deepens the value of every other node. A journalist's twenty years of beat reporting becomes more valuable as more readers query it. A developer's contribution history becomes more valuable as more projects reference it. A musician's catalogue earns more as the trust graph routes more discovery through it. This is the opposite of platform economics where value accumulates at the center. On MJN, value accumulates at the edges — at the nodes — because that's where the now persons are.

The typed identity model compounds this further. A Cultural DID representing a music scene doesn't just aggregate individual value — it creates emergent value that no individual member could generate alone. The scene's collective reputation, its curated output, its governance-weighted creative decisions — these are properties of the collective identity, not sums of individual identities. The network effect operates at every primitive level: individuals strengthen families, families strengthen communities, communities strengthen the organizations that serve them.

---

### The Honest Framing

We are not projecting that MJN captures the digital economy. We are observing that if MJN becomes the protocol layer for sovereign human presence on the internet — the way HTTP became the protocol layer for documents — then the token that settles every exchange on that protocol participates in the economic activity of the entire network.

TCP/IP doesn't charge. But Cisco built a $200 billion company selling the infrastructure that runs TCP/IP. Stripe doesn't own the money — but it processes $1 trillion in annual payment volume by being the best implementation of the payment layer.

MJN's analogues are protocol authors and infrastructure builders, not platform operators. The Foundation governs the standard. imajin.ai is the first reference implementation. Early token holders participate in the settlement layer of a protocol designed to become public infrastructure.

The SAM for 2026-2027 is honest and achievable: AI training data consent market, platform identity integration fees, and settlement for the first node operators. That is a $50-100M revenue opportunity that proves the protocol before the TAM conversation becomes relevant.

The TAM, if the protocol works as designed, is the digital economy itself.

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
