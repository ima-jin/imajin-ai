## 34. Crowd-Funded Events — From Interest to Escrow to Settlement

**Author:** Greg Mulholland
**Date:** April 7, 2026
**Priority:** MEDIUM-HIGH — the Mooi differentiator; first use of existing escrow infrastructure
**Matrix cells:** Community scope x Events + Settlement
**Related issues:** #587 (Group Identities), #592 (Forest Config), #597 (Contextual Onboard)
**Related RFCs:** RFC-19 (Kernel/Userspace), fee model v3 draft
**Related concerns:** C12 (Consent), C13 (Covenant)
**Connects to:** P32 (Mooi Onboarding), P31 (Fee Governance), P33 (Group Key Sovereignty)

---

### ✅ RESOLVED 2026-04-22 — CONSOLIDATED (not completed)

**Status:** This proposal is retired as a standalone tracking item. No implementation has shipped, but the territory is now covered by three live vectors that together replace P34's role:

1. **P32 §6 + §11.1** — the proposal-side home for crowd-funded events, now scoped to Mooi onboarding where the feature is actually load-bearing. §11.1's April 22 delta documents the escrow route landing at `apps/kernel/app/pay/api/escrow/route.ts` (Stripe + Solana, `arbiter` DID, `conditions.releaseAfter`/`requireSignatures`) and carries the five unshipped attestation types (`event.proposed`, `event.interest`, `event.funded`, `event.confirmed`, `treasury.contributed`) on its open-items list.
2. **Upstream #749** — *"Campaign events: goal-based crowdfunding"* filed April 20, depends on #363. Defines a **V1 SetupIntent path** (no authorization window cap) and **V2 MJNx escrow path** (stable-token-denominated, no Stripe 31-day ceiling). This phasing is upstream's own answer to §5's "windows beyond 31 days" question, and it does not match §3's 4-stage flow one-to-one.
3. **P36** — Founding Supporter Tier, extracted from P28 §4 on April 22. Covers the *supporter-to-network* contribution path; P34/P32 cover the *attendee-to-event* funding path. Separate surfaces, overlapping plumbing (both depend on the escrow route + attestation emission that is live but unwired).

**Why retire, not complete:** zero implementation has shipped against P34's schema or routes. `events.funding_commitments` does not exist. `funding_mode`/`funding_threshold`/`funding_deadline`/`funding_current`/`funding_status` columns do not exist on `events.events`. `POST /api/events/[id]/interest` and `POST /api/events/[id]/fund` do not exist. None of the five attestation types are in ATTESTATION_TYPES. The escrow primitive (§2) is live; the orchestration layer (§3) is not. But upstream #749 owns the implementation track now, and its V1/V2 phasing may diverge from §3's 4-stage flow.

**What P34 remains useful for:** the architectural target spec. §3 (four-stage flow), §4 (scope-fee-in-.fair-manifest worked example — $5,000 × 3.75% = $187.50 split across protocol/node/buyer-credit/scope layers), §5 (alternatives analysis — Options A/B/C for windows >31 days), and §7 (full attestation chain) are the reference material for *if* or *when* #749 V2 revives the full crowd-fund lifecycle. They are not a todo list.

**Lineage after this move:**
- Live proposal: **P32** (Mooi Onboarding) carries the remaining open question ("does #749's V1/V2 phasing replace §6.1's 4-stage flow, or is §6.1 the target end-state?")
- Upstream implementation: **#749** (+ dep **#363**)
- Architectural reference: **this file**, now at `resolved/34-crowd-funded-events.md`

Original substance preserved unchanged below.

---

### 1. The Problem — Events Are Pay-First, Not Interest-First

The current events system is a direct purchase flow: event exists → tickets are for sale → buyer pays → ticket issued. This works for events with guaranteed backing (the organizer absorbs the financial risk).

But many community events work the opposite way: someone proposes an event → community signals interest → if enough interest, funding is collected → if funding threshold is met, event is confirmed → if not met, all money is returned.

