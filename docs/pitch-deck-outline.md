# Imajin Pitch Deck — Outline

**Target:** Kate McAndrew / Baukunst ($100M pre-seed fund, creative technologists)
**Format:** 14 slides, founder-first, minimal text, visual where possible
**Tone:** Builder talking to builders. Not a sales pitch — a proof of work.

---

## Slide 1: FOUNDER

**Ryan Veteze**

- Online since 1988. Ran a BBS at 15 — three phone lines, 300 people finding each other before the web existed
- 30+ years building systems. Director-level, led 8 teams. Java, C#/.NET, Azure, TypeScript
- 14 years running VETEZE Inc. Built a dance music network still running after 25 years
- Partner Debbie co-architecting since 2010
- Autistic pattern recognition + three decades of implementation

*Photo of Ryan. Real, not polished.*

**Why me:** I've been building community infrastructure since before the web. I watched the capture happen in real time. I finally know how to fix it.

---

## Slide 2: THE PROBLEM (Part 1 — Fees)

**3% of everything disappears.**

Every card tap. Every online purchase. Visa, Mastercard, Stripe, the banks — all taking a cut before the money reaches the person who earned it.

*Visual: $100 bill with pieces being torn off by logos. Or a simple flow diagram showing where money goes on a $5 coffee.*

For a small business doing $500K/year in transactions, that's $15,000 gone. Every year. Forever.

---

## Slide 3: THE PROBLEM (Part 2 — Reputation)

**Your reputation isn't yours.**

- Your Yelp stars belong to Yelp
- Your Airbnb rating vanishes when you switch platforms
- Your Uber driver's 5,000 rides mean nothing on Lyft
- Anyone can leave a review. Real customers can't prove they are one.

*Visual: Platform logos as walls/silos. Same person, different ratings, none portable.*

Platforms hold reputation hostage because that's the lock-in. You can't leave because your history doesn't come with you.

---

## Slide 4: THE INSIGHT

**What if every transaction you made built your reputation?**

Five components that have never been connected:

