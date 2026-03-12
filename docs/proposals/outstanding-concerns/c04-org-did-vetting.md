### 4. Vetting and Early-Member Influence (Org DID)

**From:** Concerns & Resolutions §8

**The concern:**
The proposed Org DID vetting mechanism — covenant as standard, trust-graph attestation as mechanism, no central approval committee — is architecturally consistent. But early members accumulate outsized influence over what kinds of businesses are ever permitted on the network. This compounds over time.

**Current status:** Identified, partially addressed.

**What resolution requires:**
A deliberate position on whether this compounding effect is acceptable, or whether a counterbalance mechanism is needed. Options include: time-decay on attestation weight for vetting decisions, a rotating attestor pool, or explicit acknowledgment that early-member influence is a known property of the system rather than a flaw.

**Proposal filed (March 10):** Proposal 10 (Org DID Vetting and Early-Member Influence) in `current-proposals.md` proposes the Composite Attestation Model as a fourth position — requiring three simultaneous inputs (standing-weighted vouches, unweighted soft-loading evidence, and covenant compliance declaration) none of which can be gamed in isolation. The soft-loading floor is democratic and decoupled from trust graph depth. The covenant document is identified as the most urgent deliverable.

---

## Calibration — Open Design Questions, Not Structural Gaps

