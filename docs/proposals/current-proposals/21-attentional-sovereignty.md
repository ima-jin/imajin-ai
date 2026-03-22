# Proposal 21 — Attentional Sovereignty
## Imajin as Infrastructure for Human Self-Determination

**Filed:** 2026-03-17
**Author:** Greg Mulholland (Tonalith)
**Series:** Proposal 09 of the Greg architectural review series
**Against upstream HEAD:** 39331e0
**Relates to:** Proposal 05 (Gas Model), Proposal 03 (Cultural DID), RFC-07 (Cultural DID), RFC-08 (Org DID), Discovery Primitive, Proposal 17 (Intent-Bearing Transactions)
**Upstream evidence:** None — not yet in upstream docs/proposals/

---

## DFOS Integration Note *(conditional — applies if Discussion #393 integration proceeds)*

The DFOS content chain → sovereign presence symbiosis identified in #393 deepens the identity archaeology framing in section 2.3 of this proposal. Currently, identity archaeology draws from `auth.attestations` — verified acts within the Imajin network. If DFOS content chains are accessible via Door 2 (relay), a person's archaeology extends to everything they have authored across DFOS spaces: posts, essays, collaborative documents — all CID-verified as theirs, all legible in a single chronological view.

This strengthens the core claim of section 2.3 without changing it: the attestation layer already creates the most legible self-knowledge tool the internet has produced. DFOS integration makes that record richer by adding the full history of what a person has written and published, not just what they have done on the Imajin network.

No changes to this proposal are required if DFOS integration proceeds. The philosophical framing is over-determined by the addition.

Ryan's subsequent framing of the L6 position (March 20, 2026) provides the sharpest external validation of this proposal's core claim: *"Everyone below us proves truth. We prove value."* DFOS, KERI, did:plc — they all prove who you are. Nobody below L6 proves what that's worth. Identity without settlement is a science project. The attentional sovereignty framing and the L6 settlement framing are the same claim from two angles — one philosophical, one architectural. Both belong in the whitepaper.

---

## What This Proposal Does

A recently published paper (Browne & Watzl, 2026, *Philosophical Studies*) provides rigorous academic grounding for what the MJN whitepaper argues from first principles: the current internet economy commodifies the ability to shape one's own attentional environment, structurally undermining individual autonomy at civilizational scale.

This proposal does not introduce new features. It reveals what the existing architecture already is — by renaming it precisely — and identifies five architectural refinements that follow from that clarity.

**The core claim:** MJN is not a better attention market. It is the architectural abolition of the attention market as currently constituted, and its replacement with infrastructure for attentional self-determination.

---

## 1. The Philosophical Foundation

### 1.1 Attentional Landscaping Potential

Browne & Watzl (2026) coin a precise term for what the attention economy actually trades:

> "The commodity it trades in is attentional landscaping potential — the ability to systematically influence patterns of attention by changes to the sensory environment individuals are exposed to."

This is not your data or your time — it is the power to shape what you attend to. Shaping what someone attends to shapes what they learn, what they prefer, what they choose, and ultimately who they become.

### 1.2 The Autonomy Problem Is Structural, Not Incidental

The paper's most important contribution: the attention market's threat to autonomy is a structural feature of any two-tier attention market, even one populated by well-intentioned actors.

The mechanism: users inhabit a platform's sensory environment but have zero visibility or control over what attentional landscaping is deployed at the back end. They take a probabilistic gamble with their own future preferences — a gamble they cannot meaningfully price or endorse because the processes are invisible, cumulative, and sub-personal.

Three autonomy-undermining tactics the paper identifies:
- **Manipulation** — native advertising, nagging patterns, roach-motel design
- **Value capture and tweaking** — gradually reshaping desires through accumulated micro-exposures (mere exposure effects, contingent capture, salience manipulation)
- **Systematic obfuscation** — flooding attention to prevent reflection on the influencing process itself

