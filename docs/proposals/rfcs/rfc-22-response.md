# RFC-22 Response: Federated Authentication

**Responding to:** [RFC-22 — Federated Authentication](https://github.com/ima-jin/imajin-ai/blob/main/docs/rfcs/RFC-22-federated-authentication.md)
**Related:** RFC-13 (Progressive Trust), RFC-14 (Community Issuance Network), RFC-15 (Trust Accountability), RFC-17 (Governance Primitive), RFC-18 (Media Revocation), RFC-21 (Imajin Conformance Suite), PR #244 (Delegated App Sessions), @imajin/bus epic #759
**Author:** Greg (kimaris@gmail.com)
**Status:** Draft response for community discussion

---

## Framing

RFC-22 is Ryan's March 30 proposal (co-designed with Brandon at Clearbyte/DFOS and Vinny) — the cross-platform federated authentication protocol. The RFC is more concrete than most prior RFCs: flow diagrams, artifact format, security considerations, phased implementation plan. It leaves eight open questions, roughly clustered into design core (Q3 artifact signer, Q4 trust-level differentiation, Q2 scope vocabulary), lifecycle (Q5 session duration, Q8 mutual registration), alternative flows (Q6 localhost, Q7 NFC), and coordination timing (Q1).

This response closes all eight. Answers compose with decisions in adjacent RFCs — particularly RFC-14 (issuance-authority mechanics for NFC cards), RFC-15 (severe-act requiring user-controlled signing), RFC-17 (bedrock decisions TTL), and RFC-18 (signed-op-driven state changes, chain as source of truth).

---

## Core principle

**The user's key signs, always. Custody is a verifiable claim about *how* they authenticated, not a property of *who* signed.** This keeps the cryptographic verification path uniform across all tiers and custody models, preserves portability when users migrate between platforms, and forces the trust-strength distinctions (which operations require hardware vs. custodial) to live in a first-class `authMethod` claim rather than in the signing scheme. The rest of the answers follow: operation classes enable ecosystem-wide reasoning about severity; chain-state drives session invalidation; privacy-by-default governs registration.

---

## Answers to the Eight Open Questions

### Q3. Artifact signer for custodial users

**User's key signs always. Platform is custodian of the key, not signer of the assertion. `authMethod` is a first-class verifiable claim in the artifact indicating how the user authenticated.**

For custodial users, the platform performs the KMS operation on the user's behalf — the resulting signature is cryptographically the user's own, verifiable directly against their chain's public key. For self-sovereign users, nothing changes from today's flow. The verification path is identical across custody models:

```
1. Decode JWS, extract signer DID
2. Look up signer's chain on peered relay
3. Verify signature against chain's public key
4. Verify challenge + audience + expiry + consent
```

**The `authMethod` field carries the distinction that matters:**

- `hardware-key` — physical device, user-held
- `biometric` / `password` — user's device, local credentials
- `custodial` — platform-managed via KMS
- `email-verify` — out-of-band (tier 3 fallback only)

Services gate on `authMethod` per Q4 when they need to. The protocol does not encode the custody distinction in who-signs because doing so would:

1. Break cryptographic uniformity (different verification paths for different custody models).
2. Lose portability across custody changes (a user migrating from DFOS custodial to self-hosted would have artifact history that's structurally different pre- and post-migration).
3. Close off the "authenticate where you're sovereign" story — the user's identity chain becomes a thing the platform asserts about rather than a thing the user is.

**KMS-compromise blast radius is no worse than the alternatives.** A compromised KMS is a full breach whether user-keys or platform-keys are held — it can sign arbitrary things either way. User-key-via-KMS is not structurally safer than platform-key; it's structurally *more consistent*, which is what matters.

### Q4. Trust level differentiation

**Protocol publishes method-category and operation-class vocabularies. Protocol mandates one specific floor: `severe` and `rotate` operations SHALL require minimum `user-local` category. Everything else is service-configurable, with non-binding default guidance.**

**Method categories (grouping of Q3's `authMethod` values):**

- `hardware` — physical device, user-held: `hardware-key`
- `user-local` — user's device, local credentials: `password`, `biometric`
- `custodial` — platform-managed via KMS: `custodial`
- `remote` — out-of-band verification only: `email-verify`

**Operation classes (stable vocabulary, referenced across RFCs):**

- `read` — no state change; public or consent-scoped data
- `write` — state change with limited blast radius (post a comment, add a connection)
- `purchase` — value-transfer, reversible-by-refund
- `rotate` — identity material change (key rotation, DID controller change)
- `severe` — identity-level or cross-community actions (RFC-15 severe-act, RFC-14 `issuance_authority` changes, RFC-17 bedrock governance votes)

**Protocol floor (one mandatory requirement):**

`severe` and `rotate` class operations SHALL require minimum `user-local` method category. Services MUST NOT accept `custodial` or `remote` for these classes. Rationale: RFC-15 severe-act and RFC-17 bedrock assume that only the rightful subject can act. Allowing custodial KMS to act as "the subject" for severe-act violates the cryptographic-only severity requirement (RFC-15 Q6b). This floor is protocol-enforced, not service-configurable.

**Default guidance for other classes (non-binding):**

| Class | Suggested minimum | Common practice |
|-------|-------------------|-----------------|
| `read` | any | any |
| `write` | any | any |
| `purchase` | `user-local` | `user-local` or higher for high-value |
| `rotate` | `user-local` (MANDATORY) | `hardware` recommended |
| `severe` | `user-local` (MANDATORY) | `hardware` recommended |

**Service declaration.** Services publish their class-to-minimum mapping in their federation metadata (at their node). When a user initiates federated auth, they can see what the service requires before consenting.

**Consequence for RFC-22 framing.** Tier 1 (direct key) and tier 2 (consent redirect) are cryptographically identical under Q3 — both produce user-signed artifacts. The RFC-22 framing should be updated: **tiers describe the flow, methods describe proof strength, and they're orthogonal.** A tier 2 consent redirect from a user with a hardware key is stronger than a tier 1 direct auth with a custodial key.

**Deferred to v-next:**
- Fully generalized framework where every class has a protocol-mandated floor.
- Auto-renegotiation: if artifact method doesn't meet service's requirement, the auth flow re-prompts with stronger method.
- Protocol-layer enforcement of the non-binding defaults.

### Q2. Scope vocabulary

**Core vocabulary of 5 scopes + optional hierarchical sub-scopes + namespaced extensions with mandatory metadata + preview-based consent screens.**

**Core vocabulary (ratified in RFC-22 v1):**

- `identity` — DID only (the fact that this DID is on a chain; no more)
- `email` — verified email address
- `profile` — display name, avatar, optional bio (coarse bundle)
- `standing` — tier (Soft / Preliminary / Established) per RFC-13
- `attestations` — structured attestation list filtered to what's protocol-public

**Hierarchical sub-scopes (optional, where useful):**

- `profile.display_name`, `profile.avatar`, `profile.bio` — coarse or fine
- `attestations.issuance_authority` (RFC-14), `attestations.fair_contributions` (RFC-01), etc.

**Namespaced extensions (the ecosystem pattern):**

- Format: `<namespace>:<scope-path>` — e.g., `dfos:presence_history`, `mooi:attendance_log`
- Namespace ownership = node ownership. DFOS defines `dfos:*`; Mooi defines `mooi:*`. No central registry.
- Each extension MUST carry three pieces of metadata: (1) human-readable name, (2) one-sentence description, (3) preview endpoint. Without all three, the scope cannot appear on a consent screen.
- Registration: platforms publish their scope registry at a well-known URL (suggest `/.well-known/auth-scopes.json`). Requesting services resolve namespace → scope metadata → render consent screen.

**Consent screen is preview-based, not category-based:**

- User sees the actual value being disclosed where previewable.
- For derived or stream-based scopes, the screen shows a summary ("30 days of presence events, last event 2 days ago") with a link to the full preview before consenting.
- Users can deny individual scopes; the artifact's `consented` field carries only what was approved.

**Why this shape:** matches the extensible-vocabulary pattern used in RFC-18 Q5 (role vocabulary) and RFC-14 Q2 (verification claims) — consistent across RFCs, implementers learn one pattern. Preview-based consent is what sovereignty actually means: informed consent is over *values*, not category names.

**Deferred to v-next:**

- Scope-access TTL (does consent persist across sessions, or expire with artifact?) — likely per-session with re-consent required for new sessions; long-lived tokens are a separate RFC.
- Scope revocation (user revokes a previously-granted scope) — likely via a `scope.revoked` DFOS op, parallel to RFC-18 revocation ops.
- Off-chain data consent — platforms holding off-chain user data (messages, presence) use namespaced extensions to express it.

### Q5. Session duration

**Chain-state is the primary invalidation mechanism. Method-tiered default durations are a backstop. Services can shorten but not lengthen.**

**Method-tiered default durations (protocol-set):**

- `hardware` — 30 days
- `user-local` — 7 days
- `custodial` — 24 hours
- `remote` (email-verify) — 1 hour

**Services can shorten these but not lengthen them.** A banking service enforcing 1-hour `custodial` sessions is reasonable; a photo-sharing service extending `custodial` to 30 days would undermine the protocol's method-tier semantics. Ceilings are protocol-enforced; floors are service-configurable.

**Chain-state is primary invalidation.** Requesting services subscribe to chain updates for their active federated sessions. A `session.revoked` DFOS op on the user's chain immediately invalidates sessions referencing the affected key. This op fires automatically on:

- Explicit logout (user-initiated, from any node).
- Key rotation (Q4 `rotate` operation — user-local or hardware required per Q4 floor).
- RFC-15 severe-act outcomes.
- RFC-13 demotion affecting the user's network standing.

**No home-platform session-state polling.** RFC-22 does not require session-state API coupling between requesting service and home platform. The chain is the sovereign source of truth; home-platform session state is irrelevant to the requesting service unless the home platform emits a chain op.

**The three clocks, resolved:**

1. **Artifact expiry (5 min)** — unchanged. One-time use during handshake.
2. **Session lifetime** — method-tiered default + service-set ceiling.
3. **Home-platform authentication state** — irrelevant unless expressed as a chain op.

**Key rotation is the load-bearing case.** When a user rotates their key, all existing federated sessions using the old key invalidate immediately via chain state. This is the one behavior the session model MUST get right — a compromised-and-rotated key invalidates everything, everywhere, within seconds.

**Chain-subscription scale note.** F requires services to subscribe to chain updates for active sessions. The @imajin/bus epic (#759) is the right substrate; v1 can poll chain state on each authenticated request if subscriptions aren't ready. Same pattern as RFC-18 Q3 — sync today, bus-derived later.

**Deferred:**

- Session restoration after chain event: no special pathway; re-auth through consent flow with new key is the pathway.
- Long-lived tokens / refresh-token equivalent: separate RFC, touches PR #244 (Delegated App Sessions) territory, not Q5.

### Q8. Mutual registration

**Privacy-by-default baseline (chain ops only). Opt-in home-platform dashboard for users who want it. Per-session override both directions.**

**Baseline (no registration required):**

- `session.revoked` chain op from Q5 is the universal logout-everywhere primitive. Works without any mutual registration — the chain broadcasts revocation to subscribed services.
- A user without mutual registration has full security control over their federated sessions via chain ops. Only the dashboard UX is absent.

**Opt-in mutual registration (for users who want the dashboard):**

- Home platform provides a setting: "Track my federated sessions." Default OFF (privacy-by-default).
- When ON, successful federated auths result in a signed `session.registered` notification to the home platform, carrying:
  - Requesting service DID and URL
  - Timestamp
  - `authMethod` category (not exact method — home platform doesn't need to know whether it was fingerprint or face ID)
  - Expected session expiry (per Q5)
- Home platform stores these and surfaces them in a user dashboard showing "Your active federated sessions," with one-click logout per session and logout-everywhere.

**Per-session override:**

- Even with home-platform tracking ON, the consent screen includes an option: "Don't record this session at home."
- With tracking OFF, the consent screen includes: "Record this session at home so I can track it."
- Useful for users whose default is one way but want occasional exceptions.

**What gets registered (minimal):** requesting service DID + URL, timestamp, authMethod category, expected expiry.

**What does NOT get registered:** scope data (home platform already knows, it signed), activity on the requesting service (out of scope), location beyond what's inherent in the service DID.

**Mutual cancellation:** when home-platform tracking is on and the user initiates logout from the home dashboard, the home platform emits `session.revoked` on behalf of the user's chain. Requesting service sees the chain op and invalidates — same mechanism as direct user revocation.

**Why this shape:** privacy-by-default is a sovereignty property. Users control whether their home platform gets to know where they authenticate. Mandatory push (B) mission-creeps the home platform into surveillance; no registration at all (A) impoverishes the UX. Opt-in with override gives both.

**Deferred:**

- Format of `session.registered` push — likely a direct service-to-service HTTPS call to a home-platform endpoint (UI data, not chain state), but mechanism needs spec'd.
- Retention policy at home platform — user-configurable; not protocol-specified.
- Cross-platform dashboard format — UI feature of home platform, not RFC-22.

### Q6. Local-first / localhost home platform

**Localhost is a supported pattern. RFC-22 includes brief guidance; specifics deferred to a local-first implementation doc.**

**Guidance (ratified in RFC-22):**

- Localhost is a valid home-platform URL. The consent-redirect flow works identically.
- **Port.** Home-platform binaries accept a configured port with a protocol-reserved default: **port 7199** (aligned with the `7xxx` prod range for local-first home platforms). Overridable per user config.
- **Callback delivery.** Localhost home platform opens the callback URL directly in the user's browser (same mechanism as remote home platforms).
- **TLS.** HTTPS requirement is **relaxed for `localhost` origins only**. All non-localhost origins MUST use HTTPS.
- **First-use registration.** Local-first home platforms are expected to handle first-use registration via an included setup flow; specifics deferred to the local-first implementation RFC (Brandon's Go binary doc when it exists, or a new RFC).

**What this addresses:** the "home platform running on a user's own device" case that's coming with Brandon's Go binary. The flow works with minor adaptations; RFC-22 names them so implementers are consistent.

### Q7. NFC card auto-redirect

**NFC is a discovery mechanism for the existing flow, not a new flow. RFC-22 adds a short "Card-Based Discovery" section with security considerations.**

**Guidance (ratified in RFC-22):**

- NFC cards that pre-populate home-platform URL MUST be signed by the issuing institution's Org DID (per RFC-14 `issuance_authority` mechanics). Card carries: user DID, home-platform URL, institution DID, institution signature.
- Requesting services verify the card's institution signature against the institution's chain before initiating the auth flow. Unsigned or unverifiable cards MUST be rejected.
- Consent screen MUST display the home-platform URL prominently so users can catch mismatches (phishing mitigation).
- **Card revocation.** Two paths:
  - **Per-card revocation** (`card.revoked` on user's chain) — user-initiated for lost or stolen cards; revokes just that card while preserving others.
  - **Institution-level revocation** (`issuance_authority.revoked` from RFC-14) — for compromised institution keys; revokes all cards issued by that institution.

**All RFC-22 protocol semantics apply identically once the redirect begins.** NFC just fills the "which home platform?" step automatically.

**Deferred:**

- Exact `card.revoked` DFOS op shape — parallel to RFC-18 revocation ops, likely a tagged union on a generic `credential.revoked` op. Dedicated ops-spec RFC territory.
- NFC card physical format (fields, signing algorithm, data layout) — lives in RFC-14 addendum or a dedicated "issuance credential formats" RFC.

### Q1. DFOS coordination and timeline

**Three-track build: Tier 1 (Imajin-Imajin) ships first standalone; Tier 2 (consent endpoint) parallel-builds with DFOS; Phase 3 items after v1.**

**Track 1 — Tier 1 (Imajin-Imajin direct key):**

- Direct key auth between verified Imajin nodes (ATX, NYC, LIS relays).
- Validates: JWS artifact format, scope vocabulary, chain verification flow, session lifecycle, method-tier semantics, `session.revoked` chain ops.
- Does NOT require: consent endpoint UI, DFOS coordination, mutual registration UI.
- Timeline: 4-6 weeks from RFC ratification, depending on capacity.

**Track 2 — Tier 2 (Imajin consent endpoint) parallel build with DFOS:**

- Imajin builds `/auth/consent` + `/auth/callback` on its own platform.
- DFOS builds equivalents on theirs.
- Shared spec: RFC-22 v1.
- Interop testing: weekly sessions starting when both sides have v0.1 endpoints responding.
- Timeline: ~2 months elapsed, conditional on both teams' capacity.

**Track 3 — Discovery + NFC + mutual registration + offline — after v1:**

- Beacon-based home-platform discovery.
- NFC card auto-redirect per Q7.
- Opt-in mutual registration per Q8.
- Offline / local-first per Q6.
- Timeline: Phase 3, post-v1.

**Interop coordination artifacts:**

- **Canonical test vectors.** RFC-22 publishes a set of signed JWS artifacts with expected verification outcomes. Both Imajin and DFOS run these through their implementations; divergence surfaces at test-vector level, not live-interop level.
- **Reference implementation hosted.** Imajin hosts a public reference endpoint that DFOS integration tests can hit. Maintenance and cost borne by Imajin Inc. as reference-implementer.

**Weekly interop cadence during parallel build:**

- Brandon / Ryan / Vinny + Greg sync weekly.
- Standing agenda: spec ambiguities surfaced, test-vector additions, timeline updates.
- Ends when v1 is mutually shipped.

**Spec amendment governance during parallel build:** if interop testing surfaces a spec ambiguity requiring amendment, RFC author (Ryan) + co-author (Brandon) agree on the resolution, document in an amendment PR, both teams apply. Standard RFC amendment process, worth noting since parallel build is relatively unusual for Imajin.

**Why this shape:** Tier 1 derisks the core primitives without cross-org coordination — fixing issues surfaced in Imajin-only testing is cheap compared to fixing them after cross-platform integration. Parallel Tier 2 build captures DFOS's capacity whenever it's available without blocking Imajin. Test vectors as a coordination mechanism remove most spec-ambiguity failure modes.

---

## What this leaves open

1. **`session.revoked` DFOS op specification.** The op shape is referenced across Q5, Q6, Q7, Q8 but not fully specified in this RFC. Lives in a dedicated ops-spec RFC parallel to RFC-18's `content.revoked` work. Can share the tagged-union structure pattern.

2. **Scope-registry publication format.** Q2 says platforms publish at `/.well-known/auth-scopes.json` but doesn't define the schema. v1 should ratify the schema alongside the core vocabulary.

3. **Operation-class vocabulary as a cross-RFC primitive.** Q4 introduces `read | write | purchase | rotate | severe` and says RFC-14, RFC-15, RFC-17, RFC-18 all reference them. The vocabulary is introduced here but probably belongs in a protocol-primitives RFC with this one as a major consumer. Could be punted to a `docs/primitives/operation-classes.md` document that RFC-22 and the others cite.

4. **Local-first implementation RFC.** Q6 defers specifics to Brandon's Go binary doc or a new RFC. That doc's existence is a commitment, not just a pointer.

5. **Chain-subscription scale mechanism.** Q5 requires services to subscribe to chain updates for active sessions. At small scale (dozens of sessions per service), polling works fine. At 10k+ sessions, needs @imajin/bus or equivalent. Migration path is a bus-epic concern, not an RFC-22 concern, but worth naming.

6. **Tier 3 (email verify) sunset plan.** Once Tier 2 is universally available (both Imajin and DFOS consent endpoints live), Tier 3 becomes redundant for most cases. Probably stays in spec as graceful-degradation for platforms without consent UI. Whether it's first-class or deprecated-from-day-one needs a decision.

7. **Mutual-registration op format.** Q8's `session.registered` notification — probably a direct HTTPS call from requesting service to home platform, but wire format and authentication (is the notification signed by the requesting service?) need specifying.

---

## Recommendation: ship order

**Phase 1 (now → 6 weeks post-ratification) — Tier 1 standalone:**

1. RFC-22 v1 ratified with Q1-Q8 answers applied.
2. JWS artifact format finalized with canonical test vectors published.
3. Scope-registry schema defined; core vocabulary published at `.well-known/auth-scopes.json`.
4. Operation-class vocabulary published (probably as `docs/primitives/operation-classes.md`).
5. Imajin node-to-node direct key auth (Tier 1) shipped: ATX → NYC → LIS tested.
6. Chain-driven session invalidation implemented; `session.revoked` DFOS op spec'd.
7. Method-tiered durations + service-declared ceilings wired.

**Phase 2 (parallel with Phase 1, ~2 months) — Tier 2 consent endpoint:**

8. Imajin `/auth/consent` + `/auth/callback` endpoints shipped.
9. DFOS consent endpoint shipped in parallel.
10. Weekly interop testing cadence during build.
11. Preview-based consent screens (Q2) live.
12. Tier 2 flow validated end-to-end Imajin ↔ DFOS.

**Phase 3 (post-v1) — discovery, NFC, mutual registration, offline:**

13. Beacon-based home-platform discovery.
14. NFC card auto-redirect (Q7) with institution signature verification.
15. Opt-in mutual registration (Q8) with home-platform dashboards.
16. Local-first / localhost support (Q6) once Brandon's Go binary ships.
17. Operation-class floor expansion (Q4 v-next) — more classes, more mandatory floors as patterns emerge.

**Phase 4 (v2) — governance and ecosystem maturity:**

18. Federation-governance RFC shipped; non-compliance mechanism landed.
19. Delegated sessions / refresh-token equivalent (separate RFC, PR #244 descendant).
20. Scope revocation (`scope.revoked` DFOS op).

---

## Anchor to existing work

- **Current shipped state.** Imajin has password-stored key auth, key import, NFC card enrollment (Muskoka), and EventDID check-in. No cross-node auth; no federated auth with DFOS; no JWS artifact format. v1 of this RFC is a net-new primitive built on existing Ed25519 + DFOS chain infrastructure.
- **RFC-13 response.** Standing tier (Soft/Preliminary/Established) is exposed via the `standing` scope (Q2). Demotion from RFC-13 Q4 triggers `session.revoked` per Q5.
- **RFC-14 response.** `issuance_authority` attestation from RFC-14 is the signature that validates NFC cards per Q7. Card-issuing institutions are RFC-14 issuance points.
- **RFC-15 response.** Severe-act from RFC-15 Q2 is a direct trigger for `session.revoked` per Q5 and an operation that requires user-local minimum per Q4 floor. The cryptographic-only requirement from RFC-15 Q6b is enforced via the RFC-22 Q4 floor.
- **RFC-17 response.** Bedrock decisions (forks reversible, standing decays, non-bedrock TTL) constrain session durations — all durations in Q5 carry implicit TTL. Bedrock governance votes require user-local minimum per Q4.
- **RFC-18 response.** Pattern-match on signed-op-driven state changes. RFC-22's `session.revoked` and `session.registered` ops use the same tagged-union DFOS op structure as RFC-18's `content.revoked`. Ops-spec RFC should coordinate both.
- **RFC-21 (Imajin Conformance Suite).** Conformant-relay status is what makes a peered platform trustable (RFC-22 trust model). Conformance and federated auth co-evolve.
- **PR #244 (Delegated App Sessions).** Merged per project memory; handles the machine-to-machine session case that's explicitly out of scope for RFC-22. Long-lived token / refresh equivalent extends PR #244, not this RFC.
- **@imajin/bus epic #759.** The long-term home for chain-update subscriptions underpinning Q5 session invalidation. v1 can ship with polling; migration to bus-derived subscriptions is bus-layer work.
