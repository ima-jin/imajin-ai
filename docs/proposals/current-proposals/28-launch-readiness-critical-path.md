## 28. Launch Readiness — The Critical Path from Demo to Fundraise

**Author:** Greg Mulholland
**Date:** March 27, 2026
**Priority:** URGENT — 5 days to April 1 demo; fundraise follows immediately
**Matrix cells:** All scopes × Settlement + Attribution (the demo primitives)
**Related issues:** #25 (demo), #330 (.fair wiring), #454 (relay auth), #474 (founding supporter), #433 (virtual MJN)
**Related concerns:** C10 (relay auth), C12 (consent), C17 (stale issues), C18 (demo blockers), P8, P9
**Connects to:** P29 (Attestation Completeness)

---

### 1. The Situation

**Updated March 29:** April 1 is 3 days away. Since this proposal was written (March 27), Ryan shipped 32 commits resolving multiple blockers:

| Blocker | Status | What Shipped |
|---------|--------|-------------|
| MFA / secure login | **RESOLVED** | #432 + #493: TOTP, device tracking, stored keys, auth method management UI |
| Ticket scanner | **RESOLVED** | #500: QR scanner on event admin dashboard |
| Attestation coverage | **RESOLVED** | #461: 19 attestation types emitting across 8 services |
| Notification system | **NEW** | #479: Notify service + UI bell + toasts + @mentions in chat |
| DFOS relay | **UPGRADED** | #518: DFOS 0.6.0 conformance |

**Updated March 30:** All three wiring blockers are now resolved:

| Blocker | Status | What Shipped |
|---------|--------|-------------|
| `.fair` manifests on events | **RESOLVED** | `settleTicketPurchase()` in `apps/events/src/lib/settle.ts` |
| Settlement from webhook | **RESOLVED** | Events webhook calls `POST /api/settle` on Stripe checkout |
| Platform fee recording | **RESOLVED** | 3% `PLATFORM_FEE_PERCENT` deducted before attribution chain |
| Auth bridge to DFOS | **RESOLVED** | #532: genesis on register, lazy backfill on login |

