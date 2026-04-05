## 29. Attestation Completeness — The Trust Bootstrap Problem

**Author:** Greg Mulholland
**Date:** March 27, 2026
**Priority:** HIGH — the trust graph is structurally hollow without this
**Matrix cells:** All scopes × Attestation (the primitive everything else depends on)
**Related issues:** #461 (attestation chain coverage), #321 (progressive trust), #25 (demo), #163 (bilateral attestations)
**Related concerns:** C02 (.fair automated nodes), C12 (consent primitive), C15 (agent authority scope)
**Related proposals:** P01 (resolved — Progressive Trust), P02 (resolved — Trust Accountability), P07 (resolved — Cryptographic Trust Layer), P08 (resolved — Attestation Data Layer), P28 (Launch Readiness)

---

### 1. The Problem — and the March 28 Response

When this proposal was written (March 27), six attestation types were emitting. The signing primitives worked but the wiring was incomplete.

**On March 28, Ryan shipped #461 — "attestation chain coverage: emit at all trust-relevant seams."** This commit added 8 new attestation types across 8 files (coffee, connections, events, market, profile). This is a direct response to this proposal's audit.

### 2. The Coverage Audit — UPDATED April 3

**Pre-#461 state (March 27):** 12 types across 6 services.
**Post-#461 state (March 28):** 19 types across 8 services.
**Post-April 1 regression:** `institution.verified` disabled (commit e8a28a1e) — event DIDs lack keypairs. **18 of 26 seams now emitting.**

