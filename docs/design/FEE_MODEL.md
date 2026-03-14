# Fee Model: Capped Micro-Investment + Voluntary Equity

*Design doc — March 13, 2026. Internal spec for legal review.*
*Status: DRAFT — do not implement until legal counsel approves structure.*

---

## The Thesis

Platform fees are extraction when they're perpetual. Imajin's fee model treats mandatory fees as **capped micro-investment** in the platform. You pay in until you've contributed your share, then you're done. Optional additional investment is available for people who want to support the project further.

**Core principle:** The fee ends. No platform should take a cut of your life forever.

---

## Two-Track Model

### Track 1 — Mandatory Membership Investment (not a security)

Every transaction on the platform includes a small fee that accumulates toward a per-person cap.

**Mechanics:**
- Fee: ~0.75% of each transaction (split granularly via .fair — see below)
- Cap: $100 per DID (example — needs calibration)
- Tracking: every fee payment logged as `.fair` `financial_contribution` attestation
- When cap is reached: fee drops to zero for that DID
- The $100 is not a "cost" — it's a tracked contribution that earns a share of the Supporter Pool

**Why this isn't a security:**
- Mandatory — not an investment *choice*, it's a condition of platform use (like a co-op membership fee)
- Capped — you can't put more in to get more out (no investment behavior)
- Access-based — the fee buys platform membership, not equity speculation
- Non-transferable — your membership share can't be sold

**What the $100 buys:**
- A proportional share of the Supporter Pool (10% of Imajin equity)
- Share size determined by pool valuation at time of contribution
- Quarterly disbursements from platform profit, proportional to your share
- Your share never dilutes downward — new contributors buy in at current (higher) valuation

### Track 2 — Voluntary Investment (likely a security — register properly)

After hitting the cap (or at any time), people can choose to invest more.

**Mechanics:**
- Voluntary contributions above the $100 cap
- Processed through a compliant crowdfunding rail (Reg CF or equivalent)
- Buys additional Supporter Pool equity at current valuation
- Same quarterly disbursement rights
- Properly registered, audited, legally compliant

**Why separate tracks:**
- Track 1 avoids securities regulation by being mandatory and capped
- Track 2 embraces securities regulation by using proper registration
- Clean legal boundary between "membership fee" and "investment"

---

## The Supporter Pool

**Structure:**
- 10% of Imajin equity reserved for the Supporter Pool
- Starting valuation: TBD (e.g., $2M — needs financial + legal input)
- Valuation increases as the business grows (revenue multiple, board decision, or transparent formula)

**How shares work:**

| When | Pool Valuation | $100 Buys | % of Company |
|------|---------------|-----------|-------------|
| Early (Year 1) | $2M | $100 / $200K pool = 0.05% of pool | 0.005% of company |
| Growth (Year 2) | $8M | $100 / $800K pool = 0.0125% of pool | 0.00125% of company |
| Scale (Year 3) | $20M | $100 / $2M pool = 0.005% of pool | 0.0005% of company |

Early supporters get 4-10× more per dollar. Not through speculation — through math.

**Disbursements:**
- Quarterly, based on platform profit
- Proportional to your share of the Supporter Pool
- Pennies at first. Grows with the business.
- Not dividends in the traditional sense for Track 1 (membership returns)
- Proper dividends for Track 2 (registered equity)

---

## .fair Fee Chain

Every transaction splits its fee granularly via .fair attribution:

```json
{
  "fair": "1.0",
  "attribution": [
    { "did": "did:imajin:creator",   "role": "creator",  "share": 0.9925 },
    { "did": "did:imajin:protocol",  "role": "protocol", "share": 0.0025 },
    { "did": "did:imajin:host",      "role": "host",     "share": 0.0025 },
    { "did": "did:imajin:dev",       "role": "dev",      "share": 0.0025 }
  ]
}
```

| Recipient | Share | Purpose | Caps? |
|-----------|-------|---------|-------|
| Creator | 99.25% | The person who made the thing | N/A |
| Protocol | 0.25% | MJN protocol infrastructure | No — ongoing operational cost |
| Host | 0.25% | Node operator running services | No — ongoing operational cost |
| Dev | 0.25% | Development / Supporter Pool investment | **Yes — per-DID $100 cap** |

**After cap is reached for a DID:**

```json
{
  "attribution": [
    { "did": "did:imajin:creator",   "role": "creator",  "share": 0.9950 },
    { "did": "did:imajin:protocol",  "role": "protocol", "share": 0.0025 },
    { "did": "did:imajin:host",      "role": "host",     "share": 0.0025 }
  ]
}
```

Dev share goes back to the creator. Their .fair chain gets leaner.

