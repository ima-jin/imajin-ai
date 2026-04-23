# RFC-08 Response: Org DID

**Responding to:** [RFC-08 — Org DID](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-08-org-did.md)
**Discussion:** https://github.com/ima-jin/imajin-ai/discussions/253
**Related:** RFC-07 (Cultural DID), RFC-10 (Sovereign User Data), RFC-11 (Embedded Wallet), RFC-12 (MJN Token Economics), RFC-15 (Trust Accountability), RFC-17 (Governance Primitive)
**Author:** Greg (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

RFC-08 describes Org DID as the primitive for legally incorporated entities — the commercial counterpart to RFC-07's Cultural DID. The April 7 forest infrastructure already shipped `scope: 'org'` with real keypair, multi-controller access, and service-scoped permissions, so this response reconciles the RFC with what's shipped and closes the six open questions.

This response composes with adjacent work:

- **April 7 forest infrastructure** — `scope: 'org'` is the substrate; RFC-08 defines what it means.
- **RFC-07 response** — parallel primitive for non-commercial collectives. Cross-primitive interaction is the subject of Q5.
- **RFC-15 response** — bilateral attestation pattern for parent/child affiliations (Q3) and referee substrate for contested claims (Q2).
- **RFC-17 bedrock** — forks reversible, history preserved; applies to soft→claimed challenge records, stewardship (via RFC-07 Q7), and role assignments.
- **RFC-12 pending legal review** — MJN vs MJNx tax classification is specifically deferred; Q6 commits only to data recording, not classification.

---

## Core principle

**The protocol makes commercial activity legible — typed identity, authenticated signatures, chain-recorded actions — and leaves business decisions to the business.** Agency stays with the entity; infrastructure handles the record. Org DID is the primitive that says "this is a business on the network" and provides the rails for operating as one, without dictating what that business does or how it decides.

---

## Answers to the Open Questions

### Q1. Substrate relationship — is RFC-08 a layer on `scope: 'org'`, or the spec for it?

**RFC-08 IS the spec for `scope: 'org'`. Not a layer.**

Unlike RFC-07 (where communities have genuinely different natures — casual vs. cultural — warranting an opt-in covenant layer), Org DIDs don't have that shape of variation. A sole proprietorship, a partnership, a corporation, a nonprofit — these differ in *degree of legal formality*, not in *what kind of entity they are*. All of them are "entity with named owners, fixed membership, commercial capability." The differences are handled by optional in-spec components and by forest controller configuration, not by a separate primitive posture.

**Optional in-spec components** (declared per-org, not gated by a layer):

- `legal_entity_reference` — optional incorporation ID, business number, or registration jurisdiction reference. Absent for unincorporated orgs; present for registered entities.
- `soft_loaded` — boolean flag indicating the DID was customer-check-in-originated and hasn't been claimed yet. Transitions via the Q2 claim flow.
- `covenant_attestation` — optional signed attestation of network-covenant alignment. Distinct from legal entity: a sole prop can attest the covenant without incorporation.

**Capabilities are uniformly available.** All Org DIDs can participate in marketplace, commercial messaging, reviews, `.fair` issuance, balance holding, and transaction processing. Gating commercial reach behind an opt-in layer creates weird asymmetry — a typed org that can't transact isn't really doing anything the protocol uniquely supports.

**Variation in governance shape is handled by the forest's multi-controller configuration**, not by a `type` discriminator. A cooperative's "equal partners" and a sole prop's "one owner" are different controller setups on the same primitive. Hybrid structures (coop-corps, DAOs operating as orgs, unincorporated associations) are expressible without the protocol enumerating a fixed taxonomy.

### Q2. Soft → claimed transition — verification sufficient for claiming a soft-loaded Org DID

**Tiered by accumulated signal, with a 30-day challenge window.**

Soft-loaded orgs accumulate real value (customer count, review history, transaction volume) before any owner claims them. The claim flow has to respect both legitimate small-business claims (easy path for low-stakes DIDs) and high-value targets (higher bar for bigger prizes).

**Tier by accumulated signal at the moment of claim:**

- **Thin history** (< ~10 check-ins AND < ~500 CHF-equivalent aggregate volume): **single-factor verification**. Any one of:
  - Location proof (geolocation ping from the premises)
  - Phone match (publicly listed business number)
  - Existing-DID attestation from a prior participant with history at the location
- **Substantial history** (above that threshold): **multi-factor** — either 2 of the factors above, or 1 *strong* factor. "Strong" means attestation from a customer DID with ≥ 90 days of check-in history at the org.

**Specific thresholds are starting values, tunable via protocol-scope governance** (same pattern as RFC-07 Q3 — shape in the RFC, numbers empirical).

**All claims are signed attestations identifying the verification factors used.** Chain is auditable.

**30-day challenge window.** A competing claimant can present stronger proof within 30 days of a claim. Credibility of a challenge is assessed by the RFC-15 appellate-pool substrate (or equivalent referee mechanism). On credible override:

- Original claim is revoked
- Challenger's claim stands, with their own fresh 30-day window
- Chain preserves the revocation and the handoff

After 30 days: claim is permanent unless overridden by protocol-scope governance for proven misrepresentation — rare, and deliberately so.

**Chain of claim events preserved per RFC-17 bedrock.** Challenges and overrides are historical facts, not erasures.

**What this leaves open:** specific threshold values and the exact definition of "strong factor" are empirical starting values for protocol governance to tune.

### Q3. Multi-location and franchise topology

**Parent/child structure covers single-location, multi-location company-owned, franchise, and hybrid cases in one uniform model.**

- **Single-location org:** one Org DID, no children. Degenerate case — same as shipped `scope: 'org'` today.
- **Multi-location company-owned:** parent Org DID (the company) + child Org DIDs (each location). Parent attests each child; child attests parent. Control/ownership lineage on-chain.
- **Franchise:** parent Org DID (the franchisor brand) + child Org DIDs (franchisee locations), but with a different attestation type — `franchise_agreement` rather than `ownership`. Franchisees are independently-owned orgs affiliated with the parent by contract. Parent can revoke affiliation (franchise terminated); child retains their DID but loses the brand association. Child can relinquish voluntarily.
- **Hybrid cases** (company-owned plus franchised under one brand) are expressible directly — the parent has a mix of `ownership`-typed and `franchise_agreement`-typed child attestations.
- **Recursive structure supported.** A child Org DID can itself have children (e.g., regional franchisor beneath national brand, local franchisees beneath regional). No artificial depth limit.

**Where data attaches.**

- Reviews, check-ins, transactions → child DIDs (location-specific by default).
- Aggregate queries (brand-wide volume, network-wide reputation, cross-location review summary) computed across all children with active parent attestation.
- `.fair` manifests on location-specific products/services → that child DID. Brand-wide offerings (franchise standard items) → parent, inheriting brand authority.

**Independence of treasury and stewardship.**

- **Each DID has its own treasury.** Parent-child relationship does not commingle funds. Franchise royalties, inter-location transfers, etc., flow via normal transactions between DIDs — not via protocol-level treasury links.
- **Each DID has its own steward node** (RFC-07 Q7 pattern applied to orgs). A franchisee node outage doesn't affect the franchisor's operations, and vice versa.

**Attestation mechanics (franchise case):**

- Parent attests: "X child DID is a franchisee under `franchise_agreement` dated YYYY-MM-DD with terms hash-reference / summary."
- Child attests: "we operate as a franchisee of X parent DID under the above agreement."
- Bilateral per RFC-15 countersigning pattern.
- Unilateral revocation by either side is chain-recorded; creates a "disputed affiliation" state until the other side countersigns the revocation or responds. Disputes route to appeal (RFC-15 machinery).

**What this leaves open:** aggregate-query indexing infrastructure (follow-on tooling, not RFC-level spec).

### Q4. Employee DID scoping

**Role templates on top of existing service-scoped permissions. Mechanism shipped; RFC-08 adds a common vocabulary.**

The April 7 forest infrastructure already supports service-scoped permissions and `actingAs` for group DIDs. RFC-08 does not invent new mechanics; it adds a recommended role template library to make common configurations legible across the network.

**Baseline mechanic (shipped, unchanged):**

- Employee Person DID with `actingAs` = Org DID
- Service-scoped permissions gate what they can do as the org per service

**Role template library (recommended starting points):**

- **Admin** — full permissions across all services including controller management; authorized treasury signer for normal-tier; can be escalated to large-tier by explicit treasury config
- **Manager** — all services except controller management; treasury signer for normal-tier (one of multi); no large-tier
- **Operations** — transaction services (events, pay, media), limited messaging; no treasury signing, no controller management
- **Marketing/Communications** — commercial messaging, media, profile; no transaction processing, no treasury
- **Cashier/Front-of-house** — pay (process, read balance), events (check-in only); no outbound messaging, no treasury
- **Observer** — read-only across all services; no write actions. For auditors, advisors, investors.

**Templates are suggestions, not required.** Orgs can customize permissions per employee from scratch; templates are a fast path for common cases. Action-typed permissions within a service (e.g., within pay: can-read-balance vs can-withdraw) are available where services support them — per-service concern, not RFC-level spec.

**Treasury signing is a separate authorization, not subsumed by role.** Role templates grant procedural capability; actual treasury signatories are named explicitly in the treasury configuration. You can be a Manager and not be on the signer list.

**Revocation is atomic.** When an employee role is revoked, `actingAs` authority terminates immediately across all services. Pending actions (e.g., in-progress multi-sig signatures) remain chain-recorded but cannot complete under revoked authority.

**Role assignments and revocations are chain-recorded signed actions.** Native auditability.

**Identity preserved: employees don't "become the org."** Every action on behalf of the org is signed by the employee's Person DID with `actingAs` = Org DID. Individual accountability survives the delegation. Countersigning, disputes, and bilateral attestations identify both the human actor and the org they acted for. This matters for Q6 — revenue attribution, agent accountability, and dispute resolution all trace back to specific humans, not just to the org.

### Q5. Org DID in Cultural DID trust graph

**Observer-only, by explicit Cultural-side approval. Membership above Observer is Person-DID-only bedrock. Covenant toggle for Cultural DIDs to close Org requests entirely.**

- **Membership above Observer is Person-DID-only — bedrock, not configurable.** No Org DID becomes Participant, Active, or Governing in a Cultural DID. Cultural DIDs are collectives of human practice; allowing business-entity membership above Observer would collapse the primitive's reason for existing.
- **Observer tier for Org DIDs requires explicit Cultural-side approval.**
  - Org requests observer status (signed request sent to the Cultural DID)
  - Cultural DID governance (standard trust-weighted quorum per RFC-07) approves or declines
  - Approval creates a bilateral Observer-relationship attestation (Org requested, Cultural granted)
  - Chain-recorded
- **Covenant-level `observer_requests` flag:**
  - `open` (default) — Orgs can send requests; each is decided by governance
  - `closed` — no requests accepted; existing granted observer statuses remain unless individually revoked
  - Flag is toggled via constitutional-tier amendment (RFC-17). Changing stance is deliberate, not casual.
- **Observer status is revocable unilaterally by Cultural governance** at any time, without appeal or TTL. It's their space; they decide who observes.
- **Observer capabilities are minimal.** See public identity and output (which is public anyway). The real signal is *relationship legibility* — the Org appears in trust-graph queries as openly affiliated with the Cultural DID. No access beyond public visibility.

**Reverse case (Cultural DID observing an Org DID): freely allowed, no approval needed.** Org DIDs are public-by-default entities; a Cultural DID observing an Org is equivalent to any Person DID following a business.

**Protection against extraction attempts:**

- Marketing entities mass-requesting access: collectives with `requests: open` decline individually via governance; collectives with `requests: closed` don't even process the requests.
- Sybil attempts (agency creating Person DIDs to infiltrate as members) are blocked by Person-only-above-Observer bedrock combined with RFC-07 Q3's per-founder `.fair` contribution and 90-day activity minimums (and equivalent bars for inbound membership).

### Q6. Tax/compliance implications of on-network revenue tracking

**Protocol provides export tools and integration hooks. Jurisdictional compliance is the business's responsibility. MJN/MJNx tax classification defers to RFC-12.**

- **Baseline: chain-recorded transactions are the business's own data.** Org DID can query, export, and use its own transaction history. Customer identity remains private per RFC-08 visibility rules.
- **Standard export formats supported:**
  - CSV minimum
  - Common accounting-software import schemas (QuickBooks, Xero, Sage) via documented format specs
  - Tooling work, not protocol-level substrate
- **Optional Org DID metadata for jurisdiction:**
  - `jurisdictions: string[]` — ISO 3166-1 country/subdivision codes where the Org operates and reports
  - Informational; protocol does not validate
  - Used by compliance integrations to know what rules apply
- **Optional tax-relevant transaction annotations** (at Org's discretion, per transaction):
  - `tax_applicable: boolean`
  - `tax_rate: decimal`
  - `tax_jurisdiction: string`
  - Annotations for the Org's own records. Protocol neither computes nor validates.
- **Third-party compliance integration hooks documented.** Standard query API for time-range / jurisdiction / tag filters lets services like Avalara, QuickBooks, Xero, and regional equivalents build integrations. Jurisdiction-specific computation lives in those services, not in the protocol.
- **The protocol makes no compliance claims.** Doesn't compute taxes, doesn't validate compliance, doesn't report to authorities. Businesses are responsible for their own compliance; the protocol provides authenticatable raw data.

**Privacy preserved through audit trails.**

- Customer identity is private per RFC-08. Exports to the business include customer DIDs (the Org's own customers — legitimate business relationship), but the protocol does not expose customer identities to any third party including compliance services, unless the business authorizes specific customer-level data export.
- When compliance requires disclosure (large-transaction reporting, regulated industries), the business handles it through its own processes subject to applicable law. The protocol doesn't push data to authorities.
- Subpoena / regulatory-demand scenarios: authenticatable chain data is available to the business; they decide how to respond. Same position as any business with digitally-signed records.

**Agent accountability.**

- Chain records who acted on behalf of the org, signed by their Person DID (per Q4). Useful for compliance (responsible-person identification, agent-authorized transactions) and creates real accountability traces.
- The protocol makes individual actions legible; it does not adjudicate whether a specific action was compliant with tax or labor law. That's the business's judgment and their jurisdiction's rules.

**MJN vs MJNx tax handling: defer to RFC-12.**

- Token classification (security / utility / stable-equivalent) determines tax treatment. Different classifications carry very different regulatory consequences.
- RFC-12 is working through legal review; RFC-08 defers.
- **What RFC-08 does commit to:** transaction records identify denomination (MJN / MJNx / CHF-equivalent) so downstream compliance tooling has the raw data needed for whatever classification applies.

---

## What this leaves open

Six things this response deliberately does not resolve:

1. **Aggregate-query indexing infrastructure** for parent/child Org DIDs (Q3). Brand-level reputation and cross-location metrics need an index layer. Follow-on infrastructure work.

2. **Export schema specifications** for tax/accounting tooling (Q6). CSV, QuickBooks, Xero, Sage formats all need documented mappings. Tooling work.

3. **Empirical threshold calibration.** Thin/substantial boundary for soft→claimed verification (Q2), action-typed permission granularity per service (Q4), and specific jurisdictions-list conventions (Q6). Numbers/patterns tune with observation.

4. **Customer consent for transaction data disclosures** (Q6). Sits with RFC-10 (Sovereign User Data); compliance disclosures need consent handling that isn't RFC-08's to specify.

5. **MJN/MJNx tax classification** (Q6). Waits on RFC-12's legal review.

6. **Cross-jurisdictional edge cases** (Q6). Swiss-registered org transacting with EU customers under EU VAT rules; US org with Canadian franchisees; etc. These are case-by-case questions that third-party compliance services exist to solve — not protocol spec territory.

---

## Anchor to existing work

- **April 7 forest infrastructure** — `scope: 'org'` is the shipped substrate. RFC-08 specifies what org forests are; Q4 role templates sit on top of shipped service-scoped permissions.
- **RFC-07 response (Cultural DID)** — parallel primitive. Q5 resolves cross-primitive interaction (Observer-only, Person-above-Observer bedrock, covenant toggle). Q3 parent/child topology extends the RFC-07 Q7 steward-node pattern to orgs.
- **RFC-15 response (Trust Accountability)** — Q3 franchise affiliations use RFC-15 bilateral attestation countersigning. Q2 challenge-window adjudication uses the RFC-15 appellate-pool substrate.
- **RFC-17 response (Governance Primitive)** — forks-reversible and history-preserved bedrock shapes Q2's claim history, Q3's affiliation lineage, and Q4's role-change audit trail.
- **RFC-01 response (.fair Attribution)** — "tool suggests, human decides, reason recorded" pattern applies to Q4 role assignments (templates suggest, orgs decide, changes recorded) and Q6 transaction annotations (business annotates, protocol records).
- **RFC-10 (Sovereign User Data)** — customer consent for transaction data disclosure (Q6 privacy handling) depends on RFC-10 primitives.
- **RFC-11 (Embedded Wallet)** — Q4 treasury signing authority and Q6 denomination identification depend on the wallet primitive for MJN handling.
- **RFC-12 (MJN Token Economics)** — Q6 tax classification deferred to RFC-12's pending legal review.
