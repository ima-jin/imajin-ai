# RFC-14 Response: Community Issuance Network

**Responding to:** [RFC-14 — Community Issuance Network](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-14-community-issuance-network.md)
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/272
**Related:** RFC-07 (Cultural DID), RFC-08 (Org DID), RFC-13 (Progressive Trust), RFC-15 (Trust Accountability), RFC-17 (Governance Primitive), #272
**Author:** Greg (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

RFC-14 is my "Commons Layer" proposal from March 2026, reframed as a protocol document: any trusted institution can be an identity issuance point, with the physical body as proof-of-work. The RFC lands an architectural insight (EventDID generalizes) but leaves four open questions about how institutions actually participate, what verification they perform, what role the Foundation plays, and when the network materializes.

This response closes all four, leveraging the mechanism work already settled in RFC-08 (Org DID, `scope: 'org'` as the substrate), RFC-15 (severe-act direct path, accountability), and RFC-17 (governance bedrock: forks reversible, standing decays, non-bedrock decisions TTL).

**Two housekeeping notes on the RFC document itself:**

1. **Duplicate heading.** Lines 79-83 and 84-106 both start "Prior Art: Protocol-Level Redistribution." The first is an empty stub; the second carries the content. Copy-paste artifact — should be deduplicated in a cleanup pass.
2. **Scope drift.** The Prior Art section (Zakat, Waqf, Potlatch, Tithe) is about MJN fee-model redistribution, which is RFC-12 and fee-model-v3 territory rather than issuance-network territory. It belongs in whichever document anchors the Foundation philosophy, not this one. Suggest relocating to RFC-12 or a dedicated "Foundation Principles" doc.

---

## Core principle

**A trusted human verifying a physical body is the proof of work. The protocol makes that verification cryptographically legible without claiming authority over who is trustworthy.** The Foundation authors standards and maintains a reference list; it doesn't gatekeep. Legitimacy is plural — Foundation-canonical, peer-attested, or service-specific acceptance. Services downstream compose trust per use case. This keeps the "public option" framing from collapsing into a new central authority under a different logo.

---

## Answers to the Four Open Questions

### Q1. Registration path — federated node, separate path, or hybrid?

**Org DID with `issuance_authority` attestation, node-independent. Reuses RFC-08 entirely.**

Institutions register as issuance points via the existing RFC-08 Org DID mechanism. A new attestation type — `issuance_authority` — is granted to Org DIDs that meet the standards (Q3 below). Hosting arrangement is an independent axis: institutions can run their own node (full sovereignty) or operate via a trusted node operator (lower operational bar). The attestation lives on the Org DID, not on the node, so an institution can migrate hosts without losing standing.

**Why not federated-node-only:** excludes the majority of institutions the RFC-14 framing exists to serve. A rural library can't run a ProLiant, and the "public identity infrastructure" promise collapses if the operational bar is that high.

**Why not a new `scope: 'institution'`:** scope proliferation. The RFC-07 and RFC-08 walkthroughs both landed on "don't add scopes casually; covenant layers + attestation types cover this." Institutional-ness is a kind of organization characterized by an attestation, not a new substrate.

**What this means in practice.** The same soft → claimed flow from RFC-08 applies. An institution's Org DID starts soft-loaded (minimal signal), moves to claimed via institutional evidence, and receives the `issuance_authority` attestation through one of the Q3 paths. No separate registration track.

### Q2. Verification threshold — government ID, institutional trust, or something tiered?

**Protocol floor + institutional discretion + optional verification-claims vocabulary. No government-ID mandate.**

**Protocol floor (three requirements for any issuance):**

1. **In-person interaction with a human who holds institutional authority to issue.** Not a form submission; not an online-only verification. The RFC's "the physical body is the proof of work" framing depends on this.
2. **Internal institutional record.** The institution maintains a link between the issued DID and some institutional identifier it already uses (library card number, membership number, patient file). The specific identifier is up to the institution; the requirement is that the link exists, so future interactions correlate back to the same DID.
3. **Signed issuance attestation from the institution's Org DID key.** Cryptographic commitment — institution can't repudiate. Attestation carries timestamp, institution DID, issued DID, and optional verification claims.

**Optional verification claims (extensible vocabulary).** Institutions can attach specific claims to the issuance attestation — `government_id_checked`, `address_verified`, `reference_vouched`, `biometric_enrolled`, etc. The canonical vocabulary lives in the `.fair` spec (parallel to the Q5 role vocabulary in RFC-18), with namespaced extensions for institution-specific practices (`library:acme/card_renewed_last_90_days`). These are opt-in at the institution level and can be required by downstream services.

**No declared-tier enum.** Tiers invite over-declaration — institutions would have incentive to claim higher tiers than they actually perform, to increase their DIDs' utility. Verifiable claims make the attestation carry the information directly: the cost of fraud is cryptographic misuse of the institution's key, which triggers severe-act consequences per RFC-15.

**Downstream service responsibility.** Services decide which verification claims they require and which institution standing they accept. A children's library borrowing-card reader requires just the floor. A landlord might require `government_id_checked`. A bank might require `government_id_checked` + institution-standing above a threshold + a specific claims set. That's a services-layer policy question, not a protocol-layer one.

**PII retention is not protocol-specified.** The internal institutional record (requirement 2) lives with the institution and follows the institution's own jurisdictional compliance. The protocol doesn't mandate what's retained; it only requires that a correlation capability exists on the institution's side.

**Why no government-ID floor:** the RFC's explicit premise is that institutional trust is a legitimate substitute for state credentialing. A government-ID requirement reproduces the exclusion the RFC exists to address — undocumented people, youth without ID, unhoused people without stable address, people fleeing abusive situations. These are significant populations and exactly who needs a non-governmental identity path.

**Why a floor exists:** without one, "verified in-person by Institution Y" has no protocol-level meaning, and the signal decays to uselessness. The floor makes institutional trust *legible*, not *mandatory*.

### Q3. Foundation governance — does the Foundation certify issuance points?

**The Foundation plays three distinct roles (standards author, canonical reference list maintainer, severe-act responder), none of them gatekeeper. Three parallel paths to `issuance_authority` prevent single-point-of-failure gating. All paths carry TTLs per RFC-17 bedrock.**

**Foundation's three roles:**

1. **Standards author.** What is an issuance point? What does the Q2 floor mean in practice? What constitutes severe-act by an issuance point? These are protocol-level documents the Foundation authors and amends via RFC-17 governance. The standards are a public good — anyone can hold any institution to them.

2. **Canonical reference list maintainer.** The Foundation publishes a list of issuance points that meet its standards. This list is a *signal*, not a *requirement*. Downstream services may require list membership (a bank might), or not (a community library might just require the floor). An institution can be a legitimate issuance point without being Foundation-canonical, provided it has other legitimacy signals.

3. **Severe-act responder.** When an issuance point is credibly accused of fraud, bad-faith issuance, or key compromise, the Foundation can remove from the canonical list and sign an `issuance_authority.revoked` attestation. This connects to RFC-15 — severe-act direct path applies. The Foundation isn't the only actor that can revoke; peer institutions can withdraw their attestations; fraudulently-issued subjects can flag via RFC-15 subject-request.

**Three parallel paths to `issuance_authority` (any one suffices; services filter):**

- **Foundation-canonical.** Foundation has evaluated the institution against its published standards and signed a canonical attestation. TTL: 2 years, renewable.
- **Peer-attested.** Some threshold of existing issuance points have attested (with independence requirements — same shape as RFC-15 Q6a, probably same answer: fixed count + independence test). TTL: 1 year per attestation.
- **Service-specific acceptance.** A specific downstream service has accepted the institution for its use cases, independent of other lists. A university might accept a community partner's issuances without requiring Foundation-canonical or broad peer attestation. TTL: at service discretion, with review cadence encouraged in Foundation standards.

The three paths match the real landscape: a food bank running issuance for community-garden members is legitimate for community-garden use but probably not for opening a bank account, and the protocol should express that honestly rather than force a universal yes/no gate.

**TTL on all paths (RFC-17 bedrock compliance).** An institution that stops renewing across all paths drops out of the network over time rather than silently decaying. Prevents zombie certifications. Forces active maintenance of the trust signal.

**Regional delegation — deferred to v-next.** The Foundation can delegate canonical-list maintenance to regional or jurisdictional bodies (national library associations, credit union leagues, community foundation networks) as the network matures. Those bodies have institutional knowledge the Foundation can't feasibly develop for every jurisdiction. This isn't v1 — v1 is Foundation-canonical directly. v-next opens delegation once regional bodies emerge as willing partners.

**What's explicitly rejected:**
- **Foundation certifies every issuance point (single central authority).** This is the failure mode the RFC exists to avoid. It reintroduces the "governmental/corporate gatekeeper" pattern under a different logo and contradicts the "public option" framing.
- **No Foundation role at all.** Cold-start problem (who are the first issuance points?). Susceptible to early-clique capture. Missing local context. Peer-only bootstrapping works in theory; in practice the first N institutions end up gating everyone else.

### Q4. Timeline — Year 1, Year 2, or Year 3?

**Staged across all three years with a different shipping surface each.**

**Year 1 (now through Q4 2026):**
- Imajin events are publicly positioned as the first category of issuance point. EventDID check-in is narratively reframed (not mechanically changed) as "community-anchored identity issuance for the event-attendance category." This is honest — an event host verifying a physical body at a check-in IS the pattern the RFC generalizes.
- RFC-14 lands as a protocol document. Prerequisite RFCs (08, 15, 17) ship in parallel. Protocol-level `issuance_authority` attestation isn't implemented yet; the EventDID pattern is its specialized precursor.
- Business-plan framing: "issuance network, event-category live" — credible without overclaiming.

**Year 2 (2027):**
- RFC-14 v1 ships at the protocol layer. `issuance_authority` attestation implemented, canonical reference list infrastructure live, peer-attestation path operational, TTL mechanism in place, Q1-Q3 answers executed.
- One to three external pilot institutions onboarded — realistic partnership cadence. Likely candidates: a partner library through Borzoo's network, a community credit union via Ryan's connections, a community organization aligned with Tonalith's rollout.
- Foundation's canonical-list process begins operating. Standards documents published.
- Business-plan framing: "issuance network expansion beyond events" — Y2 milestone with measurable institutional adoption.

**Year 3 (2028):**
- Public infrastructure framing activates. Regional delegation (Q3 v-next path) opens. Foundation engages national-level institutional associations as regional delegates.
- Cross-jurisdictional interop handled. Multi-issuance-point DIDs (a person who got their DID at a library, then gets a service-specific issuance from a credit union) become a pattern the network supports.
- Business-plan framing: "community-anchored public digital identity is real and in use."

**Engineering timeline and partnership timeline are orthogonal.** Engineering can ship the primitives on the above cadence. Partnerships happen when they happen — Y2-Y3 deliverables *depend on* partnership work that lives outside the engineering lane. The timeline is conditional on partnership progress, not guaranteed by engineering delivery alone. The RFC and the business plan should note this conditionality explicitly.

**Stress-test criterion for activating Y3 narrative.** Public-infrastructure framing shouldn't be calendar-based; it should be maturity-based. Concrete criterion for Y3 framing activation:

- ≥5 external institutions onboarded through the Y2 mechanism,
- ≥1 severe-act response handled through the RFC-15 path without incident,
- ≥1 cross-jurisdictional issuance flow exercised end-to-end.

If those aren't met, Y3 framing waits until they are. This keeps the public-infrastructure claim honest.

---

## What this leaves open

1. **Peer-attestation threshold specifics.** Q3's peer-attested path needs a concrete count + independence test. Parallel to RFC-15 Q6a — probably the same answer (fixed 3 + independence test of "attestors drawn from unrelated institutional categories"), but deserves its own pass once the network has a handful of institutions to calibrate against.

2. **Canonical verification-claims vocabulary.** Q2's claims layer (`government_id_checked`, `address_verified`, etc.) needs `.fair` spec ratification. Parallel to the RFC-18 Q5 role vocabulary dependency. Work item attached to Y2 deliverable, not this RFC.

3. **Foundation's internal governance.** Q3 says the Foundation authors standards and maintains a canonical list; *how the Foundation itself decides* (board composition, ratification processes, conflict-of-interest rules) lives in RFC-12 (tokenomics) and Foundation-bylaws territory, not RFC-14.

4. **Institutional-side PII retention and liability.** Q2 requires institutions to maintain an internal DID-to-identifier record. The specifics (what's retained, for how long, under which jurisdictional regime) are institutional-practice + legal-compliance questions. Parallel to the RFC-18 Q8 pattern — protocol provides mechanism hooks; compliance lives elsewhere. A companion document (`docs/compliance/issuance-practices.md` or similar) carries operator-facing guidance, committed as a Y2 deliverable alongside RFC-14 v1.

5. **Cross-issuance-point DID mechanics.** A person who receives their DID at a library and later interacts with a credit union: does the credit union add a *second* issuance attestation to the same DID? Is there such a thing as "re-issuance" vs. "additional attestation"? The answer is probably "additional attestation" — the DID is the person; multiple institutions can attest to having verified that person in-person at different times. But the mechanics (do attestations stack? does multi-institution verification carry combined weight?) need their own pass, likely in v-next.

6. **Issuance-authority revocation propagation.** Q3 names the severe-act path via Foundation + RFC-15. The propagation question (all DIDs issued by a revoked institution — do they lose their attestations? are they re-verifiable through another institution?) needs design work. Parallel to RFC-18 Hard-revoke mechanics — the signed issuance attestation is durable; what gets revoked is the institution's *future* issuance capability, not past issuances, though past issuances from a key-compromised institution may need separate re-attestation paths.

---

## Recommendation: ship order

**Year 1 (now → Q4 2026):**
1. RFC-14 document lands at protocol layer with framing + Q1-Q4 answers ratified.
2. RFC-08 (Org DID), RFC-15 (accountability), RFC-17 (governance) ship in parallel — prerequisites for v1 implementation.
3. EventDID narrative reframe applied in public communications (business plan v5, community messaging). No mechanism change; framing work only.

**Year 2 (2027) — v1 implementation:**
4. `issuance_authority` attestation type defined and ratified.
5. Canonical verification-claims vocabulary ratified in `.fair` spec.
6. Foundation standards document published; canonical-list infrastructure live.
7. Peer-attestation flow implemented (threshold: 3 with independence test, per the Q3/RFC-15 parallel).
8. TTL mechanism implemented on all three paths.
9. `docs/compliance/issuance-practices.md` companion doc shipped.
10. One to three pilot institutions onboarded (partnership timeline — conditional).

**Year 3 (2028) — public infrastructure activation, conditional on stress-test criteria:**
11. Regional delegation path opens (Q3 v-next).
12. Cross-issuance-point DID mechanics designed and shipped (open Q5 above).
13. Issuance-authority revocation propagation mechanism shipped (open Q6 above).
14. Public-infrastructure framing activates once stress-test criteria met (≥5 institutions, ≥1 severe-act response handled, ≥1 cross-jurisdictional flow exercised).

---

## Anchor to existing work

- **Current shipped state.** EventDID check-in exists; events are first-class identity-issuing entities. `scope: 'org'` Org DIDs live in `auth.identities`. No `issuance_authority` attestation yet; no canonical-list infrastructure; no verification-claims vocabulary. The Y1 work is framing + prerequisite RFCs, not net-new engineering at the issuance layer.
- **RFC-07 response.** Core move: opt-in covenant layer on `scope: 'community'`. RFC-14 uses a parallel move at the `scope: 'org'` layer — `issuance_authority` as a specific attestation that an Org DID can hold, with verification standards the Foundation authors. Not a new scope; an opt-in capability on an existing substrate.
- **RFC-08 response.** Core move: the protocol makes commercial activity legible; business decisions stay with the business. RFC-14 uses the same shape: protocol makes institutional issuance legible; institutional practice (what verification, what retention) stays with the institution. `issuance_authority` is an in-spec optional component of `scope: 'org'` alongside `legal_entity_reference`, `soft_loaded`, and `covenant_attestation`.
- **RFC-13 response.** The two-layer "standing is network-level, membership is community-level" model applies here as "issuance is network-level, what a given service accepts is service-level." An institution's `issuance_authority` is a network-legible fact; which services honor it is a service-level policy composition.
- **RFC-15 response.** Severe-act direct path + RFC-15 subject-request are the mechanisms that revocation of `issuance_authority` and fraudulent-issuance remediation plug into. RFC-14 doesn't re-specify these; it names them as the pathway.
- **RFC-17 response.** Three-item bedrock (forks reversible, standing decays, non-bedrock TTL) constrains the Q3 answer directly. TTL on all three paths to `issuance_authority` (Foundation-canonical 2yr, peer-attested 1yr, service-specific discretionary) is the bedrock applied to this RFC.
- **RFC-18 response.** The Q2 verification-claims vocabulary parallel (namespaced extensions on a core spec vocabulary) and the Q4 companion-document pattern (`docs/compliance/issuance-practices.md`) mirror decisions made in RFC-18 and should be ratified coherently across both.
