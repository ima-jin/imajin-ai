### 8. Dark Graph Clustering

**From:** Trust Accountability Framework §2, Presence Boundary Enforcement #344
**Filed upstream:** March 15, 2026 (docs/proposals/outstanding-concerns/c08-dark-graph-clustering.md)

**The concern:**

The trust graph naturally creates islands. When bad actors are attested and their trust distance increases from the legitimate network, they don't disappear — they cluster. They vouch for each other, transact with each other, and build attestation trees that look "healthy" from inside their bubble but have no bridges to the legitimate network.

This creates two distinct failure modes:

**1. Dark Graph — parallel trust networks**

Bad actors form a self-reinforcing trust cluster. Within it:
- They have vouches (from each other)
- They have transaction attestations (with each other)
- They have activity history (circular)
- Their computed standing looks valid *within the cluster*

From outside, the cluster is disconnected — no legitimate DIDs vouch for them, no bridge attestations exist. But from inside, everything looks normal.

This mirrors real-world organized fraud: shell companies vouching for shell companies, circular references that satisfy automated checks.

**2. Gray Feed — natural degradation**

Disconnected from the legitimate network, the bad actor experience degrades organically:
- No presences will talk to them (abuse attestations precede them)
- No legitimate businesses query them in the AttMart
- Their attention value is zero (no real economic signal)
- Their feed becomes self-referencing — only seeing content from other disconnected DIDs

The network doesn't punish them. It just becomes *boring*. Self-selecting exile.

**The open questions:**

1. **Is this a bug or a feature?** The internet already has this (4chan vs everywhere else). The difference is on Imajin it's *visible* — you can literally graph the clusters and see the disconnection. Natural segregation might be the correct outcome.

2. **Should dark graphs be detectable?** Graph analysis can identify clusters with high internal connectivity but few external bridges. Should the protocol flag these? Should legitimate DIDs be warned when interacting with members of a disconnected cluster?

3. **Can dark graphs be weaponized?** A sufficiently large dark graph could attempt to bridge into the legitimate network — one member builds genuine trust, then vouches in the rest. The vouch chain accountability model (#344, progressive trust) should catch this (voucher's standing reflects vouchee behavior), but at what scale does it break?

4. **Rehabilitation path.** If someone leaves a dark graph cluster and genuinely reforms, how do they rebuild trust? Their attestation tree carries the history. The dispute/quorum mechanism (#344) handles individual attestations, but what about systemic reputation damage from cluster association?

5. **Cultural relativism.** Not all disconnected clusters are "bad." A community with different values might form a naturally separate graph — not malicious, just different. The protocol shouldn't assume disconnection equals malice. How do we distinguish organic community boundaries from organized bad actor networks?

**What resolution requires:**

- Graph analysis primitives that can identify cluster topology (bridge count, internal density)
- Clear policy on whether cluster detection is protocol-level, application-level, or user-level
- Rehabilitation mechanisms for individuals exiting dark graph clusters
- Cultural DID considerations — legitimate community clusters vs. bad actor clusters
- Definition of "bridge attestation" quality — not all bridges are equal (a single vouch vs. deep multi-attestation relationships)

**The deeper thesis:**

Maybe the dark graph isn't the enemy. Maybe it's the signal.

The trust graph doesn't just route payments and attestations. It makes the *shape* of human connection visible. And when you can see it — really see it — the dark graphs aren't scary. They're sad. They're clusters of people who couldn't find a bridge to anyone who trusted them.

The protocol doesn't fix that. People fix that. But the protocol makes it *visible* in a way that no platform ever has. Facebook hides it behind algorithms. Twitter amplifies it for engagement. Imajin just... shows it. Here's the graph. Here's who trusts who. Here are the gaps.

And maybe when you can see the gap, someone builds a bridge.

Maybe this is the part where we all finally learn that we're exactly the same and we want the same things.

**Related:**
- #344 — Presence Boundary Enforcement + Abuse Attestations
- Progressive Trust Model (resolved, Proposal 01)
- Trust Accountability Framework (resolved, Proposal 02)
- Governance Equity (c03)
- Greg's bad actor behavioral categories (yellow → amber → red → removal)

---