This is how Mooi wants to work. Borzoo runs a 150–500 capacity venue. He doesn't want to book a headliner until he knows 200 people will show up. The community doesn't want to commit money until they know the event will happen. Both sides need a commitment mechanism that is contingent on collective action.

**No existing platform does this well.** Kickstarter is project-based, not event-based. Eventbrite is pay-first. GoFundMe has no escrow. What Mooi needs is: the funding commitment is real (money is held), but the money only moves when the threshold is met. If it's not met, everyone gets refunded automatically. No manual process. No trust required.

---

### 2. What Exists Today (Build From, Don't Rebuild)

The infrastructure for crowd-funded events is surprisingly complete. The missing piece is the orchestration layer connecting existing primitives.

#### Escrow API (pay service) — EXISTS, NOT WIRED TO EVENTS

**`apps/pay/app/api/escrow/route.ts`** — Full escrow endpoint:

- `POST /api/escrow` — Creates a Stripe PaymentIntent with `capture_method: 'manual'`. Accepts `from` DID, `to` DID, `arbiter` DID, `conditions` (releaseAfter, requireSignatures).
- `PUT /api/escrow` with `action: 'release'` — Captures the PaymentIntent (money moves).
- `PUT /api/escrow` with `action: 'refund'` — Cancels the PaymentIntent (money returned).

**`apps/pay/lib/providers/stripe.ts`** (lines 173–228):
```typescript
async escrow(request: EscrowRequest): Promise<EscrowResult> {
  const paymentIntent = await this.stripe.paymentIntents.create({
    amount: request.amount,
    currency: request.currency.toLowerCase(),
    capture_method: 'manual',   // <-- money held, not captured
    metadata: { escrow: 'true', from_did, to_did, arbiter_did, ... },
  });
}
```

This is exactly the primitive crowd-funded events need. Money is authorized and held by Stripe but not captured until release. Stripe holds authorized funds for up to 7 days (extendable to 31 days with extended authorization).

#### Interest Signal Infrastructure — EXISTS, NEEDS REPURPOSING

**`apps/registry/src/db/schema.ts`** — Interest tables:

- `interests` — scope-level metadata (scope, label, description, triggers)
- `didPreferences` — global marketing + auto_subscribe per DID
- `didInterests` — per-DID per-scope preferences

Currently used for notification consent ("did this person opt into marketing for this scope?"). Can be extended to express event-level funding interest.

#### Settlement + Refunds — COMPLETE

- `settleTicketPurchase()` in `apps/events/src/lib/settle.ts` handles .fair manifest distribution
- Full refund flow (`/api/events/[id]/tickets/[ticketId]/refund`) with settlement reversal
- Pay service reverses settlement entries, debits recipients, credits buyer

#### Stripe Connect — COMPLETE

- Express Connect accounts with onboarding
- `application_fee_amount` + `transfer_data.destination`
- Per-account `platformFeeBps` override

#### Ticket Hold System — EXISTS (inventory, not financial)

- `POST /api/events/[id]/hold` — Creates held ticket (status: `held`, 72h default)
- `DELETE /api/events/[id]/hold` — Releases hold
- Expired holds auto-released

#### Attestation Emission — WORKING

5 new group/scope attestation types shipped. The pattern (`emitAttestation()` → `/api/attestations/internal`) is well-established.

---

### 3. The Crowd-Funded Event Flow — Four Stages

```
PROPOSE → POLL → FUND → CONFIRM/REFUND
```

Each stage produces an attestation. The chain of attestations is the provable history of community intent → commitment → outcome.

#### Stage 1 — Proposal

An event organizer (or any community member, depending on forest config) creates an **event proposal** — not a published event, but a draft with funding parameters.

**New fields on `events` table:**

