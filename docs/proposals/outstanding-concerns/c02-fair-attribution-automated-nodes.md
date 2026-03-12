### 2. .fair Attribution Integrity for Automated Nodes

**From:** Historical Context §4.4, Concerns & Resolutions §4

**The concern:**
The claim that all five streams settle through .fair with unified, transparent attribution is asserted but not fully verified. Machine-to-machine settlements (Stream 3) raise a specific question: who writes the .fair manifest for an automated API call between two nodes?

If agents write their own attribution records, transparency requires auditable agent behavior — not just the protocol existing. Attribution is only as good as what gets declared in the manifest.

**What resolution requires:**
Explicit design of the enforcement layer for automated nodes. Likely requires cryptographic signing of manifests by the originating DID — deterministic attribution rather than declared attribution. The protocol layer is sound; the signing and auditability layer for agent-generated manifests needs specification.

**Code finding (March 10):** `FairManifest` (in `packages/fair/src/types.ts`) is an unsigned TypeScript object — `attribution: FairEntry[]` with `did`, `role`, `share`. No cryptographic signing requirement exists anywhere in the package. A manifest can be created and declared by anyone without proof of who authored it. The concern is real and the gap is confirmed in the codebase.

**Proposals filed (March 10):** Proposal 6 (.fair Attribution Integrity) and Proposal 12 (Declaration Granularity Standards — Stream 2) in `current-proposals.md` address this directly — minimum viable four-change implementation, Greg's positions on all five open questions, and a decisions table for Ryan.

---

## Design Choices — Require Explicit Documentation