1. **Identity** — you are verifiable (not an account on someone else's platform)
2. **Payments** — money moves directly (not through middlemen)
3. **Attribution** — every transaction records who was involved
4. **Reputation** — both sides credential each other from real transactions
5. **Trust graph** — the network weighs credentials by history

Each exists in isolation. We connected them. The settlement is the anchor.

*Visual: The five layers as a stack, with "settlement" as the foundation.*

---

## Slide 5: HOW IT WORKS

**The coffee shop version:**

```
QR code on the window
  → Customer scans, joins with email
  → Loads wallet once (card → wallet, Stripe takes cut once)
  → Every transaction after: ledger entry, no card network
  → Both sides auto-credentialed on each transaction
  → Reputation builds passively. No begging for reviews.
```

*Visual: Simple flow from QR scan to transaction to credential. 4-5 icons, not a wall of text.*

---

## Slide 6: THE ECONOMICS

**Closed-loop settlement.**

Stripe touches the on-ramp. Once. Everything after is a ledger entry.

| | Card Networks | Imajin (Phase 1) | Imajin (Phase 2) |
|--|--|--|--|
| $100 across 20 transactions | **$9.00 in fees** | **$4.20** | **$1.00** |
| How | 3% every time | 3% once + 1% protocol | ~0% on-ramp + 1% protocol |

Money circulates inside the network. Vendor B pays Supplier C from the same balance. Stripe never touches it again.

*This is how every closed-loop system works: casino chips, WeChat Pay, gift cards. We're doing it with real commerce + reputation built in.*

---

## Slide 7: THE REPUTATION LAYER

**Bilateral, transaction-linked, unfakeable.**

- Both parties credential each other on every transaction
- Each credential is cryptographically signed and linked to the real payment
- Can't fake it (no settlement = no credential)
- Can't delete it (both nodes hold copies)
- Can't manipulate it (no platform algorithm in between)

When something goes wrong: signed dispute chains, not anonymous review wars. Every response traceable to a real identity with economic skin in the game.

*Visual: Two profiles, arrows going both ways, settlement in the middle. Compare to: Yelp (one-way, anonymous, platform-owned).*

---

## Slide 8: WHAT WE'VE BUILT

**10 live services. Sovereign infrastructure. Working today.**

| Service | What It Does |
|---------|-------------|
| auth | Keypair identity (human + agent DIDs) |
| pay | Settlement engine, closed-loop wallets, Stripe Connect |
| profile | Sovereign profiles, follows, credential infrastructure |
| events | Ticketing without the 30% surcharge |
| registry | Federated node discovery |
| chat | Pod-based messaging, E2EE architecture |
| connections | Trust graph (pod-based relationships) |
| coffee | Direct support / tipping through sovereign stack |
| links | Sovereign link pages |
| dykil | Survey infrastructure |

All open source. All self-hostable. First transactions: March 2026.

*This slide should feel like proof of work. Not promises — built things.*

---

## Slide 9: THE LANDSCAPE

**Everyone built pieces. Nobody built the stack.**

| Layer | Who Built It | What's Missing |
|-------|-------------|----------------|
| Academic models | IEEE researchers | They wrote papers, not code |
| Credential plumbing | Dock, Cheqd, Trinsic | Enterprise KYC, not commerce |
| Social reputation | Gitcoin, Lens, Farcaster | Popularity ≠ reliability |
| Payment rails | Stripe, Square | No interest in what happens after money moves |
| Review platforms | Yelp, Google | Adversarial by design |

**We built all five layers.** Not because we're smarter. Because we started from the settlement and followed the architecture honestly.

---

## Slide 10: MARKET OPPORTUNITY

**Every industry with a middleman holding reputation hostage.**

- **Local commerce** — 33M small businesses in the US alone, each paying ~$15K/year in card fees
- **Hospitality** — Airbnb hosts with non-portable ratings, 7M+ listings globally
- **Rideshare** — drivers trapped by platform reputation (Uber: 5.4M drivers)
- **Freelancing** — $1.5T market, zero portable reputation
- **Professional services** — client history locked in platform silos

Same QR code. Same five-layer stack. Different window.

*TAM/SAM/SOM:*
- **TAM:** Global digital payments ($11.6T) + online reputation/reviews market ($4.5B)
- **SAM:** Small business commerce in North America — $5.4T in card transactions
- **SOM:** 1,000 local businesses in Year 1, 10,000 in Year 2 — starting with one neighborhood

---

## Slide 11: GO-TO-MARKET

**Phase 1: One neighborhood.** 10 businesses, QR codes, real transactions. Prove the loop works.

**Phase 2: City-level clusters.** Businesses recruit each other (network effects — customers expect the sticker). Toronto first, then other cities with sovereign-tech communities.

**Phase 3: Platform API.** Platforms like Substack, Shopify integrate Imajin as their identity and attribution layer. The Stripe play — infrastructure underneath, not competing with the app layer.

**April 1, 2026:** Jin — an AI presence in a volumetric LED cube — hosts the first public event on the sovereign stack. Real tickets. Real payments. Real trust graph. The demo is in 27 days.

---

## Slide 12: THE ESSAYS

**30 essays. Part manifesto, part technical docs, part founding story.**

7 published, rest rolling out through April. The complete intellectual foundation — from the BBS origin story through the architecture to the honest ask for help.

*Visual: Essay titles flowing down the page. Or a single powerful quote from the series.*

> "The internet that pays you back."

**imajin.ai/articles**

---

## Slide 13: THE ASK

**$500K — Pre-seed milestone raise**

| Use | Allocation |
|-----|-----------|
| April 1 demo + first 90 days post-launch | 40% |
| Go-to-market: first 10 business pilots | 30% |
| Runway (founder + infrastructure) | 30% |

**What $500K buys:**
- Live demo with real transactions (April 1)
- 10 business pilots with QR onboarding
- Federation between 2+ nodes (proving the architecture)
- Platform API documentation for integration conversations
- 6 months of runway to reach revenue

**Not raising a round. Raising a milestone.**

---

## Slide 14: THE VISION

**Sovereign infrastructure for the next internet.**

Not a platform. Not a product. Exit infrastructure.

The graph started with trust. The trust needed identity. Identity needed payments. Payments needed attribution. Attribution produced reputation. Reputation fed back into the trust graph.

Five layers. All connected. All sovereign. All open source.

*Visual: The five-layer loop, closing into a circle. Or the Unit — the glowing cube — as the physical anchor of something that started as an idea and is now running in production.*

> **April 1, 2026. This is not a joke.**
>
> events.imajin.ai/jins-launch-party

---

## Design Notes

- **Minimal text per slide.** If it takes more than 6 seconds to read, it's too much.
- **One idea per slide.** Don't combine the problem slides or the solution slides.
- **Visuals > bullet points.** Diagrams, flows, comparisons. Not walls of text.
- **Dark background, warm accents.** Match imajin.ai aesthetic — dark with amber/orange.
- **No clip art, no stock photos.** Real screenshots of services, real diagrams, real essay quotes.
- **The founder slide is a conversation starter**, not a resume. Make it human.
- **Baukunst cares about craft.** The deck itself should feel built with care — they're "creative technologists advancing the art of building." Show that you are too.
