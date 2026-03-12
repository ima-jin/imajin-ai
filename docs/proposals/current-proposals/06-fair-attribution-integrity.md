## 6. .fair Attribution Integrity — Cryptographic Signing for Automated Node Settlement

**Author:** Greg Mulholland
**Date:** March 10, 2026
**Thread:** `current-threads/fair-attribution-automated-nodes.md`
**Related upstream:** `packages/fair/`, Discussion #268 (Embedded Wallet), MJN whitepaper v0.2
**Addresses:** .fair Attribution Integrity for Automated Nodes (Critical)

### Executive Summary

The whitepaper positions .fair as a required protocol primitive. A protocol primitive that can be self-declared by any node, without verification, is not a primitive — it is a convention. Conventions break under adversarial conditions. Cryptographic signing does not.

### The Problem in Detail

**What .fair manifests are today:**

Any service can call `createManifest({ owner: "did:imajin:ryan", attribution: [...] })` and receive a structurally valid manifest. The system cannot distinguish this from a manifest actually authorized by `did:imajin:ryan`. There is no signature. There is no proof. Validation checks structure and arithmetic — share totals, required fields, type correctness. It does not verify that the declared owner authorized the manifest.

**Why Stream 3 makes this critical:**

For human-initiated transactions, social accountability and UI friction provide sufficient integrity. A human reviewing and submitting a manifest is an implicit consent signal. Stream 3 eliminates that signal entirely. When one agent calls another autonomously — a Cultural DID treasury executing a distribution, a node-to-node data exchange, an inference gateway settling compute — the manifest is written by software and settled by software. There is no human review step.

**What on-chain anchoring does and does not solve:**

The Embedded Wallet RFC introduces on-chain manifest hash anchoring. This is meaningful progress — if the hash is recorded at settlement, the manifest becomes tamper-evident after the fact. But it does not solve origination. The hash proves the manifest was not modified after settlement. It does not prove the manifest was authorized by the named owner before settlement. A fraudulent manifest anchored on-chain is a fraudulent manifest with a permanent record.

### Proposed Resolution

**Architectural direction:** .fair manifests become signed protocol messages — the same pattern applied to every other MJN exchange. The manifest owner DID signs the manifest with their private key. Any recipient can verify the signature against the DID's public key. Unsigned manifests are rejected at the settlement layer.

**Minimum viable implementation — four concrete changes:**

| Change | Location | Description |
|--------|----------|-------------|
| Add `signature` field | `packages/fair/src/types.ts` | `{ algorithm: 'ed25519', value: string, publicKeyRef: string }` |
| Add `sign(manifest, privateKey)` | `packages/fair/src/index.ts` | Returns `SignedFairManifest` |
| Add `verifyManifest(manifest)` | `packages/fair/src/index.ts` | Checks signature against `owner` DID's public key |
| Enforce at settlement | `apps/pay/` settlement routes | Reject unsigned or invalid-signature manifests |

**Automated node authorization model:**
- Agent DIDs are child keys derived from parent human or organizational DIDs (hierarchical key model from Embedded Wallet RFC)
- Agent manifests are signed by the agent's own DID keypair
- The agent DID's derivation encodes authority scope — what attributions the agent is permitted to declare
- Out-of-scope attributions fail at the signing step — the agent's key does not carry that authority and cannot produce a valid signature for that claim

### Open Questions: Greg's Position

**Q1 — Unsigned manifests: reject or treat as provisional?**

Position: reject. A manifest that cannot be verified is not a .fair manifest — it is an attribution claim. The settlement layer should treat them as invalid. Migration of existing unsigned manifests is handled separately (see Q4).

**Q2 — Multi-contributor signing: owner only, or all contributors?**

Position: owner-only for MVP; migrate to multi-party later. Multi-party signing requires an async signing flow (manifest created → distributed to contributors for signature → settleable only once all signatures collected). This is meaningful additional complexity. Ryan should weigh whether MVP launches with owner-only signing.

**Q3 — Cultural DID treasury signing:**

Two approaches:
- **Quorum signature (N-of-M):** Distribution manifests require signatures from N Governing Members. Most cryptographically rigorous. Adds coordination requirement.
- **Designated treasury key:** Cultural DID generates a treasury child key. A quorum vote authorizes the treasury key to sign. Simpler operationally; the governance is in the key authorization, not in each signing act.

Position: designated treasury key with quorum authorization. Cleaner UX, governance burden at key creation rather than at each distribution.

**Q4 — Retroactive signing: migration path for existing manifests:**

Position: legacy manifests are tagged as `{ signed: false, legacy: true }` and excluded from signature verification. All new manifests from the signing enforcement date require signatures. This avoids migration deadlock (asking all historical manifest owners to retroactively sign is operationally infeasible) while maintaining a clear boundary.

**Q5 — Agent authority scope: key derivation:**

Position: scope must be encoded in the agent DID's derivation path. An agent DID derived as `did:imajin:ryan/delegate/jin` carries Ryan's authority for delegated actions within Jin's scope. This requires the Embedded Wallet RFC's hierarchical key model to support scope encoding in derivation paths — if that is not currently planned, it becomes a dependency before Stream 3 can launch with full attribution integrity.

### Decisions Required from Ryan

| Decision | Options | Blocking? |
|----------|---------|-----------|
| Unsigned manifests | Reject / treat as provisional | Yes — determines enforcement model |
| Multi-contributor signing | Owner-only MVP / full multi-party | Yes — determines manifest signing flow |
| Cultural DID treasury | Quorum signature / designated treasury key | Yes — determines Cultural DID settlement model |
| Retroactive migration | Legacy tag / retroactive signing | Yes — determines migration scope |
| Agent scope encoding | Key derivation / permission system | Yes for Stream 3 — determines agent authorization model |

---

