## STATUS: RESOLVED
**Resolved:** 2026-03-15
**Evidence:** Upstream main HEAD eacad35 — `packages/fair/src/sign.ts` created, `packages/fair/src/canonical.ts` created, `packages/fair/src/types.ts` updated. Issue #316 (shared keystone) and #317 (.fair cryptographic signing) shipped together.
**Outcome:** `signature?: FairSignature` and `platformSignature?: FairSignature` added to `FairManifest`. `signManifest()` and `verifyManifest()` built in `packages/fair/src/sign.ts` using Ed25519 via `@noble/ed25519`. Canonical JSON serialization in `packages/fair/src/canonical.ts`. Settlement enforcement (unsigned manifests rejected) is Phase 1 — infra is live, enforcement wired into settlement next. Ryan's ruling against legacy manifests adopted: no legacy concept, every manifest signed from day one.
**Implementation:** in code
---

## P3 — FairManifest Has No Signature Field

**File:** `packages/fair/src/types.ts`
**Severity:** Missing enforcement — protocol claim without cryptographic backing
**Detected:** March 10, 2026

### The Code (as of detection)

```typescript
export interface FairManifest {
  fair: string;
  id: string;
  type: string;
  owner: string;         // DID of owner — asserted, not proven
  created: string;
  attribution: FairEntry[];
  distributions?: FairEntry[];
  access: FairAccess;
  transfer?: FairTransfer;
  integrity?: FairIntegrity; // asset hash — not manifest signing
  terms?: string;
}
```

### The Problem

`FairManifest` had no `signature` field. Any service could declare `owner: "did:imajin:ryan"` without cryptographic proof that `did:imajin:ryan` authorized the manifest. The `FairIntegrity` type (`{ hash: string, size: number }`) was for asset integrity (file hash), not manifest authorization.

The MJN whitepaper v0.2 declares .fair a required protocol primitive. A protocol primitive that can be self-declared without verification is a convention, not a primitive.

For human-driven transactions this was an acceptable interim state — UI friction provides implicit consent. For Stream 3 (automated node-to-node settlement), there is no human in the loop and no implicit consent signal.

### The Fix (as implemented)

Added to `packages/fair/src/types.ts`:

```typescript
export interface FairSignature {
  algorithm: 'ed25519';
  value: string;         // hex-encoded signature over canonical manifest JSON
  publicKeyRef: string;  // DID of signing key (must match owner)
}

// On FairManifest:
signature?: FairSignature;           // Ed25519 signature by the owner DID
platformSignature?: FairSignature;   // platform endorsement (breaks on creator edit)
```

Added to `packages/fair/src/sign.ts`:
- `signManifest(manifest, privateKeyHex, signerDid)` — async, Ed25519 via `@noble/ed25519`
- `verifyManifest(manifest, resolvePublicKey)` — async verify with DID→publicKey resolver

Added `packages/fair/src/canonical.ts` — deterministic JSON serialization before signing.

### Decisions Locked (from .fair Hardening Roadmap)

- Unsigned manifests at settlement → **REJECT** (our recommendation adopted)
- No legacy manifests → **No legacy concept** (Ryan's decision — pre-launch, no existing manifests worth preserving)
- Edit behavior → **Resign on edit** (no version chain for MVP; transaction table is the audit trail)
- Platform signature → **Separate `platformSignature` field** (breaks on creator edit by design)

### Status Update — 2026-03-13: Acknowledged, Implementation Planned

Ryan's .fair Hardening Roadmap (March 13, 2026) directly addressed P3 across two phases. Both phases shipped by March 15, 2026 in upstream main.

**Phase 0** — `signature?` field added to `FairManifest` as optional. ✅ Shipped.
**Phase 1** — `signManifest()` + `verifyManifest()` built in `packages/fair/src/sign.ts`. ✅ Shipped.