The paper's conclusion: autonomy requires the ability to reflectively endorse the processes that shaped your preferences, not just your current preferences. The attention market makes this endorsement structurally impossible.

### 1.3 Where the Paper Stops and MJN Begins

Browne & Watzl call for regulation. MJN's claim is stronger: the MJN architecture makes the attention market's specific failure mode — opaque, unendorsable, cumulative influence on preference formation — structurally impossible at the protocol layer.

---

## 2. Five Architectural Refinements

Each refinement takes an existing architectural decision and shows what it looks like when reframed through the attentional sovereignty lens. The mechanisms do not change — the understanding of what they protect deepens.

### 2.1 Declared-Intent Marketplace as Consent-to-Influence Architecture

**Current framing:** Protects user privacy by keeping the profile on the user's node and suppressing granular match data below k-anonymity thresholds.

**Deeper framing:** The declaration is a cryptographic act of self-directed attentional landscaping. When a user declares `['specialty coffee', 'live music', 'vinyl records']`, they are authoring the parameters of their own attentional environment. A business that responds to a match is not infiltrating a sensory environment — it is answering an explicit invitation.

The paper's autonomy critique applies precisely because current systems deploy influence users cannot endorse. MJN's declared-intent model is endorsable by design — the user wrote it, signed it, and can revoke it.

**Refinement:** Declaration layer documentation — in the whitepaper, RFC material, and API SDK — should explicitly frame declarations as **consent-to-influence statements**, not just interest categories. The signed declaration is the user's cryptographic assertion of what attentional landscapes they are willing to inhabit. This framing should appear in onboarding UX copy.

### 2.2 Gas Model as Autonomy Infrastructure

**Current framing (Proposal 05):** Frequency-scaled gas costs deter saturation and coordination gaming. The exponential multiplier (1× → 1.5× → 3× → 7× → 15× → 40×) prices out persistent reach attempts.

**Deeper framing:** The paper provides the scientific basis for why cumulative attentional exposure is autonomy-threatening even when each individual exposure is benign. The mere exposure effect (Zajonc, 1968) shows that people tend to like things more simply through repeated exposure — independent of manipulation intent. Bordalo et al. (2022) show that bottom-up salience effects explain choice instability including intransitive preferences, framing effects, and underweighted attributes.

What this means: the gas model is not primarily a spam deterrent. It is a structural cap on the accumulation of attentional landscaping potential by any single actor. The 4th through 6th contact in a 30-day window is the range where mere exposure, contingent capture, and value tweaking have had time to accumulate below the user's threshold of notice.

The cluster-aware computation (multiple businesses sharing a founding Actor DID) is equally important: it prevents distributing attentional landscaping potential across legal entities to circumvent frequency limits. This is not billing enforcement — it is attentional sovereignty protection.

**Refinement:** Gas model documentation should distinguish between legitimate commercial reach (single, high-value, consented communication) and autonomy-undermining accumulation (repeated contact below the threshold of conscious notice). The multiplier tiers are a protocol-level statement about what kinds of attentional influence are acceptable on a network committed to human self-determination.

### 2.3 Attestation Layer as Identity Archaeology

**Current framing:** The attestation data layer (auth.attestations) is the cryptographic foundation for standing computation, reputation, and portable context.

**Deeper framing:** The paper argues autonomy requires being able to reflectively endorse the processes that shaped your preferences. The current attention economy makes this impossible — processes are invisible and operated by actors with no obligation to reveal them.

The attestation layer creates something unprecedented: a legible, verifiable, chronological record of the trust relationships and interactions that shaped a person's experience on the network. The `auth.attestations` schema — issuer, subject, type, timestamp, signature, context — is the raw material for genuine self-knowledge about the social and economic processes that shaped you.

A person who can query their own attestation history has access to something the current internet makes structurally impossible: a legible account of the processes that shaped their social identity. This is **identity archaeology**. It is the technical foundation for the reflective self-knowledge that autonomy requires.

