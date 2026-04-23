## 12. Declaration Granularity Standards — Stream 2 Privacy Envelope

**Author:** Greg Mulholland
**Date:** March 10, 2026 (sharpened April 22, 2026)
**Thread:** `current-threads/declaration-granularity.md`
**Related upstream:** Discussion #253 (Stream 2), `packages/fair/` (for pattern reference), RFC-28 (Universal Real-World Registry — possible alternate pattern), P35 (Gas Governance and Rent-Extraction Limits — provides Option C)
**Addresses:** Outstanding Concern 6 (Declaration Granularity Standards)

---

### April 22, 2026 — Status Sharpening

**Still open. No code shipped against the privacy substance. Blocked on Stream 2 surface, not on implementation difficulty.**

**Explicit non-confusion:** P12 is NOT satisfied by `registry.did_interests` / `did_preferences` / `interests` in `apps/kernel/src/db/schemas/registry.ts` (shipped via #538/#539). Those tables are a **notification-channel consent** layer (lazy per-DID per-scope booleans: marketing/email/inapp/chat, populated from attestation activity). P12's declaration layer is the inverse direction: a user *states an intent* that businesses *query with offers*, with match counts returned under k-anonymity suppression. Different data flow, different threat model, different primitive.

**What has advanced adjacently:**
- **Identity tiers (preliminary/hard) shipped** — unblocks P12 §5's Soft-DID / Hard-DID gating for sensitive declarations. The gating mechanism now exists.
- **Ed25519 signing utilities mature in `@imajin/auth`** — signed-declaration infrastructure is ready when the type system lands.
- **P35 will answer Option C** (§2, economic-deterrence / probe rate limit) when Stream 2 exists — the frequency-scaled multiplier curve is the protocol-level expression of probe throttling.

**What complicates P12 since writing:**
- **RFC-28 Universal Real-World Registry** introduces a *public-stub* pattern (anyone creates stubs for venues/businesses, rightful owner claims later with commission split). This is the inverse of P12's private, k-anonymized local-match model. **Load-bearing open question below.**

**Load-bearing open question for Ryan (new April 22):**

> **Does Stream 2 adopt the RFC-28 public-registry pattern, or maintain the local-match model that P12 assumes?**
>
> - If RFC-28-pattern: P12's entire k-anonymity threat model needs to be replaced, not sharpened. Public stubs are observable by anyone; the attack surface is different.
> - If local-match: P12 remains the canonical answer and ratifies as-written with the §7 answers below.
>
> This is an architecture decision, not a proposal decision. P12 is blocked on it.

---

### Executive Summary

The Declared-Intent Marketplace uses local profile matching: a user declares interests on their own node, a business offers, the system returns a match count without the user's profile ever leaving their node. At coarse granularity — specialty coffee, live music — this is a strong privacy model.

The gap: match quality and privacy protection are inversely coupled at fine granularity. As declaration specificity increases — Ethiopian natural process, within 2km, Tuesday mornings, age 25–35 — the sum of a user's declared interests becomes a high-resolution behavioral profile. An adversarial business sending systematically varied offers and observing match counts can probe the local matching system to reconstruct that profile statistically, without ever receiving it directly. This is a known attack class (related to the linkage attack in differential privacy literature).

**Recommended solution:** k-anonymity threshold enforcement at the matching layer, combined with offer probe rate limits from the Gas Model Ceiling proposal. Users declare at any granularity they choose. The matching layer enforces the privacy guarantee structurally — through the mathematics of the matching computation itself.

### 1. The Privacy Guarantee — Where It Holds and Where It Breaks

**Declaration granularity levels:**

| Level | Example | Privacy status |
|-------|---------|---------------|
| L1 — Category | specialty coffee | Strong — match count is a genuinely aggregate signal |
| L2 — Subcategory | single origin, natural process | Holds — meaningful aggregate |
| L3 — Specific | Ethiopian natural process, within 2km | Weakened — match count narrows significantly |
| L4 — Behavioral | Ethiopian natural process, within 2km, Tuesday mornings, age 25–35 | Fails — sum of declarations begins to uniquely identify |

The inference attack requires only the ability to send many offers with systematically varying specificity and observe match counts. Gas cost provides economic friction but does not prevent inference — a well-funded adversary can afford to probe systematically.

### 2. The Three Defense Options

**Option A — Controlled vocabulary (reject):** Define a fixed taxonomy of declaration categories. Users can only declare from this vocabulary. Resolves the privacy problem by degrading the product. Rejects user sovereignty over their own declarations.

**Option B — k-anonymity threshold (recommended as primary):** Users declare at any granularity. The matching layer only uses a declaration in the match count if at least k users in the opted-in pool share that declaration. Fine-grained declarations matching fewer than k users are suppressed — invisible to the matching layer.

**Option C — Rate-limited offer probing (defense-in-depth):** Restrict how many distinct offers a business can send per time period. A patient adversary can still probe, but the rate limit slows the attack. This is the mechanism from the Gas Model Ceiling document — Mechanism B (per-recipient rate limit) and Mechanism C (frequency-scaled gas) both contribute.

**The recommended model:** Option B as primary + Option C as defense-in-depth.

### 3. k-Anonymity Parameter Calibration

**The k threshold is the single most important design decision:**

| k value | Privacy level | Match pool impact |
|---------|--------------|------------------|
| k=3 | Minimal | Very few declarations suppressed |
| k=5 | Standard (differential privacy convention) | Moderate suppression of fine-grained declarations |
| k=10 | Strong | Some L3 declarations suppressed; most L2 unaffected |
| k=25 | Strict | L3 and many L2 declarations suppressed |

**Recommended default: k=5**, with node operators able to increase (not decrease) the threshold.

**Sensitive category floor:** Certain declaration categories carry inherently higher inference risk and should have a higher minimum k enforced at the protocol level, not adjustable by node operators:

| Sensitivity class | Examples | Recommended minimum k |
|------------------|---------|----------------------|
| `standard` | Interests, hobbies, food preferences | k=5 |
| `temporal` | Time-of-day, day-of-week preferences | k=10 |
| `location` | Neighbourhood, distance radius | k=10 |
| `demographic` | Age range, household size | k=15 |
| `health` | Health conditions, dietary restrictions | k=25 |

### 4. The Declaration Type System

There is no declaration category type in any package. The `.fair` package has a role vocabulary but no equivalent for interest declarations. This proposal recommends a declaration type system modeled on the `.fair` package's pattern but structured for k-anonymity enforcement:

```typescript
export interface DeclarationEntry {
  did: string;           // declaring DID
  category: string;      // user-defined free text (no central vocabulary)
  sensitivity: 'standard' | 'temporal' | 'location' | 'demographic' | 'health';
  value: string;         // the declaration itself
  created: string;       // ISO 8601
  expires?: string;      // optional expiry
  signature: string;     // Ed25519 signature by declaring DID's keypair
}
```

**The `sensitivity` field is a controlled enum** that triggers the appropriate k threshold at the matching layer. The `category` field is user-defined free text — no central vocabulary, full user sovereignty.

**The `signature` field is critical:** User declarations signed by the declaring DID's keypair using the same Ed25519 signing infrastructure from the Attestation Data Layer proposal. Declarations are tamper-evident, portable (consistent with the BaggageDID model), and auditable.

### 5. Connections to the Architecture Series

**Attestation Data Layer:** The k-anonymity enforcement model requires the matching layer to know pool size — a query against the same trust graph data used for standing computation. The signing utilities in `@imajin/auth` should be extended or reused for declaration signing.

**Identity Tier Storage:** A Soft DID (Visitor) should not be able to make highly sensitive declarations, because the identity behind the declaration is not cryptographically verified. Sensitive category declarations should require at minimum a Hard DID (Preliminary).

**Gas Model Ceiling:** k-Anonymity provides structural protection; probe rate limits provide economic protection; frequency-scaled gas provides behavioral deterrence. Together they define the full privacy envelope of Stream 2.

**Org DID Vetting:** Systematic declaration probing is a covenant violation. A pattern of systematic probing should trigger a `flag.yellow` against that Org DID.

**BaggageDID:** Because declarations are signed by the declaring DID's keypair, they are portable. The BaggageDID's encrypted context layer should include the full declaration history. On a new node, declarations are available immediately; the k-anonymity computation is always local to the current pool.

### 6. The Complete Privacy Envelope for Stream 2

With both Gas Model Ceiling (Proposal 11) and Declaration Granularity resolved, the full privacy envelope of Stream 2 can be stated:

- **Structural protection:** Local matching means profiles never leave the user's node; k-anonymity means fine-grained declarations cannot be used to uniquely identify users even in aggregate
- **Economic deterrence:** Frequency-scaled gas prices saturation; probe rate limits slow inference attacks
- **Cryptographic tamper-evidence:** Declarations are signed by the declaring DID — tamper-evident and portable

### 7. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Default k threshold: 5, 10, or higher? | Core privacy guarantee | k=5 default, node operators can increase |
| Should sensitive category floors be protocol-level or node-configurable? | Governance of privacy baseline | Protocol-level minimums — nodes cannot reduce below floor |
| Who governs sensitivity classification for new declaration types? | Extensibility of the type system | Protocol proposal process, similar to IETF; Cultural DIDs can add community namespaces |
| Should a Soft DID be able to make any declarations, or only standard-sensitivity? | Identity verification and declaration integrity | Soft DIDs: standard only; Hard DID Preliminary+: all sensitivity levels |
| Should the noise addition option (differential privacy extension) be in MVP? | Stronger privacy at cost of implementation complexity | Defer to post-MVP hardening phase |
| Declaration portability: should declarations be included in the BaggageDID? | User sovereignty over their own declared context | Yes — full declaration history in encrypted BaggageDID layer |
| Where does the `packages/declarations/` package live — standalone or merged into `packages/fair/`? | Package architecture | Standalone — declarations and attribution are distinct concerns |

**Detecting resolution in the repo:**
- New `packages/declarations/` (or declaration types added to `packages/fair/`)
- `DeclarationEntry` type with `sensitivity` enum and `signature` field
- Matching layer in Stream 2 applies k-anonymity threshold check before returning match counts
- Sensitive category floor constants defined at protocol level
- `@imajin/auth` signing utilities used for declaration signing

### Roadmap Placement — 2026-03-13

Assigned to **Phase 3** in Ryan's .fair Hardening Roadmap. Needs a dedicated upstream issue filed. Suggested home: `packages/declarations/` or as a Stream 2 sub-tracker. No blocking dependency on Phase 1 or 2, but the Ed25519 signing utilities from Phase 1 (#316) are a prerequisite for signed declarations.

---

