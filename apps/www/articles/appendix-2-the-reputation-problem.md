---
title: "Appendix 2: The Reputation Problem"
subtitle: "Everyone's building pieces. Nobody's building the stack."
description: "The tools for transaction-linked reputation exist in papers, in protocols, in fragments across dozens of projects. But nobody has stitched the settlement layer to the attribution layer to the credential layer to the trust graph. Here's the landscape, and here's how we close the gap."
date: "2026-XX-XX"
author: "Ryan Veteze"
---

## The Landscape

The problem of digital reputation is well understood. Academics have written about it. Engineers have prototyped pieces of it. The W3C published an entire specification for Verifiable Credentials. The building blocks exist.

What doesn't exist is the complete system.

Here's what's out there right now, and why none of it finishes the job.

---

## The Academic Work

In 2023, a team published "A Blockchain-Based E-Commerce Reputation System Built With Verifiable Credentials" in IEEE Access. The paper describes a privacy-preserving reputation system where reviews are cryptographically linked to real transactions using W3C Verifiable Credentials. Buyers receive feedback tokens after completing purchases. Sellers have verifiable digital identities. The system includes countermeasures against fake reviews, Sybil attacks, and reputation manipulation.

It's a good paper. It describes almost exactly what's needed.

It's also a paper. Nobody built it. Nobody shipped it. Nobody connected it to a real payment processor, a real identity layer, a real attribution chain, and a real trust graph that weights the credentials. It sits behind a paywall on IEEE Xplore, cited by other papers that also didn't ship.

There's a pattern here. JETIR published similar work — verifiable credentials for seller identities, feedback tokens tied to transactions, discount tokens for participation. Same idea. Same gap. The architecture is described. The implementation doesn't exist.

The academics identified the problem correctly: **reputation must be anchored to real economic activity, not platform-mediated opinion.** They just didn't build the economic activity part.

---

## The Infrastructure Providers

Dock.io, Cheqd, Trinsic, Spruce — these companies build the plumbing for decentralized identity. They're real. They ship code. Dock and Cheqd merged their token networks in late 2024 to accelerate adoption. Trinsic offers hosted credential APIs. Spruce builds open-source DID tooling.

They sell to enterprises for KYC compliance, HR credential verification, education transcripts. The use case is always institutional: a university issues a diploma credential, an employer verifies it, nobody calls the registrar's office anymore.

This is useful work. But it stops at verification.

None of these companies connect credentials to payment settlement. None of them build bilateral attestation where both parties in a transaction credential each other. None of them weight credentials through a trust graph. They built the credential layer and left everything above and below it to someone else.

Their customers are enterprises who want to issue credentials *about* people. Not people who want to issue credentials *about each other* based on real commerce.

---

## The Web3 Reputation Projects

Gitcoin Passport aggregates on-chain identity signals — how active you are in DeFi, how many protocols you've used, whether you're likely a real human. It's for Sybil resistance in grant funding, not commercial reputation.

Lens Protocol and Farcaster build social graphs on-chain. Your followers, your posts, your engagement. Portable across clients, which is better than Twitter. But it's social reputation — who likes you — not commercial reputation — who transacted with you and what happened.

These projects conflate two different things: popularity and reliability. Having 10,000 followers tells you something about reach. Having 500 verified vendor relationships where both parties attested to the experience tells you something about trust. They're not the same signal. They're not even in the same category.

---

## The Commerce Platforms

Shopify, Square, Stripe — they process billions in transactions. They have all the data you'd need to build transaction-linked reputation. They will never do it.

Why? Because the current model works for them. Stripe processes the payment and takes a percentage. What happens after — whether the product arrived, whether the vendor ghosted, whether the customer was satisfied — is explicitly not their problem. They're payment rails, not reputation infrastructure.

Amazon does tie reviews to verified purchases, which is closer. But Amazon owns the reviews. Amazon ranks the reviews. Amazon decides which reviews you see. The seller's reputation exists inside Amazon's walled garden and vanishes the moment they leave the platform. That's not portable reputation — that's a loyalty trap.

The review platforms — Yelp, Google Reviews, Trustpilot — are even worse. Reviews are unlinked to transactions. Anyone can write one. Businesses pay to suppress bad ones or amplify good ones. The incentive structure is adversarial by design: the platform profits from the conflict between businesses and reviewers. Reputation is the product being sold, not the signal being preserved.

---

## The Gap

Here's what exists:

| Layer | Who Built It | What's Missing |
|-------|-------------|----------------|
| Academic models | IEEE, JETIR researchers | Implementation. A real system. |
| Credential plumbing | Dock, Cheqd, Trinsic | Commerce. Bilateral attestation. Trust weighting. |
| Social reputation | Gitcoin, Lens, Farcaster | Transaction anchoring. It's popularity, not reliability. |
| Payment settlement | Stripe, Square, Shopify | Any interest in what happens after the money moves. |
| Review platforms | Yelp, Google, Amazon | Integrity. Independence from platform incentives. |