**Refinement:** A dedicated identity archaeology view should be developed as a first-class feature of the profile/presence layer — not a data export or audit log, but self-knowledge tooling: a chronological, legible representation of your trust history on the network, queryable by the user about themselves. *(Fully specced in Proposal 22.)*

The BaggageDID is the portable version. The identity archaeology view is the living, on-node version.

### 2.4 Community DID Governance as Collective Attentional Sovereignty

**Current framing (RFC-07):** The 33% governance weight ceiling prevents any single Actor from accumulating unilateral control over a Community DID's decisions.

**Deeper framing:** The paper's autonomy argument scales to communities. A community whose attentional landscape is controlled by a powerful founding member faces the same autonomy erosion as an individual user dominated by a platform. The community's members cannot reflectively endorse processes they cannot see or contest.

A Community DID creates a collectively governed attentional landscape — the community surfaces, amplifies, and suppresses content and activity according to its governance model. The 33% ceiling is not just a fairness constraint; it is an **attentional sovereignty protection at community scale**.

The Community DID's declaration namespace — the community's ability to curate its own discovery matching vocabulary — is collective attentional landscaping: the community collectively authors what kinds of attention it attracts and what it offers.

**Refinement:** Community DID governance documentation should distinguish between governance of decisions (handled by the existing quorum and weighting model) and governance of the attentional landscape (what the community surfaces, amplifies, suppresses). The behavioral removal mechanism should explicitly include attentional-landscape manipulation as a removable behavior: using a governing position to systematically bias community attention toward private interests, without community endorsement, is value capture and tweaking at the collective scale.

### 2.5 Discovery Primitive as Natural Home for Attentional Sovereignty Tools

The Discovery primitive (federated registry live, trust-gated presence queries live, declared-intent marketplace and declaration namespaces not yet built) is the correct integration point for attentional sovereignty tools.