**Alternative:** After cap, the DID can optionally redirect their 0.25% to a cause — environmental DID, community treasury, etc. This is very .fair-native.

---

## Early Adopter Weighting

Consistent with RFC-02 micro-founder model:

| Round | Timing | Weight Multiplier |
|-------|--------|------------------|
| Round 1 (Bootstrap) | Pre-revenue / first 100 contributors | 1.2× |
| Round 2 (Growth) | Early revenue / next 1,000 | 1.1× |
| Round 3+ (Scale) | Established | 1.0× |

Multipliers are intentionally small — 20% acknowledgment, not 10× returns. The goal is fair recognition of early risk, not wealth concentration.

---

## MJN Token Conversion (Year 3)

When the MJN token launches:
- Supporter Pool equity converts to MJN tokens at a defined ratio
- Early contributors who bought at $2M valuation get more tokens per dollar than those at $20M
- The token IS the equity representation — the Supporter Pool becomes a token distribution event
- This is the "hardware first, token later" strategy in action

---

## Corporate Structure Options

| Structure | Pros | Cons | Fit |
|-----------|------|------|-----|
| **C-Corp + Reg CF** | Standard, investors understand it, Reg CF handles public investment | Traditional corporate structure, not inherently cooperative | Good for Track 2, neutral for Track 1 |
| **Multi-Stakeholder Co-op** | Aligns perfectly with philosophy, Ontario has co-op law, membership model is native | Less familiar to investors, may limit future fundraising | Perfect for Track 1, complex for Track 2 |
| **Hybrid (Co-op + C-Corp subsidiary)** | Co-op for governance + membership, C-Corp for investment + operations | Complex structure, dual governance | Best of both but most complex |
| **B-Corp** | Legal obligation to stakeholders beyond shareholders | Still a corporation underneath, "B-Corp" is certification not structure | Cosmetic — doesn't change the economics |
| **Swiss Stiftung (Foundation)** | MJN whitepaper already proposes this for protocol governance | Foundation can't issue equity the same way | For the protocol layer, not the business layer |

**Recommendation for legal review:** Explore the hybrid model. Co-op membership for Track 1 (mandatory, capped). C-Corp or Reg CF vehicle for Track 2 (voluntary investment). The MJN Foundation (Swiss Stiftung) governs the protocol layer independently.

---

## Open Questions for Legal Counsel

1. **Is the mandatory capped fee + profit sharing a security under Canadian law?** We believe not (it's a membership fee with cooperative-style returns), but this needs confirmation.

2. **Does quarterly disbursement from profit constitute a dividend?** If yes, does that trigger securities classification for Track 1?

3. **Reg CF vs. Canadian alternatives?** Ontario Securities Commission has its own crowdfunding framework. Which is better for a Canadian company with global users?

4. **Can the Supporter Pool convert to MJN tokens without triggering a new securities event?** The token conversion is planned for Year 3 — the legal structure needs to anticipate it.

5. **Does the early-adopter weighting (1.2× for Round 1) create different "classes" of security?** If so, does that complicate registration?

6. **Multi-stakeholder co-op in Ontario:** What are the governance requirements? Can the co-op hold equity in a C-Corp subsidiary? Can international members join?

7. **Non-transferability:** Does making shares non-transferable (no secondary market) help or hurt the securities analysis?

---

## What Needs to Happen Before Implementation

- [ ] Securities lawyer review of both tracks
- [ ] Corporate structure decision (co-op, C-corp, hybrid)
- [ ] Supporter Pool valuation methodology defined
- [ ] Cap amount calibrated ($100? $50? Variable by tier?)
- [ ] Reg CF platform selected (if Track 2 proceeds)
- [ ] Disbursement mechanics defined (how is "profit" calculated? What's the minimum payout threshold?)
- [ ] .fair chain integration specced (dev fee tracking, cap detection, chain modification after cap)

---

## How This Connects to the Roadmaps

**Settlement Roadmap:**
- Phase 0: Platform fee already planned — this refines the fee structure
- Phase 1: Signed .fair verification ensures fee chain is cryptographically valid
- Phase 2: Distribution contracts automate the quarterly disbursement

**Identity Roadmap:**
- `financial_contribution` attestation type tracks every fee payment
- Supporter Pool share is computed from attestation history (same model as standing)
- Early adopter weighting uses round timestamps from attestations

**.fair Roadmap:**
- Fee chain is a .fair manifest — signed, attributed, auditable
- Templates define the fee structure per service type
- Intent field can carry `purpose: "membership-investment"` on fee transactions

---

*This document is for internal planning and legal review. Do not publish or implement the investment mechanics until legal counsel has reviewed the two-track structure, securities classification, and corporate structure options.*
