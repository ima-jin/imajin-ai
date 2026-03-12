## 7. Cryptographic Trust Layer — Unified Architecture

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/attestation-data-layer.md`
**Related upstream:** RFC-001, Discussion #255, #268 (Embedded Wallet), #271 (Progressive Trust), #273 (Trust Accountability)
**Addresses:** Attestation Data Layer (Flagged, blocks multiple proposals); synthesizes Proposals 5 and 6

### Executive Summary

Three active proposals — Progressive Trust Model, Trust Accountability Framework, and Cultural DID governance — share a foundational dependency that does not yet exist: a cryptographic identity attestation layer. The existing codebase uses the word 'attestation' for build integrity proofs of node software. Identity attestations — signed, typed records of meaningful social acts between DIDs — are architecturally absent.

This proposal argues for a more fundamental reframe: cryptographic signing should not begin at the BaggageDID (departure event) or at .fair manifests (settlement). It should begin at the first meaningful interaction between a node and a personalDID. Every trust-relevant act — onboarding, vouching, attendance, flag, attribution — should be a cryptographically signed record from the moment it occurs. The BaggageDID then becomes a natural output of that layer, not a patch on top of it.

### 1. The Semantic Collision in the Current Codebase

The word 'attestation' currently refers exclusively to build integrity (`packages/auth/src/types/node.ts`):

```typescript
export interface NodeAttestation {
  nodeId: string;
  buildHash: string;      // SHA256 hash of running binary
  sourceCommit: string;
  version: string;
  signature: string;      // Ed25519 signature over all fields
}
```

This is a machine-verifiable integrity proof: a node proving it runs approved software. It has nothing to do with trust relationships between people.

The Progressive Trust Model states: *"Standing is computed, not assigned. It's a query over attestation history on `auth.identities`."* But `auth.identities` has no attestation fields.

The good news: the NodeAttestation architecture is an excellent design template — signed, typed, timestamped, registry-stored, verified. The same pattern applied at the identity layer is exactly what's needed. The design work at the infrastructure level is already done.

### 2. The Proposed Reframe: Trust Signing Starts at Onboarding

The BaggageDID (Proposal 5) correctly identifies that social context portability is a different problem from key portability, and introduces a privacy-preserving departure artifact. This proposal endorses the BaggageDID architecture — but argues that its cryptographic model should start higher up the chain.

The BaggageDID as proposed is issued at departure — a retrospective summary compiled at exit. If the underlying history is a collection of unsigned database records, the signed BaggageDID summary is **attestation-laundering**: converting unsigned social history into a signed artifact at the last possible moment, producing a cryptographic claim whose inputs were never cryptographically verified.

**The correct model: every trust-relevant act is signed when it occurs.**

#### 2.1 The Node–PersonalDID Relationship as the Cryptographic Root

When a personalDID joins a node, a bilateral relationship is established. That relationship should be initialized with a signed record — the equivalent of a mutual handshake: the node signs a record that this DID has joined, and the personalDID signs acceptance. This root record becomes the cryptographic anchor for all subsequent attestations within that relationship.

From this root, every trust-relevant act is a child attestation — signed by the issuer DID, referencing the root relationship, storing only what is necessary for standing computation while encrypting relationship-sensitive detail under the personalDID's key.

#### 2.2 Privacy Architecture: What the Node Sees vs. What It Knows

| Layer | Contents | Who Can Read |
|-------|----------|-------------|
| Public attestation record | Type, issuer DID, subject DID, timestamp, signature, aggregate metadata | Node operator, governance, network queries |
| Encrypted payload | Narrative context, relationship detail, flag content | personalDID only (or explicit key grants) |

This resolves the node-operator-as-surveillance-vector problem. The node operator has enough information to compute standing and enforce governance. They do not have access to the narrative content of individual relationships. That content belongs to the personalDID — encrypted under their key, portable with them on exit.

### 3. The Identity Attestation Data Layer

**Schema** (following the NodeAttestation pattern):

```sql
CREATE TABLE auth.attestations (
  id           TEXT PRIMARY KEY,           -- att_xxx
  issuer_did   TEXT NOT NULL,              -- who signed it
  subject_did  TEXT NOT NULL,              -- who it's about
  type         TEXT NOT NULL,              -- controlled vocabulary
  context_id   TEXT,                       -- event/org/interaction DID or ID
  context_type TEXT,                       -- 'event' | 'org' | 'interaction' | 'system'
  payload      JSONB DEFAULT '{}',         -- type-specific public metadata
  encrypted_payload TEXT,                  -- narrative detail, encrypted under subject_did key
  signature    TEXT NOT NULL,              -- Ed25519 by issuer_did
  issued_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,                -- optional decay (for time-limited flags)
  revoked_at   TIMESTAMPTZ                 -- nullable, for revocation
);
```

#### 3.1 Controlled Attestation Type Vocabulary

| Type | Issuer | Description |
|------|--------|-------------|
| `node.join` | Node DID | personalDID joined this node (root record) |
| `node.join.accepted` | personalDID | personalDID accepts node join (bilateral root) |
| `event.attendance` | EventDID | Verified physical presence at event |
| `vouch.given` | Established DID | Sponsors a Preliminary DID's onboarding |
| `vouch.received` | System | Acknowledgment of vouch acceptance |
| `checkin.verified` | Org DID | Physical presence at org location |
| `interaction.verified` | System | Completed meaningful exchange with Established DID |
| `milestone.completed` | System | Onboarding milestone reached |
| `flag.yellow` | Established DID / governance | Low-severity flag |
| `flag.amber` | Governance body | Moderate-severity flag |
| `flag.red` | Governance body | Severe flag |
| `flag.cleared` | Governance body | Flag resolved |
| `vouch.outcome.positive` | System | Vouched person completed onboarding successfully |
| `vouch.outcome.negative` | System | Vouched person was flagged or removed |

#### 3.2 Standing Computation

Standing is a computed view over the attestations table — not a stored field:

```
standing(did) = f(
  positive_attestations(did),   // weighted sum by type and recency
  negative_attestations(did),   // flags, weighted by tier
  trust_graph_depth(did),       // BFS depth from trust-graph package
  fair_contribution_count(did), // .fair manifests where did appears
  activity_recency(did)         // decay function on last attestation timestamp
)
```

Tier thresholds:
- Soft DID (Visitor): no attestations required
- Hard DID Preliminary (Resident): keypair registration
- Hard DID Established (Host): `standing(did) >= ESTABLISHED_THRESHOLD` (value to be set by governance)

### 4. The BaggageDID as a Natural Output

With the attestation layer in place, the BaggageDID (Proposal 5) becomes architecturally coherent:

| Without attestation layer | With attestation layer |
|--------------------------|----------------------|
| BaggageDID summarizes unsigned DB records | BaggageDID aggregates already-signed attestation records |
| Cryptographic claim with unverified inputs | Cryptographic claim with verified, signed inputs |
| Integrity is asserted | Integrity is provable |

The presenter-control model is fully preserved and strengthened. Because the attestation payloads are encrypted under the personalDID's key, the originating node cannot reconstruct the BaggageDID's encrypted layer after the personalDID has left. The data belongs to the person, not the node.

### 5. .fair Attribution Integrity: The Same Root

The .fair signing proposal (Proposal 6) identifies that `FairManifest` objects are currently unsigned. The fix — cryptographic signing with Ed25519, settlement enforcement rejecting unsigned manifests — is correct and urgent.

The strongest articulation in Proposal 6 applies with equal force here:

> *"A protocol primitive that can be self-declared by any node, without verification, is not a primitive — it is a convention. Conventions break under adversarial conditions. Cryptographic signing does not."*

The attestation data layer must include a verification gate at ingestion — unsigned or unverifiable attestations should be rejected, not merely stored with a null signature field.

#### 5.1 Agent DIDs: A New Actor Type Not Yet Accounted For

The .fair proposal introduces agent DIDs — child keys derived from parent human or organizational DIDs, with authority scope encoded in the key derivation path. The attestation data layer as currently specified does not account for non-human DID actors. Before the attestation schema is finalized:

| Question | Required Answer |
|----------|----------------|
| Can an agent DID issue attestations? | Yes/No — determines whether automated check-ins and event attendance records are valid |
| What is an agent DID's attestation authority scope? | Derived from parent DID? Explicitly delegated? |
| Can an agent DID receive attestations (be vouched for, flagged)? | Determines whether agents have standing in the trust graph |
| How are agent attestations distinguished from human attestations? | Type field? Separate issuer class? |

### 6. What This Unblocks

| Proposal | Blocked By | Unblocked When |
|----------|-----------|----------------|
| Progressive Trust Model | No attestation table | auth.attestations + standing computation |
| Trust Accountability Framework | No flag storage | auth.attestations with flag types |
| Cultural DID governance | No token context computation | Standing computation over attestations |
| BaggageDID (Proposal 5) | Unsigned history | Attestation layer + encrypted payloads |
| .fair signing (Proposal 6) | No signing infrastructure | @imajin/auth sign/verify utilities |
| Social recovery (Embedded Wallet) | No trust graph attestations | Attestation layer operational |

### 7. Open Questions for Ryan

| Question | Why It Matters | Greg's Position |
|----------|---------------|----------------|
| Should `auth.attestations` live in the `auth` schema or a new `trust` schema? | Determines service ownership and cross-service access patterns | New `trust` schema — semantically distinct from identity primitives |
| Is the bilateral root record (node + personalDID both sign) required for MVP, or deferred? | Bilateral root is the cleanest model; unilateral is simpler to ship | Bilateral, even in MVP — it's one extra signature on join |
| Who can issue `interaction.verified` attestations — system only, or also peer DIDs? | If peer-issued, social gaming becomes possible; if system-only, interaction verification requires server-side logic | System-issued, triggered by both parties completing a defined interaction (e.g., message exchange with response) |
| Does standing computation run on every session check, or is it cached? | Performance concern at scale | Cached with TTL (e.g., 5 minutes), invalidated on new attestation |
| Should flags be a subtype of attestation, or a separate table? | Flags have different privacy and governance requirements | Subtype of attestation — same signing model, different access control on encrypted payload |
| Can a personalDID revoke an attestation they issued (e.g., a vouch for someone they no longer trust)? | Vouch revocation before onboarding completion — should it be possible? | Yes for vouch revocation during probation window; no for retroactive revocation after onboarding completes |

### 8. Implementation Path

**Phase 1 — Foundation** (unblocks all dependent proposals):
- New migration: `auth.attestations` table
- Controlled type vocabulary defined and documented
- Signing utilities in `@imajin/auth`: `sign(attestation, privateKey)` and `verify(attestation)`
- Ingestion enforcement: unsigned attestations rejected at write
- Standing computation view or function over `auth.attestations`
- Onboarding root record: bilateral signed record on personalDID join

**Phase 2 — BaggageDID integration**:
- `departureSummary(did, departureType)`: authenticated aggregate query over `auth.attestations`
- Encrypted context layer: export of attestation payloads under personalDID key
- `issueBaggageDID(did, departureType)`: signed departure artifact generation
- `departure_type` field on `pod_members` removal events
- `verifyAndSeedBaggageDID(baggageDid)`: receiving node ingestion and trust seeding

**Phase 3 — .fair and Stream 3**:
- `FairManifest` gains `signature` field
- `@imajin/fair` exports `sign(manifest, privateKey)` and `verifyManifest(manifest)`
- Settlement routes reject unsigned or invalid-signature manifests
- Agent DID attestation scope defined and encoded in key derivation (per Ryan's decision on Q5 in Proposal 6)
- Stream 3 does not go live until Phase 1 signing enforcement is deployed

**Detecting resolution in the repo:**
- New migration adding `auth.attestations` (or `trust.attestations`)
- `@imajin/auth` exports `signAttestation` and `verifyAttestation`
- Standing computation function in auth service
- Onboarding flow creates bilateral root record
- Any commit referencing "attestation layer" or "identity attestation" (distinct from build attestation)

---

