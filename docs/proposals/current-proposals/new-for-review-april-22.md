# New for Review — April 22, 2026

*Draft items surfaced by the April 22 audit (upstream HEAD post-#750 merge, 428 commits since April 7).*
*Review flow: Greg first → Ryan → upstream discussion/RFC.*

These are **unpolished first drafts.** Each names a specific gap, a specific file or RFC it touches, and a concrete next step. None of them are submitted anywhere yet. Greg to triage for relevance, reframing, kill, or promote.

---

## New Problems (code-level or spec-level gaps)

### P37 — Reconcile P24 Agent Attribution with RFC-27 Peer Model

**What changed:** RFC-27 (MCC — Multi-Coordinator Coordination, epic #751) models agents as **peer DIDs** with `scope: actor, subtype: agent`, not as sub-identities of a principal. P24 (profile-claim verification) was drafted under the earlier assumption that agents were acting *on behalf of* a principal — i.e., there was always a hierarchical link to verify against.

**The conflict:** If agents are peers, then profile-claim verification cannot assume a parent DID to attest the claim. The "TODO: Verify the verification token" in `apps/kernel/app/profile/api/claim/route.ts` now has two different correct answers depending on whether the claimant is an agent or a human.

**What to do:**
1. Decide explicitly: do agent DIDs get profile claims at all? Or only attestations?
2. If yes, specify the claim-verification chain for a peer agent DID (presumably: signature from the principal that first introduced the agent, not a hierarchical parent).
3. Update P24 proposal text to reflect the RFC-27 model before implementation.

**Severity:** Spec-level blocker for P24. Not a regression — P24 was never implemented.

---

### P38 — RFC-28 Universal Real-World Registry — Risk Review

**What changed:** RFC-28 (Universal Real-World Registry, "DIDs for everything" / "DNS for the real world") introduces a model where **anyone can create stubs** for real-world entities (venues, businesses, landmarks) and the **rightful owner can later claim them** with a default 90/10 commission split rewarding the original curator.

**The risks:**
1. **Squatting economics.** The 90/10 split incentivizes bulk stub creation (claim-jumping at scale). A bot farming 10,000 Muskoka businesses earns 10% of every future claim revenue from those businesses.
2. **Jurisdictional verification.** How does "rightful owner" get established? Business registry lookup? Domain ownership? Neither scales globally.
3. **Commission ceiling.** No cap on total lifetime commission — a single curator could extract perpetual rent from a business they never operated.
4. **Negative-space squatting.** Stubs for non-existent entities (fake businesses, invented landmarks) poison search and trust signals.

**What to do:**
1. Propose a commission ceiling (absolute cap + time-decay, e.g., 10% for 24 months then 0%).
2. Require a staking deposit for stub creation, forfeited if the stub is disputed/invalid — solves squatting + invents a spam tax.
3. Specify jurisdictional verification primitives (link to #255 Sovereign User Data; gov't identity RFC in mjn-protocol).
4. Before Muskoka pilot launches, write the abuse playbook (what does a bad actor gain, and how is it detected?).

**Severity:** Design-level; pre-launch review window.

---

### P39 — Open Wallet Portability Gap

**What changed:** The strategic headline shifted to **"an open wallet with apps that plug in"** (epic #738). The pitch now leans on portability as a core promise. But the actual portability primitives — identity/attestation **import** (#739) and **export** (#717) — are not yet shipped.

**The gap:** Today a user can create a sovereign identity on an imajin node. They cannot move it to another node, back it up in a human-readable form, or replay it against a fresh installation. The wallet metaphor implies "I can take my stuff with me"; the code implies "once you're in, you're in."

**What to do:**
1. Treat #739/#717 as pitch-blocking, not feature-level.
2. Spec the export format (DFOS chain dump + signed attestation bundle + profile artifact) before shipping any new surface that depends on the wallet framing.
3. Dogfood: export a real identity from one node, import it to another, confirm all attestations resolve.
4. Don't ship the new pitch copy externally until import+export round-trips cleanly.

**Severity:** Narrative/product — the claim runs ahead of the code.

---

### P40 — @imajin/bus Migration Safety Plan

**What changed:** Epic #759 (@imajin/bus) refactors event sourcing + CQRS + choreographed sagas. 23 sub-issues (#760-#782) are replacing **47 scattered `emitAttestation` / `emit` / `notify.send`** call sites.

**The risk:** A 47-site rewrite with no feature flag produces a silent event-dropping regression that is invisible until someone reports missing notifications or attestations days later.

**What to do:**
1. **Dual-write window.** During migration, every converted call site emits via *both* the old path and the new bus. A comparator (nightly job) flags discrepancies.
2. **Feature flag per domain.** Flip reads from old-path to bus one domain at a time (attestations → notifications → settlement → …).
3. **Replay test suite.** Golden event fixtures that must reproduce identical state under both paths.
4. **Rollback criteria.** Define in advance what triggers reverting to the old path (e.g., discrepancy rate > 0.1% for any event type).

**Severity:** Process-level; not a bug, but the bug-surface of doing this wrong is enormous.

---

### P35 — Gas Governance and Rent-Extraction Limits (successor to P11)

**Promoted to standalone file:** `35-gas-governance-rent-extraction-limits.md`. Answers Ryan's standing invitation at `docs/rfcs/drafts/fee-model.md:184`. Pairs with **P38** under a shared rent-extraction theme — P38 at claim-time (RFC-28 stub commissions), P35 at transaction-time (gas curves + compliance gates). See triage guidance at the end of this doc.

---

### P41 — Scope Fee Disclosure at Join-Time

**What changed:** Fee model v3 added a **0.25% scope fee** configurable per forest/group. Users joining a group today accept its fee terms implicitly — there is no UI surface that previews "this group takes 0.25% of your transactions."

**The gap:** A user joining a forest cannot see what they are agreeing to financially. When they later transact, the scope fee is deducted. Legally and ethically, this is pre-consent deduction.

**What to do:**
1. Add scope-fee display to the join/onboard flow for any group DID with a non-zero scope fee.
2. Require explicit acknowledgement (checkbox or signed attestation) before first transaction under that scope.
3. Expose scope-fee history (when was it changed, by whom) in the group's public profile.

**Severity:** UX + consent. Small to ship, meaningful to the sovereignty story.

---

## New Concerns (architectural / narrative)

### C30 — Sovereignty Narrative Gap Widens Under Open Wallet Framing

C19 already flagged that calling soft DIDs "sovereign" was fragile. The new **open wallet** pitch compounds this: a wallet implies I *own* the keys. For soft DIDs, the server still holds encrypted material. For hard DIDs, the user does. The pitch doesn't distinguish. If the pitch goes to market without that distinction, the gap becomes a credibility liability the moment a technical reviewer examines it.

**What to do:** Retire "sovereign" as a universal claim in pitch copy. Replace with tier-specific language — "custodial-by-default, self-custody by upgrade" — and make the upgrade path UI-visible.

---

### C31 — Agent Reputation Non-Transferable vs BaggageDID Portability Claim

RFC-27 places agents as per-principal peer DIDs. Attestations earned by an agent belong to *that principal's instance* of that agent. P05 (BaggageDID) claims identity + reputation travels with the user. These two claims are compatible only if we specify whether agent attestations travel as part of a principal's baggage.

**What to do:**
1. Decide: do agent attestations export with a principal's identity dump (P39/#717)?
2. If yes: specify how the agent identity is rehydrated on a new node (does the agent get a new DID? does it keep its old one?).
3. If no: document the asymmetry loudly. Principal reputation travels; agent reputation doesn't.

---

### C32 — Handle Impersonation Race Window (RFC-26)

RFC-26 (Federated Handle Resolution) uses "first-to-chain wins" for handle claims. Between the moment a legitimate user submits a claim to relay A and the moment relay B learns about it, an impersonator can submit the same handle to relay B. Depending on gossip cadence and which relay's view reaches which observer first, the impersonator's claim may be honored in some slices of the network.

**What to do:**
1. Specify a **claim settlement window** (e.g., a handle is "pending" for N seconds after first claim; during that window, all relays must reach consensus before the claim is final).
2. Define the reconciliation rule when two valid-looking claims collide (timestamp? chain position? principal attestation priority?).
3. Document explicitly that handles are not instantly global — they are eventually global.

---

## Triage Guidance for Greg

**Submit to Ryan soon (pre-launch-relevant):**
- **Rent-Extraction Limits bundle: P38 + P35.** Cover memo framing these together as the "capital→influence limits" pair. P38 is claim-time, P35 is transaction-time. Pre-launch pressure on P38 from Muskoka pilot; P35 §2 governance shell can ratify alongside.
- P39 (Open Wallet portability) — pitch depends on it
- P41 (Scope fee disclosure) — small, shippable, consent-critical

**Submit to Ryan medium-term (RFC-stage):**
- P37 (P24 / RFC-27 reconciliation)
- P40 (bus migration safety) — frame as process, not RFC
- C31 (agent reputation portability) — pairs with P37
- C32 (handle impersonation race)

**Sharpen before submitting:**
- C30 (sovereignty narrative) — needs a specific copy-edit proposal, not just a critique