**Behavior-seeded declarations (Ryan's directive):** Declarations should be seeded from actual behavioral signals, not from a questionnaire. Signals already being generated:
- Event attendance → interest categories from event tags
- Coffee tips → creator's category tags
- Trust graph connections → first-degree connection interests weighted by interaction frequency
- Check-in locations → geographic and category signals
- Course enrollment → learning interests

The declaration profile builds itself from the first three attestations. No form needed — a confirmation screen: *'Based on what you've done so far, here's what we think you're interested in. Edit, sign, or skip.'*

**Note on the Attentional Calibration Survey:** The original proposal included a structured self-reflection survey as a Discovery subsystem. Ryan correctly identified that this is a UX problem solved by behavior-seeded declarations and progressive disclosure, not a philosophical primitive. The underlying insight — that users arrive carrying conditioned attentional patterns that the architecture alone won't immediately dissolve — is real, but belongs in community design, facilitation practice, and the node operator guide. *(See Proposal 23.)*

---

## 3. The Claim Imajin Can Now Make

### 3.1 MJN as Attentional Sovereignty Infrastructure — The Four-Dimension Inversion

The current attention market fails autonomy on four specific dimensions. MJN inverts each:

| Attention Market | MJN |
|---|---|
| **Opacity** — influence processes are invisible to the person being influenced | **Legibility** — attestation layer records every trust-relevant act, signed, timestamped, queryable by the subject |
| **Unendorsable** — the user cannot reflectively endorse processes they cannot see | **Self-authored** — declared-intent marketplace requires the user to sign the parameters of their attentional environment |
| **Misaligned incentives** — landscaper profits from shaping preferences toward commercial interests | **Aligned protocol** — gas model structurally caps cumulative attentional landscaping by any single actor |
| **Collective capture** — community governance captured by founding cohort | **Sovereignty ceiling** — 33% weight limit + behavioral removal prevent attentional-landscape capture at community scale |

### 3.2 Imajin as Public Infrastructure for the Mind's Environment

Identity, attribution, consent, and settlement are at the inflection point that the telegraph, telephone, and internet crossed before them: they are the foundational substrate of human economic and social activity in the digital age, and privatized platform control over them is producing visible civilizational damage.

The attentional sovereignty framing adds specific urgency: the damage is not merely economic. It is developmental. The systematic, sub-personal manipulation of preference formation and belief formation across billions of people is the revenue model. MJN's claim is not that it will solve this — it is that it will build the layer that makes the alternative structurally possible.

### 3.3 The Thesis

*Start from the human — sovereign, present, with the right to understand and govern the processes that shape them — and you will find the protocol underneath.*

---

## Ryan's Response and Integration (March 17, 2026)

Ryan reviewed this proposal via OpenClaw. Summary:

**What landed:**
- Browne & Watzl synthesis is exactly the academic grounding the project needed
- The reframings in 2.1–2.4 reveal what was already built — not new features, new names
- The four-dimension inversion table (section 3.1) is pitch deck material
- "Attentional sovereignty" as a term — keep it

**Ryan's directives:**
1. Sections 2.1–2.4 reframings → whitepaper (as language upgrades to existing sections, not new sections)
2. Section 3.1 table → pitch deck; essay 21 if still writing
3. Section 3 (mindfulness, Jungian, IFS, psychedelics) → `docs/philosophy/` folder — good thinking, not architecture
4. Survey idea → park it; solve with behavior-seeded declarations and progressive disclosure
5. "Attentional sovereignty" → keep the term

**Greg's counter-response:**
- Survey insight (not framing) is real — relocated to community design and node operator guide *(Proposal 23)*
- Recognition-over-endorsement is philosophically precise, not vibes — belongs in community governance docs and node operator onboarding *(Proposal 23)*
- Identity archaeology spec should be written now while attestation layer is being designed — schema gaps discovered now are cheap; discovered after data accumulates are expensive *(Proposal 22)*

**Ryan's final response (2 of 3 conceded):**
- "Vibes" was uncharitable — recognition-over-endorsement has real design implications for UX copy, node operator onboarding, community moderation — retracted
- Survey framing, not survey insight — fair; people arrive with conditioned patterns, architecture protects structurally, human layer needs community and facilitation design — agreed
- Identity archaeology spec now — yes; spec the view, validate the schema supports it, shelve the UI until 100+ active users
- Behavior-seeded declarations — signals already exist (see 2.5 above); confirmation screen, no form needed

---

## Section 3 — Philosophy Context (Deferred to docs/philosophy/)

The mindfulness, Jungian, IFS, and psychedelic integration content from the original proposal (Greg's reflection on why attentional sovereignty matters at the human developmental level) should live in `docs/philosophy/` in upstream, not in this architectural proposal. The key insight relocated to Proposal 23: **recognition over endorsement** — seeing where someone actually is, not where they should be or want to appear — is the human-layer practice that corresponds to attentional sovereignty at the protocol layer.

---

## Decisions Required from Ryan

| # | Decision | Greg's position | Status |
|---|---|---|---|
| 1 | Does "consent-to-influence" framing land in the whitepaper, or stay in proposal docs? | In the whitepaper | Open |
| 2 | Onboarding UX copy includes language about authoring one's attentional environment? | Yes | Open |
| 3 | Section 3 (philosophy) → `docs/philosophy/` folder? | Yes | Open |
| 4 | Behavior-seeded declaration confirmation screen specified as a UX task? | Yes | Open |
| 5 | Community DID removal trigger list includes attentional-landscape manipulation? | Yes | Open |
| 6 | Whitepaper v0.4 references Browne & Watzl (2026) and attentional sovereignty framing? | Yes | Open |

**Resolution signals in the repository:**
- Declaration documentation uses "consent-to-influence" language alongside privacy framing
- Onboarding UX copy references authoring one's attentional environment
- Community DID governance docs include attentional-landscape manipulation as a removal trigger
- Whitepaper v0.4 references Browne & Watzl (2026)

---

*Good primitives are over-determined.*
*— Greg, March 17, 2026*
