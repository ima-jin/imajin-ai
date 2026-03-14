## STATUS: RESOLVED
**Resolved:** 2026-03-13
**Evidence:** Proposal 8 (Attestation Data Layer) — RESOLVED March 13, adopted via #320; the proposal explicitly referenced the NodeAttestation pattern as the design template
**Outcome:** This was an informational concern — a design opportunity flag. It has been fully incorporated: Proposal 8 used the `NodeAttestation` architecture (signed, typed, timestamped, registry-stored) as the explicit template for `auth.attestations`. Ryan's roadmap (#320) implements this pattern for identity attestations. The concern has served its purpose.
**Implementation:** Incorporated into Proposal 8 (now in resolved/) and committed as #320.

---

### F4. Node Attestation Architecture Could Inform Identity Attestation Design

**Flagged:** March 10, 2026
**Informational — design opportunity**

The existing node attestation system (`packages/auth/src/types/node.ts`, `apps/registry/src/db/schema.ts`) has a well-designed pattern: a signed payload covering specific fields, a build hash, a version, a timestamp, and an Ed25519 signature. The registry stores these and verifies them on heartbeat.

The *form* of this system — signed, timestamped, verified attestations stored in a registry — is exactly what identity attestations would need. The design work is done at the node level; the proposal layer needs an equivalent at the identity level. This is worth noting when drafting the attestation schema for F1.

---

