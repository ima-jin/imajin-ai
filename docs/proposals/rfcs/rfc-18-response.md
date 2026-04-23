# RFC-18 Response: Media Revocation and Cross-Graph Attribution

**Responding to:** [RFC-18 — Media Revocation and Cross-Graph Attribution](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-18-media-revocation-and-attribution.md)
**Related:** RFC-01 (.fair Attribution from Commit History), RFC-07 (Cultural DID), RFC-15 (Trust Accountability), RFC-17 (Governance Primitive), #637 (.fair template wiring), #759 (@imajin/bus epic)
**Author:** Greg (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

RFC-18 is the mechanism RFC for content revocation. It sits downstream of RFC-01 (attribution exists in the first place) and upstream of parts of RFC-15 (accountability uses revocation to execute on certain outcomes). The RFC lays out a proposed three-tier model (Withdraw / Soft-revoke / Hard-revoke), five design questions, five open questions, and an MVP sketch.

This response closes the design and open questions as a bundle. The shape it arrives at: **three tiers are correct; each needs its own authority rules; the attestation chain is always preserved; federation is a signal not a mandate; legal compliance is outside the protocol's scope but inside its legibility.**

The mechanism is modest once the questions are settled — reference table, tagged-union signed op, tombstone rendering, federation wire format. The complexity is in how the pieces interact across trust tiers, visibility scopes, and jurisdictions.

---

## Core principle

**Revocation is a state change on content, not a rewrite of history.** The three tiers differ in what they do to the content (nothing / stop serving / remove bytes). What they share is that the signed attestation chain is always preserved. Forks are reversible (RFC-17 bedrock); signed operations are durable; display is mutable. Everything in the answers below falls out of that split.

---

## Answers to the Design + Open Questions

### Q1. Revocation semantics (three tiers, who can invoke)

**Three tiers as proposed, with subject-of-content as a first-class invocation path.**

- **Withdraw** — Attribution-layer revocation. A contributor removes themselves from the `.fair` chain. Content continues to serve; weight redistributes per covenant policy. Invocable by any chain member against their own entry.
- **Soft-revoke** — Content stops serving; bytes remain at rest. Reversible. Invocable by the original uploader, the chain primary, or a subject-of-content via RFC-15 subject-request.
- **Hard-revoke** — Bytes removed; attestation chain preserved with a tombstone at the revoked position. Requires a signed reason with a machine-readable category. Invocable by the original uploader, the chain primary, a subject-of-content via RFC-15 subject-request, or a legal-compliance path.

**Subject-of-content is a first-class path.** The original RFC frames revocation around the uploader; real cases (NCII, doxxing, incidental-capture in someone else's upload) require the subject to be able to invoke removal regardless of who uploaded. The mechanism is an RFC-15 subject-request that, if accepted, triggers a Hard-revoke with `revoker_authority: subject_of_content_via_rfc15`. For severe-act cases, RFC-15's severe-act direct path applies — immediate effect, appeal available.

**RFC-17 bedrock is satisfied under all three tiers.** The signed attestation chain is never erased. Hard-revoke removes content bytes and replaces the chain member's identity reference with a tombstone; the signed op itself stays in the DFOS chain forever.

### Q2. Cross-graph dedup and shared chains (bundles Design Q2 + Open Q1 + Open Q2)

**Opt-in dedup with visibility-scoped collision detection. Storage dedup is not attribution dedup.**

On upload, the media service computes the content hash and the visibility scope (`private | shared | public`). The dedup index is partitioned by visibility — a private upload can never collide with a public one, even if the bytes match, because they live in different partitions. Public-scope uploads check the public index; if a match exists, the uploader chooses:

- **Link to existing chain** — the uploader is appended to the existing `.fair` chain as a new attributor (subject to the countersigned-append rule from Q5).
- **Upload as new separate copy** — a new chain starts; two DIDs coexist for the same bytes. This handles convergent creation (two people independently arrive at the same result) without a special claim mechanism.

**Privacy preserved by construction.** Cross-scope collisions never surface. "Is this private file the same as someone's public file?" is a question the system structurally cannot answer, because the hash table it would consult doesn't exist across scopes.

**Revocation interaction with shared chains.** When a chain has multiple attributors (via link-to-existing), Hard-revoke by any single member becomes functionally equivalent to Withdraw — the bytes stay because other members haven't revoked. Full byte removal requires either unanimous Hard-revoke from all chain members, a legal-compliance escalation (Q8), or a subject-of-content request (which overrides all member preferences per RFC-15 severity rules).

### Q3. Reference tracking implementation

**Hybrid: reference table (source of truth) + event emission (push) + lazy resolution (safety net).**

- **Reference table** — `asset_references(asset_id, service, entity_type, entity_id, created_at)` owned by the media service. Services that embed media write on insert, delete on removal. This is the queryable "where is this used" data source — also powering the subject-of-content flow from Q1.
- **Event emission** — On revocation, media walks the reference table and emits targeted per-entity events (not a broadcast). Referencing services subscribe and handle per-tier.
- **Lazy resolution** — Services also check asset status at render time. If a push missed a row or arrived out-of-order, the render-time check catches it. 410-Gone / tombstone response handled gracefully.

The three mechanisms reinforce each other: push for speed, table for queryability, lazy for correctness.

**Migration path.** Once `@imajin/bus` (epic #759) is mature, the reference table can be derived from `asset.referenced` / `asset.dereferenced` events rather than written synchronously. Both patterns are acceptable; the migration is a bus-layer concern and outside RFC-18's scope.

**What's explicitly rejected:** event-only (loses queryable view needed for subject-of-content), lazy-only (doesn't meet Hard-revoke latency bar for sensitive material).

### Q4. Federation and sovereignty

**Wire format is specified; non-compliance consequences are not. The latter lives in a future federation-governance RFC.**

Revocation propagates across federation via the signed `content.revoked` DFOS op (Q7). Honoring nodes walk their local reference tables and take tier-appropriate action. Non-honoring nodes see the op and choose to ignore it.

**Intended direction (sketched, not settled):** tier-differentiated enforcement. Withdraw and Soft-revoke remain fully sovereignty-respecting — each node chooses compliance. Hard-revoke, reserved for legal/bedrock cases, ought to eventually carry network-level consequence: federation peers that routinely ignore Hard-revoke attestations within a bounded window should be defederable by honoring nodes. But that mechanism is a federation-governance primitive that applies beyond revocation (the same mechanism would cover nodes that ignore RFC-15 flags or attestation countersignatures), and designing it inside RFC-18 would under-specify it. RFC-18 names the gap; RFC-15 and a future federation-governance RFC fill it.

**Three scenario notes applied across any federation mechanism:**

- **Scenario 1 — my asset, federated to other nodes.** Revocation attestation is the mechanism; other nodes honor or don't.
- **Scenario 2 — another node's asset, surfaced on mine.** My node treats inbound revocation attestations as authoritative for their asset; it doesn't override my own `actingAs` data.
- **Scenario 3 — re-hosting (my node holds its own DID-bound copy of content originating elsewhere).** The re-host is a separate attestation event. Re-hosted asset has its own revocation rights; the original revoker can revoke the origin, but the re-host has independent status (though its attribution chain still points back, so the re-host's chain member goes tombstone-style on origin revocation).

### Q5. `.fair` chain attribution mechanics

**Core role vocabulary with namespaced extensions, primary as structural anchor, countersigned append, tombstone on member revocation.**

- **Vocabulary.** Core roles are ratified in the `.fair` spec: `creator | editor | translator | remixer | subject | transcriber | sampler | performer | curator`. Namespaced extensions are allowed (`community:mooi/listening-host`, `org:jin-lab/session-lead`); they carry no protocol-level weight semantics and are covenant-scoped.
- **Primary as structural anchor.** The first attributor is the chain's DID binding. Not a privilege-of-first; a structural property. The primary cannot be fully Hard-revoked from the chain — doing so would leave the chain with no identity root. If the primary invokes self Hard-revoke, it escalates to asset-level Hard-revoke (the whole thing comes down).
- **Append semantics.** Adding a new member requires the appender's signature AND a countersignature from the primary or an established chain member. This prevents unilateral append by unrelated parties ("attack on someone else's chain"). Open-contribution works (wikis, community songbooks) can relax this requirement via a covenant flag.
- **Weight distribution.** Entirely a function of the covenant policy from RFC-07 Q6 (`per_work` / `standing_ratio` / `hybrid(residual_pct)`). RFC-18 does not re-specify weight math; it says only "revoked members redistribute per the covenant's declared policy."
- **Revocation applied to chain members.**
  - **Withdraw** — attestation remains, weight set to zero, redistributed per policy. Chain displays name with "withdrawn" marker.
  - **Soft-revoke** — same as Withdraw but reversible.
  - **Hard-revoke** — signed op remains in the DFOS chain (RFC-17 bedrock); member's identity reference is replaced with a tombstone ref. Chain walks as `primary → editor → [revoked] → translator`. Weight redistributes per policy.

**Dependency flagged.** Q5 requires the `.fair` spec to ratify the core role vocabulary. That's a `.fair` repo change alongside the RFC-18 change — not an upstream-only change.

### Q6. Minimum viable version

**Ship all three tiers with federation wire format in v1. Defer the defederation consequence mechanism, subject-of-content flow, dedup optimization, and namespaced-role protocol handling.**

**v1 scope:**

1. Reference table + event emission (per Q3).
2. Three revocation tiers implemented end-to-end.
3. `content.revoked` tagged-union signed op (per Q7).
4. Tombstone rendering at the media service per tier.
5. `.fair` chain member revocation (per Q5).
6. Federation wire format: signed ops propagate; inbound ops walk local reference table; honoring-node default; non-compliance = silent ignore for now.

**Explicit v1 deferrals:**

- **Defederation / non-compliance consequence** — future federation-governance RFC.
- **Subject-of-content flow plumbed through RFC-15 subject-request primitive** — needs RFC-15 subject-request shipped first. Subject-of-content as an authority value can be reserved in the op schema from v1, but the end-to-end flow lights up when RFC-15 does.
- **Visibility-scoped dedup** — v1 ships with content-addressed-but-non-deduped storage (every upload is its own row). Dedup is an optimization that lights up later without changing user-visible behavior.
- **Namespaced role extensions** — v1 core vocabulary only. Namespaced strings can be accepted as opaque values from v1 with covenant-defined meaning; protocol-level handling comes later.

Splitting the three tiers across releases would either under-deliver on the urgent cases (Withdraw-only, Soft-only) or ship federation-unaware revocation (local-only with no propagation), which is actively misleading. The scope above is the smallest coherent cut.

### Q7. DFOS operation shape

**Single op type `content.revoked`, tagged union payload, separate `content.revocation.reversed` op.**

**Op shape.**

```
content.revoked {
  asset_id: CID
  revoker_did: DID
  revoker_authority: 'original_uploader' | 'chain_primary' |
                     'subject_of_content_via_rfc15' | 'legal_compliance'
  signed_reason: { category: string, text: string }    // signed by revoker
  references: [attestation_ref]                         // linked attestations
  timestamp: ISO8601
  prev_op: CID                                          // DFOS chain link
  revocation: {
    kind: 'withdraw' | 'soft' | 'hard'
    // kind-specific fields below
  }
}
```

**Tier-specific payload (tagged union):**

- `withdraw`: `chain_member_did` (which chain member is withdrawing — may differ from `revoker_did` if a steward executes on behalf under `actingAs`).
- `soft`: `restore_deadline?` (optional, covenant-configurable TTL), `restore_conditions?` (optional).
- `hard`: `removed_bytes_hash` (hash of bytes being removed — proof-of-deletion artifact), `tombstone_ref` (CID/URL the tombstone points to).

**Reversal op.**

```
content.revocation.reversed {
  reverses_op_id: CID     // the op being reversed
  reverser_did: DID
  signed_reason: { ... }
  timestamp: ISO8601
  prev_op: CID
}
```

**Only valid for `kind: 'soft'`.** Hard-revoke is terminal — bytes are gone; content restoration requires a new upload with new attribution, not a reversal. Withdraw has its own reversal semantics handled at the chain-attestation layer rather than via a revocation-reversal op (a withdrawn contributor re-appends via normal countersigned append).

**Why single op + tagged union.**

- Single subscription is a maintenance win: services that care about revocation subscribe once, dispatch on `revocation.kind`.
- Tagged union keeps tier-specific fields properly scoped without optional-field sprawl.
- Forward-compatible with DFOS namespace subscriptions if those ship later (tagged union migrates cleanly to `content.revocation.withdraw` / `.soft` / `.hard`).
- Separate reversal op rather than in-place mutation is the only option consistent with RFC-17 bedrock — the original signed op stays durable; reversal is a new signed op that references it.

**`revoker_authority` is load-bearing.** Honoring nodes use it to decide whether to accept the op:

- `original_uploader` — self-verifying against asset's origin attestation.
- `chain_primary` — self-verifying against the `.fair` chain.
- `subject_of_content_via_rfc15` — requires a linked RFC-15 subject-request op in `references`.
- `legal_compliance` — requires an attached signed jurisdictional reference in `references`.

Ordering and finality inherit from DFOS. `Soft-revoke → reversal → soft-revoke-again → hard-revoke` is a valid op sequence; current state = most recent op.

### Q8. Legal implications for federated nodes

**The protocol claims nothing legally. It names the mechanism hooks and points to a companion document.**

RFC-18 should include a short **Legal Considerations** section with this shape:

1. **Disclaimer.** "RFC-18 defines a mechanism for content revocation. It does not provide legal compliance. Operators are responsible for determining how the protocol's primitives satisfy their jurisdictional obligations and should consult counsel."
2. **Mechanism hooks.** Three pointers:
   - `revoker_authority: legal_compliance` for legally-originated revocations.
   - `signed_reason.category` for machine-readable categorization (e.g., `dmca_notice`, `gdpr_art_17`, `ncii_removal`, `court_order`).
   - `references` field for attaching jurisdiction-specific documentation (notice documents, court orders, subject identity proofs).
3. **30,000-foot example mappings.** Short paragraphs noting, without procedural guidance, how common regimes decompose:
   - **DMCA notice** → Hard-revoke with `revoker_authority: legal_compliance`, notice attached in `references`.
   - **GDPR Art. 17 erasure request** → Hard-revoke via `subject_of_content_via_rfc15` (or `legal_compliance` if operator-routed rather than subject-routed).
   - **NCII removal** → Hard-revoke via `subject_of_content_via_rfc15` with severe-act direct path per RFC-15; `signed_reason.category = 'ncii_removal'`.
   - Other regimes (NetzDG, UK Online Safety Act, etc.) follow similar mappings and live in the companion document.
4. **Pointer to companion document.** `docs/compliance/` (to be written alongside v1) carries operator playbooks and jurisdiction-specific guidance.
5. **Federation interaction for legal cases.** A legally-required revocation on Node A may or may not be legally required on Node B. The signed op federates regardless; Node B operators decide whether to honor it as a courtesy or policy matter, independent of their own legal obligation. This is the sovereignty answer from Q4 applied to legally-originated revocations.

**Companion doc is a deliverable, not a pointer into the void.** RFC-18 should name `docs/compliance/revocation-regimes.md` (or similar) as a concrete artifact shipped alongside v1, so the "legal guidance lives elsewhere" design doesn't collapse into "legal guidance gets written later and doesn't."

**What's explicitly rejected.**

- Pure "zero legal anything" — leaves every operator to re-solve the same problems, raising the cost of running a sovereign node. Small operators are exactly who the protocol wants running nodes; the protocol should lower compliance tooling cost without claiming compliance.
- A first-class `content.legal_hold` op — decomposes cleanly to Soft-revoke with a specific `signed_reason.category` and `references` to legal notice. Adding a fourth op type for what the existing three tiers already handle is premature specialization.
- In-line mappings in the RFC body — laws change on a different timescale than the protocol spec. Companion-doc split lets compliance guidance evolve without RFC amendment churn.

---

## What this leaves open

1. **RFC-15 subject-request primitive.** Q1 and Q7 both rely on RFC-15 providing the subject-of-content invocation path. The RFC-15 response sketches severe-act and standard-accountability flows; the subject-request primitive as a standalone DFOS op still needs its own design pass. Until it exists, subject-of-content revocation in RFC-18 is deferred to RFC-15's v-next.

2. **Federation-governance RFC.** Q4's "tier-differentiated enforcement / defederation for non-compliant nodes" is sketched as intended direction but not settled. It needs its own RFC because the mechanism generalizes beyond revocation (same machinery would apply to RFC-15 flag non-compliance, attestation countersignature refusal, etc.). RFC-18 names the gap and stops.

3. **`.fair` spec core role vocabulary ratification.** Q5 requires the `.fair` spec (not this RFC) to fix the core role list. That's a `.fair` repo change — propose-and-merge there alongside the RFC-18 amendment upstream.

4. **Companion compliance document.** Q8 names `docs/compliance/revocation-regimes.md` as a v1 deliverable. It doesn't exist yet. Operator playbooks for DMCA, GDPR, NCII, NetzDG, and other regimes are work items attached to the RFC-18 v1 milestone.

5. **Convergent-creation policy at chain-ownership level.** Q2 handles bytes-level convergent creation (link existing vs new copy at upload time). Conceptual-creation convergence (two people independently create the "same" melody without identical bytes) is out of scope for this RFC — it's an attribution-policy question for the `.fair` spec, not a revocation question.

6. **DFOS bus maturity threshold for Q3 migration.** The "D today, E when bus matures" phrasing needs someone to decide when "mature" is. This is an `@imajin/bus` epic #759 concern, not an RFC-18 concern, but flagging it so the migration doesn't stall on an unnamed criterion.

---

## Recommendation: ship order

1. **`content.revoked` op schema + DFOS registration** — unblocks every other piece. Ratify tagged-union shape early so clients can build to stable wire format.
2. **Reference table** — single schema, small surface. Backfill lazily; new uploads write rows from day one.
3. **Withdraw tier end-to-end** — simplest tier, exercises the append/revocation mechanics in the `.fair` chain without touching content delivery.
4. **Soft-revoke tier** — content delivery gating + reversal op. Exercises reference-table walk + event emission without byte removal.
5. **Hard-revoke tier** — byte removal + tombstone rendering. Needs all prior pieces + compliance disclaimer shipped with it.
6. **Federation wire format** — inbound/outbound signed op handling. Honor-by-default; non-compliance = silent ignore.
7. **`docs/compliance/revocation-regimes.md`** — operator-facing companion doc. Shipped alongside Hard-revoke tier at latest.

Items explicitly *not* v1: namespaced role protocol handling, visibility-scoped dedup, defederation mechanism, subject-of-content flow (until RFC-15 subject-request ships).

---

## Anchor to existing work

- **Current shipped state.** `.fair` attestations live in `auth.identities`; settlement uses them for events (`settleTicketPurchase()`); PR #637 wires commit-history sidecars into `apps/kernel/app/media/api/assets/route.ts`. No tombstones, no reference table, no revocation attestation — the revocation primitive is net-new.
- **RFC-01 response.** Core move: maintainer-declared weight. RFC-18 is the revocation side of that system — RFC-01 decides who shows up in the chain; RFC-18 decides how they come out of it.
- **RFC-07 response.** Q6 specifies covenant-level attribution policy (`per_work` / `standing_ratio` / `hybrid(residual_pct)`). RFC-18 inherits that policy for weight redistribution on member revocation — this RFC does not re-specify weight math.
- **RFC-15 response.** Subject-of-content and severe-act paths originate in RFC-15; RFC-18 is a consumer of those mechanisms via `revoker_authority: subject_of_content_via_rfc15`. The two RFCs need to land together for Hard-revoke via subject-request to work end-to-end.
- **RFC-17 bedrock.** "Forks reversible, signed operations durable" is the architectural constraint every tier of revocation respects. Soft-revoke is reversible by a new signed op. Hard-revoke removes bytes but leaves the signed attestation chain intact. There is no operation in RFC-18 that rewrites or deletes history.
- **@imajin/bus epic #759.** The long-term home for Q3's reference table derivation. RFC-18 v1 ships synchronous writes; migration to event-derived projection is a bus-layer concern, not a revocation-layer concern.
