## STATUS: RESOLVED
**Resolved:** 2026-03-13
**Evidence:** Ryan's Identity & Attestation Hardening Roadmap — Phase 1, issue #320 ("auth.attestations schema"); Settlement & Economics Hardening Roadmap — `financial_contribution` attestation type added to Phase 0
**Outcome:** The `auth.attestations` schema is committed as Identity Phase 1 (#320). The concern that the table did not exist and that proposals were depending on a non-existent layer is resolved — Ryan has formally committed to the design and created the implementation issue. The controlled type vocabulary (`vouch.given`, `flag.yellow`, `checkin.verified`, `event.attendance`, `financial_contribution`) is now part of the plan.
**Implementation:** Issue #320 created — not yet in code. Confirmed by checking for `auth.attestations` table in schema migrations.

---

### F1. Attestation Data Layer Does Not Exist

**Flagged:** March 10, 2026
**Affects:** Progressive Trust Model (current-proposals.md §1), Trust Accountability Framework (§2), Cultural DID governance model

The Progressive Trust Model proposal states: *"Standing is computed, not assigned. It's a query over attestation history on `auth.identities`."* And: *"Attestations are the mechanism: 'attended event X', 'vouched by DID Y', 'checked in at Org Z' — typed, signed, verifiable."*

**What the code actually has:** `auth.identities` has no attestation fields (`id`, `type`, `publicKey`, `handle`, `name`, `avatarUrl`, `metadata`, `createdAt`, `updatedAt`). The word "attestation" in the codebase refers exclusively to *build attestation* — cryptographic proof that a node is running approved software (`packages/auth/src/types/node.ts`, `apps/registry/src/db/schema.ts`). These are node-level integrity proofs, completely unrelated to identity trust standing.

There is no table for: vouches, event attendance records as attestations, standing scores, flag records, or onboarding milestones.

**What this means:** Every proposal that depends on attestation-based standing — Progressive Trust Model, Trust Accountability Framework, Cultural DID governance thresholds — is proposing a data layer that does not yet exist. Before any of these can be implemented, a new attestation schema needs to be designed and the terminology needs to be distinct from node build attestation.

**Proposal filed (March 10):** Proposal 7 (Cryptographic Trust Layer) in `current-proposals.md` is the full architectural response. Complete `auth.attestations` schema, controlled type vocabulary, standing computation formula, privacy architecture, agent DID questions, open questions for Ryan with Greg's positions, and three-phase implementation path.

**Resolution requires:** Design and specification of an `attestations` table (or equivalent) separate from the existing node attestation system. Suggested home: `auth` schema or a new `trust` schema. Must define: attestation types, who can issue them, how they are signed, how standing is computed from them.

---