**Remaining post-demo:**
1. Founding supporter tier (#474) — `supporter.founding` attestation type not yet in vocabulary
2. Issue triage — 119 open issues, ~30 structurally superseded
3. `.fair` template wiring to all upload paths (P9 — only events path wired)

### 2. What the Demo Actually Proves (and What It Doesn't)

**The demo proves:**
- A complete sovereign transaction: ticket purchase → .fair attribution → multi-party settlement
- Identity works across tiers (soft DID email buyer, hard DID organizer)
- The JBOS architecture is real — 15 services, one flow
- DFOS chain backing is live — identity is self-certifying, not just a database row

**The demo does NOT prove (and shouldn't try to):**
- Token economics (MJN is Year 3)
- Federation (single node is fine for demo)
- Agent autonomy (not needed)
- Consent primitives (ticket purchase is implicit consent)
- Declaration marketplace (Stream 2, no code)

**Greg's position:** Do not expand demo scope. The three wiring tasks (#25 remaining items) are the only blockers. Everything else is post-demo. The temptation to "add one more thing" before a live event is the single most reliable way to break a demo.

### 3. The Wiring — Exactly What Needs to Happen

#### 3.1 Wire `.fair` to Event Transactions

**Current state:** Events create tickets and process Stripe payments. No `.fair` manifest is generated.

**Required change:** After successful Stripe webhook confirmation in `apps/events/`, call `createManifest()` from `@imajin/fair` with:

```typescript
{
  type: 'event_ticket',
  owner: organizerDid,        // event organizer's DID
  attribution: [
    { did: organizerDid, role: 'organizer', share: 0.99 },
    { did: PLATFORM_DID, role: 'platform', share: 0.01 }
  ],
  // signature and platformSignature via signManifest()
}
```

The `.fair` template system exists (`packages/fair/src/templates.ts`) — issue #330 documents that it's not called anywhere. The `createManifestFromTemplate()` function is built. It needs one caller.

**Effort estimate:** This is a single function call in the events payment webhook handler. The manifest creation, signing, and storage are all implemented. The gap is literally the call site.

#### 3.2 Wire Events Webhook to Settlement

**Current state:** `apps/pay/app/api/settle/route.ts` exists and works. Events process payments through Stripe but never call the settlement endpoint.

**Required change:** After `.fair` manifest creation (§3.1), POST to `${PAY_SERVICE_URL}/api/settle` with the manifest ID and transaction reference. Settlement verifies the `.fair` signature and distributes according to the attribution chain.

**Important detail:** The settlement route currently warns but does not reject unsigned manifests (transitional period noted at line 186). For the demo this is fine — manifests WILL be signed because `signManifest()` is wired. But the enforcement toggle (C02) should be switched to reject mode before any real money flows through this path.

#### 3.3 Platform Fee Recording

**Current state:** RFC-19 specifies the 1% settlement fee split (0.4% node operator / 0.4% protocol / 0.2% user as MJN credit). No implementation exists.

**Required change:** The `.fair` manifest attribution chain (§3.1) already encodes the split. The settlement endpoint already distributes according to the chain. What's missing is:
1. A `PLATFORM_DID` — the protocol's own DID that receives the 0.4% protocol fee
2. A `NODE_OPERATOR_DID` — the node operator's DID that receives the 0.4% node fee
3. The 0.2% user MJN credit — this requires #433 (virtual MJN) which is not yet built

**Minimum viable for demo:** Record the platform fee as a `.fair` allocation. The actual distribution to platform and node operator DIDs can be deferred — the important thing is that the `.fair` chain RECORDS the fee so it's auditable. Virtual MJN credit (the user's 0.2%) is a tracking record, not a payout. It can be a database entry or chain attestation that says "this DID has earned 0.2% of this transaction as MJN credit."

**Greg's position:** For April 1, the `.fair` manifest records the full 1% allocation. Actual multi-party Stripe payout is deferred — the demo shows the attribution chain working, not the bank transfer completing. Real multi-party payouts come when Stripe Connect is configured for the node operator and protocol accounts.

### 4. The Founding Supporter Gap

Issue #474 (Founding Supporter tier) is the bridge between demo and fundraise. Kaarlo's signal (March 25) is real — people want to support but "donate" has no upside and "$1,500 for a Unit" is too much.

#### 4.1 Why This Can't Wait

The April 1 demo will generate interest. People will ask "how do I support this?" If the answer is "you can't yet" or "buy me a coffee," the interest dissipates. If the answer is "contribute, get a chain-backed founding attestation at a founding rate, and when MJN mints on Solana your chain entry converts to tokens" — that's a reason to act now.

The founding supporter mechanism converts demo enthusiasm into committed stakeholders. Every founding supporter is a node in the trust graph with economic skin in the game. This is the bootstrapping mechanism for a trust-weighted network.

#### 4.2 The Immediate Implementation Path

The founding supporter flow:
1. Contribute via coffee/tip page (exists today)
2. `supporter.founding` attestation emitted on their DFOS chain
3. Virtual MJN allocated at founding rate
4. At Solana mint (Year 3): replay chain → derive token allocation

**What's missing for this to work immediately:**
- `supporter.founding` attestation type added to controlled vocabulary
- Attestation emission wired to coffee/tip payment handler
- #433 (virtual MJN credits) — the chain-native ledger concept is designed but not built

**What's NOT missing:**
- Attestation infrastructure (`emitAttestation()` in `@imajin/auth`)
- DFOS chain backing (every identity already has a chain)
- Pay service (Stripe payments work)
- Coffee/tip page (exists and processes payments)

**Greg's position:** Ship #474 within one week of the April 1 demo. Do not let "the token isn't ready" block the founding supporter tier — the chain-backed attestation IS the token until Solana mint. "Your chain entry is your receipt, permanently. Verify it yourself — you don't need our server." This is the pitch, and it's better than any receipt because it's cryptographically verifiable and portable.

#### 4.3 The Tier Structure (from #474)

| Tier | Contribution | Virtual MJN | Rate | Perks |
|------|-------------|-------------|------|-------|
| Seed | $25+ | 500 MJN | 20:1 | Founding attestation, reserved handle |
| Grove | $100+ | 2,500 MJN | 25:1 | + Unit at cost when production scales |
| Canopy | $500+ | 15,000 MJN | 30:1 | + Named in network genesis block |

Rates are illustrative — actual rates depend on RFC-12 (MJN Token Economics). The important architectural decision is that early contributors get a better rate, and the rate is locked in the chain attestation — it cannot be retroactively changed.

**Securities consideration:** The founding supporter tier must be structured as contribution-to-infrastructure (not investment-for-returns) to avoid Howey test issues. The `.fair` attribution chain is the tracking record, not a security. The MJN conversion is proportional to network participation, not speculation. This needs legal review before #474 ships — but it should not block the attestation mechanism.

### 5. The Stale Issue Problem

119 open issues. At least 30 are structurally superseded by DFOS adoption, RFC-19, and the whitepaper v0.4 rewrite. Here is a concrete triage list:

#### 5.1 Clearly Superseded — Close with Context

| Issue | Why Superseded | Close With |
|-------|---------------|------------|
| **#19** (did:mjn DID method) | DFOS made this irrelevant; `did:imajin` aliased to `did:dfos` | Link to whitepaper v0.4 §Identity |
| **#274** (single domain consolidation) | RFC-19 kernel/userspace supersedes; WO-274 ICEBOXED | Link to RFC-19 |
| **#3** (first node registration) | jin.imajin.ai exists and is running | Close as completed |
| **#109** (PWA) | Valid but not on any critical path | Label as `backlog`, don't close |
| **#140** (multi-tenant ZERR onboarding) | Presence architecture evolved; sovereign inference (#256) supersedes | Link to #256 |
| **#153** (ZERR keypair exchange) | DFOS chain-backed identity supersedes | Link to #395 |
| **#459** (drizzle-kit push) | C09 resolved — migration system now has per-service tracking | Close as resolved |

#### 5.2 Duplicates or Subsumed

| Issue | Subsumed By |
|-------|------------|
| **#112–117** (revenue streams 1–5) | Whitepaper v0.4 §Settlement + §Discovery. Individual tracking issues are noise — the whitepaper IS the spec. |
| **#111** (inference cost flow) | #256 (Sovereign Inference epic) |
| **#110** (.fair for runtime modules) | RFC-01 + RFC-19 §Agents |
| **#21** (consent middleware) | Deferred per #25; C12/P18 track the real gap |
| **#24** (node registry certification) | #468 (Relay Network epic) supersedes with DFOS-backed approach |

#### 5.3 Still Valid — Keep Open

| Issue | Why Still Relevant |
|-------|-------------------|
| **#25** (April 1 demo) | THE priority |
| **#321** (progressive trust) | Core roadmap — Phase 2 |
| **#454** (relay auth) | Pre-production blocker (C10) |
| **#461** (attestation coverage) | P29 depends on this |
| **#474** (founding supporter) | Bridge to fundraise |
| **#325** (core invariant tests) | Crypto/settlement math must be tested |
| **#465** (agent sandbox) | RFC-19 dependency |
| **#364** (@imajin/graph) | RFC-16 backbone |
| **#155** (DID-to-endpoint resolution) | Federation prerequisite |
| **#259** (node operations) | Self-hosted node admin |
| **#468** (relay network) | DFOS Phase 2/3 |

**Greg's position:** After the April 1 demo, do an issue triage pass. Close superseded issues with a comment linking to the superseding RFC or decision. Don't delete — close with context. Target: reduce open issues from 119 to ~60 actively relevant items. This is 2–3 hours of work that dramatically reduces cognitive overhead.

### 6. The Three-Week Sequence

| Week | Focus | Outcome |
|------|-------|---------|
| **Week 0 (now → April 1)** | Wire .fair to events (§3.1) + settlement (§3.2) + platform fee (§3.3). Add `event.attended` attestation to check-in handler (P29 Tier 1). Nothing else. | Demo works end-to-end. April 1 generates real attestation data. |
| **Week 1 (April 1–7)** | Ship #474 (founding supporter). Issue triage. Demo footage + writeup. Capture metrics (DID count, attestation count, transaction count, settlement volume). | Supporters can contribute with chain-backed proof. Issue backlog is clean. Demo is documented. |
| **Week 2 (April 7–14)** | Business plan draft. DFOS integration narrative. Financial projections from actual April 1 data. | Fundraise materials ready for first review. |

### 7. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Demo scope creep | HIGH | Delays April 1 | This proposal — lock scope to three items |
| `.fair` wiring takes longer than expected | LOW | Demo has no attribution | The code paths exist; this is integration, not invention |
| Stripe webhook timing at demo | MEDIUM | Settlement doesn't complete live | Pre-test full flow on dev; have a backup recorded demo |
| Founding supporter tier hits securities questions | MEDIUM | #474 delayed | Structure as contribution (not investment); get legal counsel pre-launch |
| Issue triage disrupts Ryan's flow | LOW | Wasted week | Greg drafts all closure comments; Ryan reviews and clicks close |

### 8. Open Questions for Ryan

| Question | Why It Matters |
|----------|---------------|
| Is the April 1 demo scoped to exactly the three items in #25, or has scope crept? | Scope creep kills demos |
| Can `supporter.founding` attestation type be added to the vocabulary this week? | Unblocks #474 |
| Who closes the ~30 stale issues — Ryan, or can Greg draft the closure comments? | Reduces cognitive load |
| Is the founding supporter rate (20:1/25:1/30:1 MJN) already decided, or does it need RFC-12? | Determines if #474 ships before or after token economics finalization |
| Does `PLATFORM_DID` exist yet? If not, what DID should receive the protocol's 0.4% fee? | Required for the `.fair` manifest attribution chain |
| Is the April 1 event on dev or production? | Determines whether real money flows through settlement |

### 9. Detecting Resolution

- [ ] `.fair` manifest created on every event ticket purchase
- [ ] Settlement called from events webhook on Stripe confirmation
- [ ] Platform fee recorded in `.fair` attribution chain
- [ ] `event.attended` attestation emitted on check-in
- [ ] Founding supporter tier (#474) live within 7 days of demo
- [ ] Issue count reduced from 119 to <70 within 14 days of demo

---