```sql
ALTER TABLE events.events ADD COLUMN funding_mode TEXT DEFAULT 'direct';
  -- 'direct' (current: pay and get ticket)
  -- 'crowdfund' (new: fund if threshold met, refund if not)

ALTER TABLE events.events ADD COLUMN funding_threshold INTEGER;
  -- minimum amount in cents to confirm event (e.g., 500000 = $5,000)

ALTER TABLE events.events ADD COLUMN funding_deadline TIMESTAMPTZ;
  -- when funding window closes (e.g., 14 days from proposal)

ALTER TABLE events.events ADD COLUMN funding_current INTEGER DEFAULT 0;
  -- current committed amount in cents (denormalized for display)

ALTER TABLE events.events ADD COLUMN funding_status TEXT DEFAULT 'proposed';
  -- 'proposed' → 'polling' → 'funding' → 'confirmed' | 'failed'
```

**Status progression:**

| funding_status | Meaning | Transitions to |
|---------------|---------|---------------|
| `proposed` | Idea submitted, not yet open for interest | `polling` (organizer opens) |
| `polling` | Open for interest signals, no money involved | `funding` (organizer opens funding) or `failed` (organizer cancels) |
| `funding` | Escrow commitments accepted | `confirmed` (threshold met) or `failed` (deadline passed, threshold not met) |
| `confirmed` | Threshold met, escrow captured, event is happening | (becomes normal published event) |
| `failed` | Threshold not met or cancelled, all escrow refunded | (terminal) |

**API:** `POST /api/events` with `funding_mode: 'crowdfund'`, `funding_threshold`, `funding_deadline`. Returns event in `proposed` status.

**Attestation:** `event.proposed` — issuer: creator DID, subject: event DID. Includes threshold and deadline in metadata.

**Scope-aware:** When created via `actingAs` (e.g., Borzoo acting as Mooi), the event is owned by the forest DID. The scope fee from fee model v3 applies to the event's settlement.

#### Stage 2 — Interest Polling

The organizer opens the event for interest. Community members signal interest without financial commitment.

**Repurpose existing infrastructure:**

- Use `registry.didInterests` to record interest: scope = event DID, channel = `'crowdfund'`
- New API: `POST /api/events/[id]/interest` — creates interest record, no payment
- Interest count displayed on event page
- Optional: interest signal triggers notification to organizer (existing notify infrastructure)

**API:**
- `PATCH /api/events/[id]` with `funding_status: 'polling'` (organizer only)
- `POST /api/events/[id]/interest` — record interest (any authenticated user)
- `GET /api/events/[id]/interest` — count + list of interested DIDs
- `DELETE /api/events/[id]/interest` — withdraw interest

**Attestation:** `event.interest` — issuer: interested DID, subject: event DID.

**No money moves. This is a signal, not a commitment.** The organizer uses interest count to decide whether to open funding.

#### Stage 3 — Funding Commitment (Escrow)

The organizer opens funding. Community members commit money via escrow — Stripe holds it, doesn't capture.

**Wire existing escrow API to events:**

New route: `POST /api/events/[id]/fund`

```typescript
// 1. Validate event is in 'funding' status
// 2. Validate deadline not passed
// 3. Calculate amount (ticket price × quantity)
// 4. Call pay service escrow:
const escrow = await fetch(`${PAY_SERVICE_URL}/api/escrow`, {
  method: 'POST',
  body: JSON.stringify({
    from: buyerDid,
    to: eventDid,           // or forest DID if scope-owned
    arbiter: eventDid,      // event controls release/refund
    amount: totalCents,
    currency: 'usd',
    conditions: {
      releaseAfter: null,   // manual release on threshold met
    },
    metadata: {
      eventId,
      ticketTypeId,
      quantity,
      fundingMode: 'crowdfund',
    },
  }),
});

// 5. Create ticket(s) in 'held' status (not 'sold')
// 6. Update funding_current += amount
// 7. Check if funding_current >= funding_threshold → auto-confirm if met
```

**New table: `events.funding_commitments`**