| Seam | Service | Emitting? | Type | Notes |
|------|---------|-----------|------|-------|
| Payment settled | pay | **Yes** | `transaction.settled` | Pre-existing |
| First purchase | pay | **Yes** | `customer` | Pre-existing |
| Connection invited | connections | **Yes** | `connection.invited` | Pre-existing (×2 paths) |
| Connection accepted | connections | **Yes** | `connection.accepted` | Pre-existing |
| Vouch given | connections | **Yes** | `vouch` | Pre-existing |
| Pod member added | connections | **Yes** | `pod.member.added` | Pre-existing (pods + groups) |
| Pod member removed | connections | **Yes** | `pod.member.removed` | Pre-existing (pods + groups) |
| Pod role changed | connections | **Yes** | `pod.role.changed` | Pre-existing (pods + groups) |
| Event check-in (institution) | events | **DISABLED** | `institution.verified` | **REGRESSED** — event DIDs lack keypairs (#537). Requires sub-identity delegation model. |
| Event check-in (attendance) | events | **Yes** | `event.attendance` | Pre-existing |
| Course enrolled | learn | **Yes** | `learn.enrolled` | Pre-existing |
| Course completed | learn | **Yes** | `learn.completed` | Pre-existing |
| **Tip received** | coffee | **Yes** | `tip.received` | **NEW — #461** (fiat + SOL paths) |
| **Pod created** | connections | **Yes** | `pod.created` | **NEW — #461** |
| **Event created** | events | **Yes** | `event.created` | **NEW — #461** |
| **Ticket purchased** | events | **Yes** | `ticket.purchased` | **NEW — #461** (confirm + webhook paths) |
| **Listing created** | market | **Yes** | `listing.created` | **NEW — #461** |
| **Listing purchased** | market | **Yes** | `listing.purchased` | **NEW — #461** |
| **Handle claimed** | profile | **Yes** | `handle.claimed` | **NEW — #461** |
| **Media uploaded** | media | **No** | `media.uploaded` | Creative contribution not recorded |
| **Chat message signed** | chat | **Partial** (#422) | `message.signed` | Signing works; not emitting as attestation |
| **Founding contribution** | pay | **No** | `supporter.founding` | Early supporter proof missing (#474) |
| **Agent action** | auth | **No** | `agent.action` | Agent behavior untraceable |
| **Check-in at business** | places (not built) | **No** | `checkin.verified` | Business trust signal absent |
| **DID key rotated** | auth | **No** | `key.rotated` | Key rotation events invisible to trust graph |
| **Chain presented** | auth | **No** | `chain.presented` | External DFOS onboarding invisible |

**Eighteen of twenty-six identified seams are now emitting.** The remaining 8 gaps fall into four categories:

1. **Regressed (needs sub-identity model):** `institution.verified` — event DIDs are service identities without keypairs. Fix requires #537 (sub-identity delegation).
2. **Deferred (not blocking launch):** `media.uploaded`, `message.signed` (as attestation), `key.rotated`, `chain.presented`
3. **Post-fundraise:** `agent.action`, `checkin.verified` (requires places service)
4. **Immediate priority:** `supporter.founding` (#474 — needed for Founding Supporter tier)

Standing computation has 18 signal types to work with — still sufficient for meaningful trust differentiation. The `institution.verified` regression is architectural (event DIDs need keypairs) rather than a wiring gap.

### 3. Why This Matters More Than It Looks

#### 3.1 The Bootstrap Paradox

This is not a feature gap. It's a **bootstrap paradox**: the trust graph needs attestations to be meaningful, but attestations need the trust graph to be meaningful (because issuer standing weights the attestation). If the initial attestation coverage is too sparse, the trust graph never bootstraps — standing computation returns approximately the same score for everyone, and the three-tier model collapses into a binary (connected / not connected).

Consider two hypothetical community members after 30 days on the network:

**Member A** (active participant):
- Bought 4 event tickets
- Attended 3 events (checked in)
- Completed 1 course
- Purchased 2 items on the marketplace
- Uploaded media with .fair attribution
- Connected with 12 people

**Member B** (passive):
- Connected with 3 people
- Logged in twice

With current attestation coverage (6 types), both members look almost identical to standing computation:
- Member A: `connection.accepted` × 12, `transaction.settled` × 6, `session.created` × N
- Member B: `connection.accepted` × 3, `session.created` × 2

Member A's event attendance, course completion, marketplace activity, and content contribution are invisible. The 6× difference in genuine engagement collapses to a 2× difference in attestation count. Standing computation can't tell them apart meaningfully.

With full attestation coverage (21 types):
- Member A: 12 connections + 4 ticket purchases + 3 event check-ins + 1 course completion + 2 market purchases + 1 media upload + 6 settlements + N sessions = **~29 attestations across 8 types**
- Member B: 3 connections + 2 sessions = **5 attestations across 2 types**

Now standing computation can clearly differentiate. Member A has 6× more attestations AND 4× more type diversity. The signal is strong enough to drive the preliminary→established transition meaningfully.

#### 3.2 The April 1 Evaporation Risk

The April 1 demo will generate a burst of activity: 100+ people buying tickets, checking in, transacting. If `event.attended` and `ticket.purchased` attestations are not emitting, the highest-value trust signal in the project's history evaporates. The trust graph gains nothing from the launch party.

This is not abstract. After April 1, when Ryan activates the vouch flow (#321) and progressive trust, the system will need to distinguish "people who were at the launch party and have real skin in the game" from "people who connected to three existing members." Without event attendance attestations, it can't.

#### 3.3 The Investor Proof Point

For the fundraise that follows the demo, the attestation graph is the strongest proof of a living network. "120 identities" is a number. "4,200 cryptographically signed attestations across 15 types — verifiable without our server" is a protocol demonstration. But only if the attestations are being emitted.

### 4. The Minimum Viable Attestation Set

Not all missing types are equal. Here's the priority ordering based on signal value and implementation effort:

#### Tier 1 — Must Emit Before April 1 (1 day of work)

| Type | Service | Effort | Why Critical |
|------|---------|--------|-------------|
| `event.attended` | events | 2 lines | Physical presence = highest-value trust signal. Check-in endpoint exists. |
| `ticket.purchased` | events | 2 lines | Economic commitment to attend. Payment webhook exists. |

These are literally two `emitAttestation()` calls — one in the check-in handler, one in the payment webhook. The pattern is identical to what `connections` and `pay` already do. `emitAttestation` is a package-level utility that any service can import.

#### Tier 2 — Must Emit Before Founding Supporter (#474) (days)

| Type | Service | Effort | Why Critical |
|------|---------|--------|-------------|
| `supporter.founding` | pay | Small | Chain-backed contribution proof. The founding supporter tier IS this attestation. |
| `event.created` | events | 2 lines | Organizer contribution visible in trust graph. |

#### Tier 3 — Must Emit Before Progressive Trust (#321) Is Meaningful (week)

| Type | Service | Effort | Why Critical |
|------|---------|--------|-------------|
| `course.completed` | learn | Small | Verifiable education credential. |
| `market.purchased` | market | Small | Buyer-seller trust signal. Market is live — this should be emitting already. |
| `listing.created` | market | Small | Seller entry into trust graph. Market is live. |
| `media.uploaded` | media | Small | Creative contribution to the network. |
| `key.rotated` | auth | Small | Key rotation is a trust-relevant event — it changes the cryptographic root. |

#### Tier 4 — Federation and Future (post-fundraise)

| Type | Service | Effort | Why |
|------|---------|--------|-----|
| `chain.presented` | auth | Medium | External DFOS onboarding tracking. |
| `checkin.verified` | places | Large | Business check-in — requires places app (#392). |
| `agent.action` | auth | Medium | Agent behavior tracking — requires #465 (sandbox). |
| `message.signed` | chat | Medium | Already signing (PR #422); needs attestation emission. |

**Greg's position:** Tier 1 is a 1-day task. It should be done alongside the P28 wiring work — they touch the same files. Tier 2 is a prerequisite for #474. Tier 3 should be complete before #321 (progressive trust) goes live. Tier 4 is post-fundraise.

### 5. The Retroactive Attestation Question

120+ existing identities. Weeks of transactions. No attestation history for most of it.

Three options:

#### Option 1 — Start Fresh
Attestations begin from the implementation date. All prior activity is invisible to standing computation.

**Pro:** Clean data. No trust in historical records. Simple.
**Con:** 120+ identities start at zero standing. The progressive trust model can't differentiate founding participants from day-one newcomers. The trust graph has no memory of its own formation.

#### Option 2 — Full Backfill
Query `events.tickets`, `pay.transactions`, `connections.pod_members`, `media.assets` and generate attestations for all historical actions. Signed by the system DID, not bilateral.

**Pro:** Complete history. Standing reflects actual participation.
**Con:** Fabricated attestations for actions that weren't attested at the time. System-signed, not bilateral — violates the architectural principle that trust acts are bilateral. Data quality is uncertain for older records.

#### Option 3 — Selective Backfill (Recommended)
Only backfill economic actions (transactions, ticket purchases) that have verifiable records in the payment service. Social actions (connections) already emit attestations and don't need backfill. Don't fabricate attestations for actions that didn't record enough context.

**Pro:** Honest about what's verifiable. Economic transactions have Stripe receipts — they're the most trustworthy historical records. Social connections already emit.
**Con:** Partial history. Some real participation is invisible.

**Greg's position:** Option 3. Tag backfilled attestations as `legacy.seed` type — a distinct attestation type that indicates "this record was generated from historical data, not emitted at the time of the action." Standing computation should weight `legacy.seed` at 50% of live attestations. This is sufficient for bootstrapping, but live attestation history should accrue greater trust over time.

The `legacy.seed` type is also useful for the DFOS external onboarding flow (#424). When someone with an existing DFOS chain presents it to Imajin, their chain history could be imported as `legacy.seed` attestations — acknowledged but not fully trusted, because the originating context is external.

### 6. Standing Computation and Attestation Density

The standing computation formula from P07 §3.2:

```
standing(did) = f(
  positive_attestations(did),    // weighted sum by type and recency
  negative_attestations(did),    // flags, weighted by tier
  trust_graph_depth(did),        // BFS depth from trust-graph package
  fair_contribution_count(did),  // .fair manifests where did appears
  activity_recency(did)          // decay function on last attestation timestamp
)
```

This formula is correct. The problem is that the inputs are starved:
- `positive_attestations` — only 6 of 21 types contributing → thin signal
- `negative_attestations` — flag types not yet used → no negative signal at all
- `fair_contribution_count` — .fair coverage is sparse (P9: only 2 of 5+ upload paths) → undercount
- `activity_recency` — tracks only the 6 emitting types → inactive members who are actually active in non-emitting services (events, learn, market) look dormant

**The formula needs a diversity multiplier.** A DID with 10 attestations across 5 types is a more reliable signal than a DID with 10 attestations of 1 type. Attestation type diversity is a proxy for genuine engagement — it's hard to fake participation across events, payments, courses, and content simultaneously.

**Proposed addition to the standing formula:**

```
type_diversity_bonus(did) = log2(distinct_attestation_types(did) + 1) / log2(TOTAL_LIVE_TYPES + 1)
```

This scales from 0 (no attestations) to 1 (attestations in every type). It rewards breadth of engagement without penalizing specialization.

### 7. The Bilateral Attestation Gap

Issue #163 (Credentials: bilateral attestations + dispute chains) identifies a deeper architectural gap: most attestation types are currently unilateral (the service signs the attestation, the subject doesn't countersign). The DFOS countersignature primitive exists (PR #426 shipped countersignature attestations), but it's only wired for specific cases.

**Which attestation types should be bilateral:**

| Type | Should Be Bilateral? | Why |
|------|---------------------|-----|
| `event.attended` | Yes — event signs, attendee countersigns | Physical presence should be acknowledged by both parties |
| `transaction.settled` | Yes — already is (pay + recipient) | Economic acts bind both parties |
| `vouch` | Yes — voucher signs, system records | Already bilateral by design |
| `course.completed` | Yes — learn service signs, student countersigns | Verifiable credential requires both parties |
| `supporter.founding` | Yes — pay signs, supporter countersigns | Contribution should be acknowledged by contributor |
| `market.purchased` | Yes — seller and buyer both sign | Trust in marketplace requires bilateral acknowledgment |
| `session.created` | No — unilateral is fine | Login is a system event, not a social act |
| `connection.invited` | No — unilateral until accepted | Becomes bilateral via `connection.accepted` |

**Greg's position:** Don't block attestation emission on bilateral requirement. Emit unilateral attestations now (Tier 1–3). Upgrade to bilateral as the countersignature flow matures. A unilateral attestation is strictly better than no attestation. The bilateral upgrade can happen in-place — add a `countersignature` field to existing attestation types without breaking anything.

### 8. The Attestation Vocabulary Governance Question

As attestation types proliferate, who decides what types exist? Currently the vocabulary is implicitly governed — whatever `emitAttestation()` accepts is valid.

**Three options:**
1. **Hard-coded vocabulary.** Types are defined in `packages/auth/src/types/attestation.ts`. Adding a new type requires a code change. Strictest.
2. **Configuration-based.** Types are defined in a config file per service. Services declare what attestation types they emit. Adding a type requires config update, not code change.
3. **Open vocabulary with naming convention.** Any string is valid. Convention: `{service}.{action}` (e.g., `events.attended`, `market.purchased`). Most permissive.

**Greg's position:** Option 2 for MVP. Hard-coded is too rigid (adding a type shouldn't require a package release). Open vocabulary will cause naming drift and make standing computation unreliable ("is `event.attended` the same as `events.attendance`?"). Configuration-based gives each service ownership of its types while maintaining a discoverable registry.

The controlled vocabulary from P07/P08 should be the starting set. Services that want to emit new types declare them in their config, and the attestation layer validates against the service's declared vocabulary.

### 9. Implementation Path

| Phase | What | When | Effort |
|-------|------|------|--------|
| **Immediate** | Tier 1: `event.attended` + `ticket.purchased` in events | Before April 1 | 1 day |
| **Week 1** | Tier 2: `supporter.founding` + `event.created` | With #474 | 1 day |
| **Week 2–3** | Tier 3: `course.completed`, `market.purchased`, `listing.created`, `media.uploaded`, `key.rotated` | Before #321 | 3–5 days |
| **Week 3** | Selective backfill (Option 3) for economic transactions | After Tier 3 complete | 2 days |
| **Week 4** | Standing computation with diversity multiplier | After attestation coverage is sufficient | 3 days |
| **Post-fundraise** | Tier 4 + bilateral upgrades + vocabulary governance | When federation work begins | Ongoing |

### 10. Open Questions for Ryan

| Question | Why It Matters |
|----------|---------------|
| Can `event.attended` attestation be added to the check-in handler before April 1? | Highest-value trust signal from the demo |
| Does `emitAttestation` in `@imajin/auth` accept arbitrary type strings, or is the vocabulary enforced? | Determines if vocabulary extension requires code changes |
| Should standing computation go live before or after attestation coverage is complete? | Premature standing on sparse data is worse than no standing |
| Is `legacy.seed` backfill acceptable, or clean start? | Determines whether 120+ existing DIDs have standing history |
| Should the type diversity multiplier be part of the initial standing formula, or added later? | Complexity vs. accuracy tradeoff |
| Does #163 (bilateral attestations) need to be resolved before #321 (progressive trust), or can they proceed in parallel? | Dependency ordering |

### 11. Detecting Resolution

- [ ] `event.attended` attestation emitted on every check-in
- [ ] `ticket.purchased` attestation emitted on every ticket sale
- [ ] At least 12 of 21 attestation types actively emitting
- [ ] Standing computation produces meaningfully different scores for active vs. passive members
- [ ] `legacy.seed` backfill complete for economic transactions
- [ ] Attestation type vocabulary documented and discoverable

---