The credential layer exists but isn't connected to real payments. The payment layer exists but doesn't produce credentials. The social layer tracks popularity, not reliability. The academic work describes the target but nobody built the road.

---

## How We Close It

The sovereign stack connects all five layers into a single system where reputation builds itself from real economic activity:

**1. Settlement (pay.imajin.ai)**

Every transaction settles through the payment service. Real money moves. This is the anchor — the unfakeable event that everything else references. You can't leave a credential without a settlement. You can't fabricate a settlement without moving funds. The economics enforce the integrity.

**2. Attribution (.fair)**

The .fair manifest records who contributed what to every transaction. Not just "Alice paid Bob" — but the full chain: who made the product, who facilitated the sale, who referred the customer. Attribution flows through every transformation. This is the provenance layer that makes credentials meaningful — they don't just say "a transaction happened," they say "here's exactly who was involved and how."

**3. Credentials (profile)**

Both parties in a transaction can issue signed Verifiable Credentials about each other. The vendor attests: "this person is my customer." The customer attests: "I had this experience with this vendor." Each credential is cryptographically signed by the issuer's DID and linked to the specific .fair manifest. You can't forge it. You can't move it to a different transaction. You can't issue one without being a party to the settlement.

**4. Bilateral dispute chains**

When something goes wrong, the credential system doesn't become a comments section. Each response is a new signed credential referencing the one before it. The vendor can respond to a negative attestation with their own signed credential — "we offered a refund on this date" — and the customer can respond to that. Every claim is signed, timestamped, and linked to the original transaction. No anonymous drive-bys. No platform arbitration. A verifiable chain of assertions from identified parties with economic skin in the game.

**5. Trust graph weighting**

A credential from someone with 500 verified vendor relationships carries more weight than one from a single-transaction account. The trust graph — the network of connections, transactions, and attestations — provides the context that makes individual credentials meaningful. Not because a platform assigned a "trust score." Because the network structure itself reveals who has demonstrated reliability over time.

---

## What This Replaces

The current system: Alice buys a product from Vendor C. It arrives broken. Vendor C ghosts. Alice leaves a review on Google. Vendor C pays a reputation management firm to bury it. A year later, someone else buys the same broken product because the review is on page three.

The sovereign system: Alice buys from Vendor C. The settlement is recorded. Alice issues a signed credential: defective product, unresponsive vendor. It's linked to the real transaction. Vendor C can respond — but can't delete Alice's attestation. The trust graph weights Alice's credential based on her own history of verified transactions. New customers see the full chain: the negative credential, any vendor response, and the context of both parties' network positions.

No platform in the middle. No reputation management firms. No pay-to-suppress. No anonymous opinions. Just signed assertions from identified participants, anchored to real economic events, weighted by the network's own structure.

---

## Why Nobody Built This Yet

Because it requires all five layers. And nobody was building all five layers.

The academics described the architecture but didn't build commerce infrastructure. The VC companies built credential plumbing but sold it to enterprises, not individuals. The Web3 projects built social graphs but confused popularity with reliability. The payment companies had no incentive to let reputation leave their platform. The review platforms had every incentive to keep the system broken.

Building transaction-linked reputation requires a payment service that produces attribution manifests that generate bilateral credentials that feed into a trust graph. Each layer depends on the one below it. Skip one and the whole thing collapses back into platform-mediated opinion.

We built all five. Not because we're smarter than the IEEE researchers or the Dock engineers or the Stripe product team. Because we started from a different premise: **the settlement is the source of truth.** Everything else — attribution, credentials, reputation, trust — is a layer of interpretation on top of a real economic event.

Start from the transaction. Honor the chain. Let the reputation build itself.

---

## References

1. Kuperberg, M. et al. "A Blockchain-Based E-Commerce Reputation System Built With Verifiable Credentials." *IEEE Access*, vol. 11, 2023. DOI: 10.1109/ACCESS.2023.3274686
2. W3C. "Verifiable Credentials Data Model v2.0." W3C Recommendation, 2024. https://www.w3.org/TR/vc-data-model-2.0/
3. W3C. "Decentralized Identifiers (DIDs) v1.0." W3C Recommendation, 2022. https://www.w3.org/TR/did-core/
4. Dock.io / Cheqd alliance announcement, September 2024. https://cheqd.io/blog/cheqd-and-dock-form-alliance/
5. Gitcoin Passport. Sybil resistance through composable identity stamps. https://passport.gitcoin.co/

---

*This is Appendix 2 of the Imajin essay series.*
*The gap between academic models and shipped systems is where everything interesting happens.*
*If you're working on any piece of this puzzle, we should talk.*
*ryan@imajin.ai*
