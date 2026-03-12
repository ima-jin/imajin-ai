### F4. Node Attestation Architecture Could Inform Identity Attestation Design

**Flagged:** March 10, 2026
**Informational — design opportunity**

The existing node attestation system (`packages/auth/src/types/node.ts`, `apps/registry/src/db/schema.ts`) has a well-designed pattern: a signed payload covering specific fields, a build hash, a version, a timestamp, and an Ed25519 signature. The registry stores these and verifies them on heartbeat.

The *form* of this system — signed, timestamped, verified attestations stored in a registry — is exactly what identity attestations would need. The design work is done at the node level; the proposal layer needs an equivalent at the identity level. This is worth noting when drafting the attestation schema for F1.

---