```sql
CREATE TABLE events.funding_commitments (
  id TEXT PRIMARY KEY,                    -- fc_xxx
  event_id TEXT NOT NULL REFERENCES events.events(id),
  funder_did TEXT NOT NULL,
  amount INTEGER NOT NULL,                -- cents
  escrow_id TEXT NOT NULL,                -- Stripe PaymentIntent ID (pi_xxx)
  ticket_ids TEXT[] NOT NULL,             -- held tickets created
  status TEXT NOT NULL DEFAULT 'held',    -- 'held' | 'captured' | 'refunded'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
```

**Attestation:** `event.funded` — issuer: funder DID, subject: event DID. Amount in metadata.

**Stripe authorization window:** PaymentIntents with `capture_method: 'manual'` hold funds for 7 days (standard) or up to 31 days (extended authorization, available for eligible merchants). The `funding_deadline` should be within this window. For longer funding windows, use a different pattern (see §5 Alternatives).

#### Stage 4 — Confirmation or Refund

**Threshold met (auto or manual):**

When `funding_current >= funding_threshold`:

```typescript
// 1. Set funding_status = 'confirmed'
// 2. For each funding_commitment with status 'held':
//    a. Call PUT /api/escrow { action: 'release', escrowId: pi_xxx }
//    b. Update commitment status = 'captured'
//    c. Update ticket status from 'held' to 'sold'
//    d. Trigger settlement: settleTicketPurchase() for each ticket
// 3. Set event status = 'published' (now a normal live event)
// 4. Send confirmation emails to all funders
```

**Attestation:** `event.confirmed` — issuer: event DID (or organizer DID), subject: event DID. Threshold amount and funder count in metadata.

**Threshold NOT met (deadline passed):**

A scheduled job (or webhook) checks `funding_deadline`:

```typescript
// 1. Set funding_status = 'failed'
// 2. For each funding_commitment with status 'held':
//    a. Call PUT /api/escrow { action: 'refund', escrowId: pi_xxx }
//    b. Update commitment status = 'refunded'
//    c. Delete held tickets
// 3. Send refund notification emails to all funders
```

**Attestation:** `event.funding.failed` — issuer: event DID, subject: event DID. Shortfall amount in metadata.

**Manual cancellation:** The organizer can cancel at any time during `polling` or `funding` status. All escrow is refunded. Same flow as deadline failure.

---

### 4. Scope Fee Integration (Fee Model v3)

The scope fee from fee model v3 (`docs/rfcs/drafts/fee-model.md`) slots directly into crowd-funded events:

When Mooi (forest DID) creates a crowd-funded event and sets a 2% scope fee:

| Layer | Rate | On $5,000 threshold |
|-------|------|-------------------|
| Protocol | 1.0% | $50 |
| Node | 0.5% | $25 |
| Buyer credit | 0.25% | $12.50 |
| Scope (Mooi treasury) | 2.0% | $100 |
| **Total fee** | **3.75%** | **$187.50** |
| **To event organizer** | | **$4,812.50** |

The scope fee funds the community treasury — Mooi's operational costs. The organizer receives the remainder. Both are transparent: the .fair manifest encodes the full chain.

**Implementation:** When the event is scope-owned (`creatorDid` is a forest DID), the `.fair` manifest at creation should include the scope fee as a chain entry:

```typescript
const fairManifest = {
  version: '0.2.0',
  chain: [
    { did: eventDid, role: 'event', share: 1 - PROTOCOL_FEE - NODE_FEE - SCOPE_FEE },
    { did: PLATFORM_DID, role: 'platform', share: PROTOCOL_FEE },
    { did: nodeDid, role: 'node', share: NODE_FEE },
    { did: forestDid, role: 'scope', share: SCOPE_FEE },
  ],
  distributions: [
    { did: organizerDid, role: 'creator', share: 1.0 },
  ],
};
```

Note: this also applies to direct-purchase events owned by forests. The scope fee is not crowd-fund-specific — it's forest-specific.

---

