## P3 — FairManifest Has No Signature Field

**File:** `packages/fair/src/types.ts`
**Severity:** Missing enforcement — protocol claim without cryptographic backing
**Detected:** March 10, 2026

### The Code

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

`FairManifest` has no `signature` field. Any service can declare `owner: "did:imajin:ryan"` without cryptographic proof that `did:imajin:ryan` authorized the manifest. The `FairIntegrity` type (`{ hash: string, size: number }`) is for asset integrity (file hash), not manifest authorization.

The MJN whitepaper v0.2 declares .fair a required protocol primitive. A protocol primitive that can be self-declared without verification is a convention, not a primitive.

For human-driven transactions this is an acceptable interim state — UI friction provides implicit consent. For Stream 3 (automated node-to-node settlement), there is no human in the loop and no implicit consent signal.

### The Fix

Add to `FairManifest`:

```typescript
signature?: {
  algorithm: 'ed25519';
  value: string;         // base58 or hex encoded signature
  publicKeyRef: string;  // DID of signing key
}
```

Add to `packages/fair/src/index.ts`:
- `sign(manifest: FairManifest, privateKey: string): SignedFairManifest`
- `verifyManifest(manifest: SignedFairManifest): boolean`

Enforce at settlement: reject manifests with missing or invalid signatures (after a migration window for legacy manifests — see Proposal 6 in `current-proposals.md` for the full migration plan).

### How to Detect Resolution in the Repo

- `packages/fair/src/types.ts` gains a `signature` field on `FairManifest`
- `packages/fair/src/index.ts` exports `sign` and `verifyManifest` functions
- Any commit touching `apps/pay/` settlement routes to add signature validation

---

