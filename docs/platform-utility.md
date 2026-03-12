# Platform Utility — Emergent Use Cases

**What becomes possible when identity, trust, attribution, and settlement exist as protocol primitives.**

**The core insight:** Every intermediary that charges you money exists because strangers can't trust each other. Banks, insurance companies, review platforms, recruitment agencies, advertising brokers, ticketing services, booking software — they're all trust intermediaries charging rent. When the protocol makes trust native, the reason they exist becomes obsolete.

These are hypothetical applications that emerge naturally from the scopes × primitives matrix. None are built yet. All are architecturally supported by what exists.

---

## Balance Utility Progression

Why someone keeps money on the platform — and how the reason evolves:

| Stage | Behavior | Motivation |
|-------|----------|------------|
| 1. Transact | Load $20 to buy a ticket or coffee | "I want something specific" |
| 2. Earn | Receive small payments from attention marketplace | "Huh, my balance drops slower than expected" |
| 3. Lend | Put idle balance into trust-based lending pools | "My money is working for me here" |
| 4. Borrow | Access capital based on reputation, not credit score | "My trust history IS my credit" |

Each stage gives a stronger reason to hold a larger balance. They compound — transacting builds your profile, which earns more attention income, which gives you more to lend, which builds more trust, which improves your borrowing terms.

---

## Trust-Based Lending

**Banks exist because strangers can't trust each other. The trust graph makes strangers into known quantities.**

### Community Lending Pools
- A Community DID creates a shared lending pool (quorum-signed, no single person controls it)
- Member needs capital → their standing (attestations, transaction history, vouches) determines eligibility
- Repayment settles automatically through the protocol
- No bank. No credit check. No predatory interest.

### Business-Scoped Lending
- Business lends seasonal employee relocation money
- Repayment deducted automatically from pay settlement
- The loan itself is an attestation — builds trust history for both parties

### Peer-to-Peer
- Signed agreement between two Actor DIDs
- Repayment terms declared, settlement automatic
- Non-repayment affects standing — not punishment, but signal

---

## Attention Economy Flywheel

### The Loop
1. Business advertises to you → you get paid (declared-intent marketplace)
2. You now have balance you didn't consciously load — you earned it
3. You spend at the business that advertised to you
4. That transaction is an attestation — you're now a verified customer
5. Your profile is richer → you're more valuable to the next advertiser
6. You get paid more → loop continues

### The Psychology (Gradual)
- **Early:** "I loaded money because I wanted a ticket" (utility)
- **Months in:** "My balance drops slower than I expected" (discovery)
- **Habitual:** "I keep more loaded because it kinda earns" (habit)
- **Mature:** "Every purchase makes my profile richer which earns me more" (flywheel)

The first currency in the system is attention, not dollars. Nobody makes a conscious decision to "on-ramp fiat." Money arrives because businesses paid for your attention.

---

## Referral Economy

### Cross-Business Attribution
- Cottage owner refers guest to restaurant → referral recorded via .fair
- Guest books → referring business earns a cut automatically
- No manual tracking, no "tell them I sent you"

### Tourism Packages
- Multiple businesses bundle offerings (cottage + restaurant + boat rental)
- .fair manifest defines revenue splits up front
- Settlement instant, attribution permanent

### Curated Discovery
- A trusted local (high standing, many attestations) recommends businesses
- Their recommendations carry more weight than a stranger's
- They earn from the referral — curation becomes compensable work

---

## Reputation as Credential

### Portable Work History
- Seasonal workers accumulate signed attestations from each employer
- Next employer sees verified history — no reference calls needed
- Bad actors can't reinvent themselves every season

### Professional Credentials
- "Muskoka Made" / "Health Inspection Passed" as signed, verifiable credentials
- Not stickers or PDFs — cryptographically attached to the business DID
- Customers verify instantly from their phone

### Skill Attestations
- Instructor signs "completed advanced paddleboard certification"
- Attestation follows the student's DID forever — no certificate to lose
- Any business can verify without calling the issuing school

---

## Community Governance

### Trust-Weighted Voting
- Community decisions weighted by standing, not one-person-one-vote
- Someone who's been an active, trusted member for 5 years has more governance weight than someone who joined yesterday
- Weight is earned through attestation history, not purchased

### Dispute Resolution
- Two businesses in conflict → community members with standing in both trust graphs mediate
- Resolution is an attestation — the dispute and its outcome are part of the permanent record
- Patterns emerge: a business that's always in disputes has that visible in their graph

### Resource Allocation
- Community pool of funds (events budget, marketing co-op, shared equipment)
- Spending decisions require quorum from governing members
- Every expenditure has .fair attribution — transparent, auditable, permanent

---

## Insurance & Risk

### Mutual Aid
- Community members contribute to a shared pool
- Claims evaluated by trust-weighted quorum — not an insurance company
- Fraud is harder when your standing is at stake

### Micro-Insurance
- Event gets rained out → automatic refund triggered by weather attestation
- Equipment breaks during rental → claim against the business's pool
- Small-dollar, high-trust transactions that traditional insurance can't serve profitably

---

## Education & Knowledge

### Trust-Gated Expertise
- Domain expert (doctor, lawyer, tradesperson) operates a node
- Only people in their trust graph can query their knowledge
- Inference fee flows to the expert — their expertise earns passively
- They don't need to be available 24/7 — their presence handles it

### Apprenticeship Tracking
- Master tradesperson attests to apprentice milestones
- Each attestation is signed, permanent, portable
- The apprentice's journey is a verifiable record, not a paper certificate

### Community Knowledge Base
- Community DID accumulates collective knowledge
- Contributors earn .fair attribution
- The community's expertise is queryable — "ask the Muskoka Restaurant Association about health code compliance"

---

## Local Currency Effects

### Velocity Within Community
- Money loaded onto the platform circulates between local businesses
- Each transaction strengthens the local trust graph
- Capital that would have left to Silicon Valley stays in the community

### Seasonal Smoothing
- Businesses earn attention marketplace revenue year-round (tourists browse in winter, plan trips)
- Lending pools provide bridge capital between seasons
- Customer connections persist through off-season — "your cottage rental is thinking about you in February"

### Economic Visibility
- Community can see aggregate economic activity (anonymized)
- "Our restaurants did $X in settlement this month" — without revealing individual business data
- Data-driven decisions about community investment, infrastructure, events

---

---

## Contributing

This document captures emergent utility — things the protocol makes possible without additional architecture. The matrix generates use cases faster than they can be built. That's the point of protocol design: define the primitives, and the applications are endless.

**See something missing?** If you can think of an intermediary that charges rent because strangers can't trust each other, the framework probably challenges it. Open a PR or file an issue. The best additions come from people who feel the extraction in their own industry.