### 5. Alternatives and Edge Cases

#### Funding Windows Beyond 31 Days

Stripe's extended authorization caps at 31 days. For longer funding windows:

**Option A — Subscription holds:** Create a Stripe SetupIntent (no charge), then charge when threshold met. Risk: payment method may fail at capture time.

**Option B — Immediate charge + pooled refund:** Charge immediately, pool funds in platform account, refund all if threshold not met. Stripe refund fees apply (Stripe keeps processing fee on refund since October 2023 — $0.30+ per refund). Cost at 200 funders × $25 ticket = $60 in lost refund fees if event fails.

**Option C — Two-stage:** Use interest polling (no money) for 30+ day windows, then open a 7-day funding sprint with escrow when interest is sufficient. This is the recommended approach for Mooi — poll for a month, fund for a week.

**Recommendation:** Option C (two-stage) as the default. The polling stage is free and unlimited in duration. The funding stage uses real escrow with a 7–31 day window. This matches Mooi's workflow: Borzoo posts an idea, lets interest build organically, then opens a short funding window when he's confident.

#### Partial Funding

What if the threshold is $5,000 and only $4,200 is committed?

**Option A — All-or-nothing:** If threshold not met by deadline, all escrow is refunded. Simple, clear, no edge cases. This is the Kickstarter model.

**Option B — Flexible funding:** Organizer can choose to confirm at any amount (even below threshold). The threshold becomes a recommendation, not a gate. Risk: organizer confirms at $2,000, event quality suffers, community loses trust.

**Recommendation:** All-or-nothing as default. Allow organizer to lower the threshold before deadline (with notification to all funders). Don't allow confirmation below threshold — the threshold is the social contract.

#### Refund After Confirmation

Once escrow is captured and tickets are issued, the event is a normal published event. The existing refund flow applies: organizer can refund individual tickets, settlement entries are reversed. No special crowd-fund logic needed post-confirmation.

---

### 6. Implementation Priority

| Priority | What | Scope | Depends on |
|----------|------|-------|-----------|
| **P0** | `funding_mode`, `funding_threshold`, `funding_deadline`, `funding_current`, `funding_status` columns on events | Schema migration, 5 columns | Nothing |
| **P0** | `funding_commitments` table | Schema migration | Nothing |
| **P1** | `POST /api/events/[id]/interest` (polling) | New route, repurpose registry interests | P0 |
| **P1** | `POST /api/events/[id]/fund` (escrow commitment) | New route, wire to existing `/api/escrow` | P0 |
| **P1** | Threshold check + auto-confirm logic | In fund route + scheduled job | P0, escrow wiring |
| **P1** | Deadline failure + batch refund | Scheduled job or cron | P0, escrow wiring |
| **P2** | Event proposal UI (create crowd-funded event) | Frontend form with funding params | P0 |
| **P2** | Funding progress UI (progress bar, funder list, deadline countdown) | Frontend component | P0, P1 |
| **P2** | Attestation chain (event.proposed, event.interest, event.funded, event.confirmed) | 4 new attestation types | P1 |
| **P3** | Scope fee integration in .fair manifest | Requires fee model v3 implementation | Fee model v3 code |
| **P3** | Forum-style proposal discussion (BBS view) | New UI pattern, possibly chat-based | Chat group infrastructure |

**P0 + P1 is ~3–5 days of work.** The escrow API exists. The interest infrastructure exists. The primary work is wiring them together and adding the funding lifecycle to events.

---

### 7. Attestation Chain — The Provable History

Each crowd-funded event produces a chain of attestations that proves community intent → commitment → outcome:

| Stage | Attestation Type | Issuer | Subject | Metadata |
|-------|-----------------|--------|---------|----------|
| Propose | `event.proposed` | Creator DID | Event DID | threshold, deadline, description |
| Interest | `event.interest` | Interested DID | Event DID | — |
| Fund | `event.funded` | Funder DID | Event DID | amount, escrowId |
| Confirm | `event.confirmed` | Event/Organizer DID | Event DID | totalFunded, funderCount, threshold |
| Fail | `event.funding.failed` | Event DID | Event DID | totalFunded, shortfall, funderCount |

This chain is auditable. Any community member can verify: who proposed, how many were interested, who committed money, whether the threshold was met, and whether all refunds were issued. No trust required — the attestations are signed and timestamped.

For Mooi: this is the accountability mechanism. Borzoo can show the community exactly how funding decisions are made. The community can verify that refunds actually happened. The trust graph grows from demonstrated behavior, not promises.

---

### 8. The Mooi Flow — End to End

1. **Borzoo creates a crowd-funded event proposal** (acting as Mooi forest DID):
   - "DJ Night with [Artist] — $5,000 minimum to book"
   - `funding_mode: 'crowdfund'`, `funding_threshold: 500000`, `funding_deadline: 2 weeks out`
   - `event.proposed` attestation emitted

2. **Interest polling opens.** Mooi members see the proposal on the events page. They tap "I'm interested" — no money, no commitment. Interest count displays prominently.
   - 180 people signal interest → `event.interest` attestations

3. **Borzoo opens funding** (after seeing sufficient interest):
   - `funding_status` moves from `polling` to `funding`
   - Members see "Fund this event — $25/ticket" with a progress bar showing $0 / $5,000

4. **Members commit via escrow:**
   - Each funder's card is authorized but not charged (Stripe manual capture)
   - Progress bar updates: $625 → $1,250 → $2,500 → $4,800...
   - Each commitment: `event.funded` attestation

5. **Threshold met:**
   - At $5,000+: all escrow is captured automatically
   - Tickets issued (status: `sold`), settlement runs through .fair manifest
   - Mooi's 2% scope fee → Mooi treasury. Protocol 1% + node 0.5% + buyer credit 0.25%.
   - `event.confirmed` attestation
   - Confirmation emails to all funders

6. **Event happens.** Normal flow from here: check-in, attendance attestation, WLED bridge, post-event settlement.

**If threshold NOT met by deadline:**
   - All escrow cancelled (Stripe cancels PaymentIntents — no charge to funders)
   - Tickets deleted, `funding_status: 'failed'`
   - `event.funding.failed` attestation
   - Notification emails: "Event didn't reach its funding goal. No charge to your card."

---

### 9. Open Questions for Ryan

1. **Escrow webhook handler:** The existing Stripe webhook stub for escrow (`paymentIntent.metadata.escrow === 'true'`) needs implementation. Should the escrow lifecycle be fully managed by the events service (calling `/api/escrow` release/refund), or should the pay service manage it via webhook state machine?

2. **Funding deadline enforcement:** Scheduled job (pm2 cron) or Stripe webhook-driven? Stripe doesn't fire a webhook when a PaymentIntent authorization expires — the events service needs its own timer.

3. **Fee inconsistency:** Event creation writes `PLATFORM_FEE` (1.5%) into the .fair manifest, but settlement uses `PLATFORM_FEE_PERCENT` (3%). Which is authoritative? Should the .fair manifest at creation time be the source of truth for settlement?

4. **Connect for crowd-funded events:** Should crowd-funded events use Connect (funds go to organizer's Stripe account) or platform-direct (funds pooled in platform account, distributed via settlement)? Connect is cleaner for refunds but requires the organizer to have a connected account before the event is proposed.

5. **Interest-to-funding conversion:** When a member signals interest during polling, should they be auto-notified when funding opens? Should their interest signal pre-fill the funding form?

6. **Minimum viable UI:** For Mooi's first event, is a CLI/API-only flow acceptable (Borzoo creates via API, shares a funding link), or does the full proposal → polling → funding UI need to ship?

7. **Authorization window:** Standard Stripe authorization is 7 days, extended is up to 31 days. For Mooi's use case, is a 7-day funding sprint (after open-ended polling) sufficient?
