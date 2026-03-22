# Batch 2: Trust Boundaries — #416 (Registry) + #418 (.fair) + #419 (Pay)

**Depends on:** #425 (auth consolidation), Batch 1 (`chainVerified` on Identity type)
**Parallel:** All three issues are independent, can run simultaneously.

---

## Issue #416: Chain-Verified Node Registration

### Context

Registry currently verifies nodes via `NodeAttestation` — a signed struct with `nodeId`, `publicKey`, `buildHash`, `hostname`. Signature is verified against the bare public key. No chain awareness.

For federation, nodes need chain-backed identity. But per the unified substrate principle, registry doesn't verify chains directly — it asks auth.

### What to build

**1. Auth: chain verification endpoint for service-to-service use**

File: `apps/auth/app/api/identity/verify-chain/route.ts` (new)

```typescript
// POST /api/identity/verify-chain
// Internal endpoint — accepts a chain log, verifies it, returns identity info
// Used by registry (and future services) to verify chain-backed identity
//
// Request:
// { chainLog: string[] }  — the DFOS chain log entries
//
// Response:
// { 
//   valid: boolean,
//   did?: string,           // the canonical DID (did:imajin alias if exists, otherwise chain DID)
//   chainDid?: string,      // the chain-native DID (e.g. did:dfos:...)
//   publicKey?: string,     // current public key from chain head
//   keyCount?: number,
//   error?: string 
// }

import { verifyChain } from '@imajin/dfos';
// ... verify the chain, look up if a did:imajin alias exists, return unified response
```

This is the **chain abstraction point**. When a second chain provider is added, this endpoint handles the routing. Registry doesn't know or care which chain protocol was used.

**2. Registry: accept chain log in registration**

File: `apps/registry/app/api/node/register/route.ts`

Extend the registration to accept an optional `chainLog` alongside the existing `attestation`:

```typescript
const { attestation, chainLog } = body;

// If chain log provided, verify it through auth
if (chainLog && Array.isArray(chainLog)) {
  const authUrl = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
  const verifyRes = await fetch(`${authUrl}/api/identity/verify-chain`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.AUTH_INTERNAL_API_KEY}`,
    },
    body: JSON.stringify({ chainLog }),
  });
  
  if (verifyRes.ok) {
    const chainInfo = await verifyRes.json();
    if (chainInfo.valid) {
      // Store chain DID reference on node record
      // The public key from the chain MUST match the attestation public key
      if (chainInfo.publicKey !== attestation.publicKey) {
        return error('Chain public key does not match attestation');
      }
      // chainDid stored for federation resolution
    }
  }
}
```

**3. Registry: add `chainDid` column to nodes table**

This is the ONE place outside auth that stores a chain reference — because registry IS the federation directory. It needs to resolve "given a chain DID, where is this node?"

```sql
ALTER TABLE registry.nodes ADD COLUMN chain_did TEXT UNIQUE;
```

Migration file: `apps/registry/drizzle/XXXX_chain_did.sql`

Schema update: add `chainDid` to the nodes table in `apps/registry/src/db/schema.ts` (or equivalent).

**4. Registry: chain-based resolution endpoint**

File: `apps/registry/app/api/node/resolve/[did]/route.ts` (new)

```typescript
// GET /api/node/resolve/:did
// Resolve a DID (chain DID or did:imajin) to a node endpoint
// Returns: { node: { hostname, subdomain, status, services } }
```

This is "DNS for DIDs" — given any DID, find the node.

**5. Registry: re-verify chain on heartbeat**

File: `apps/registry/app/api/node/heartbeat/route.ts`

If the node has a `chainDid`, check chain head on heartbeat. Detect key rotation (chain head changed), node migration (same chain, different endpoint). If chain verification fails on heartbeat, mark node as `degraded` (not immediately expired — could be transient).

### What NOT to do

- Registry does NOT import `@imajin/dfos` — verification goes through auth
- Chain log is optional — nodes can still register with bare attestation (backward compatible)
- No DFOS-specific terminology in registry API responses — use generic "chain" language

### Build & test

```bash
cd apps/registry && rm -rf .next && npx next build
```

---

## Issue #418: Portable Attribution with Chain-Backed Creator Proof

### Context

.fair manifests use `did:imajin` for creator/contributor DIDs. These are only meaningful within the Imajin network. For portable attribution — content that leaves the node and needs to be independently verifiable — the manifest needs a chain-resolvable creator identifier.

### What to build

**1. .fair manifest: add `chainProof` field**

File: `packages/fair/src/types.ts`

```typescript
export interface FairContributor {
  did: string;              // did:imajin alias (human-readable)
  role: string;
  share?: number;
  chainProof?: {            // NEW — present when contributor has chain identity
    verified: boolean;      // was chain verified at manifest creation time?
    verifiedAt?: string;    // ISO timestamp
    // No chain-specific DID here — the did:imajin resolves to the chain through auth
  };
}
```

**Why not include the chain DID?** Because the manifest is substrate-agnostic. Any verifier resolves the `did:imajin` through the registry/auth to get chain proof. The manifest doesn't need to know which chain provider was used.

**2. Media: populate chainProof on upload**

File: `apps/media/app/api/assets/route.ts` (or wherever .fair sidecar is created)

When creating a .fair manifest on upload, check if the uploader has chain verification:

```typescript
const authResult = await requireAuth(request);
// ... 
const chainProof = authResult.identity.chainVerified 
  ? { verified: true, verifiedAt: new Date().toISOString() }
  : undefined;

// Include in .fair manifest
const manifest = {
  // ...existing fields
  contributors: [{
    did: authResult.identity.id,
    role: 'creator',
    share: 100,
    chainProof,
  }],
};
```

**3. FairEditor: show verification status**

File: `packages/fair/src/components/FairEditor.tsx`

Next to each contributor, show a small verification badge if `chainProof.verified` is true. Same visual language as profile badges (#417).

**4. FairAccordion: show verification in read-only view**

Same badge treatment in the read-only accordion component.

### What NOT to do

- No `dfosDid` field in .fair manifests
- No chain library imports in media or fair packages
- Verification status comes from auth, stored as a boolean snapshot at creation time

### Build & test

```bash
cd apps/media && rm -rf .next && npx next build
```

---

## Issue #419: Chain-Verified Settlement Parties

### Context

Pay service handles Stripe payments and settlement. Currently trusts the session identity without chain verification. For trust-relevant writes (committing a settlement), the payer/payee should be chain-verified.

### What to build

**1. @imajin/auth: add `verifyChain` option to requireAuth**

File: `packages/auth/src/require-auth.ts`

```typescript
interface AuthOptions {
  verifyChain?: boolean;  // If true, also verify the chain is valid (not just session)
}

export async function requireAuth(
  request: Request,
  options?: AuthOptions
): Promise<AuthResult | AuthError> {
  // ... existing session/bearer validation
  
  if (options?.verifyChain && result.identity) {
    // Call auth's chain verification endpoint
    const chainRes = await fetch(`${getAuthUrl()}/api/identity/${encodeURIComponent(result.identity.id)}/verify`);
    if (!chainRes.ok) {
      // Chain verification failed — identity is still valid, but flag it
      result.identity.chainVerified = false;
    } else {
      const chainData = await chainRes.json();
      result.identity.chainVerified = chainData.chain?.valid ?? false;
    }
  }
  
  return result;
}
```

**2. Pay: use `verifyChain` on settlement**

File: `apps/pay/app/api/settle/route.ts` (or equivalent settlement endpoint)

```typescript
const authResult = await requireAuth(request, { verifyChain: true });
```

For webhook-triggered settlements (Stripe callback), the verification happens on the payer's identity when the payment intent was created, not on the webhook itself.

**3. Settlement attestations: include verification status**

When emitting a `transaction.settled` attestation, include whether the parties were chain-verified:

```typescript
payload: {
  amount: ...,
  currency: ...,
  payerChainVerified: true,
  payeeChainVerified: true,
}
```

This makes settlement attestations more meaningful for standing computation — a chain-verified settlement carries more weight.

### What NOT to do

- Don't block payments if chain verification fails — Stripe payments must complete
- Don't add chain-specific fields to transaction records
- `verifyChain` is opt-in, not default — only for trust-relevant writes

### Build & test

```bash
cd apps/pay && rm -rf .next && npx next build
```

---

## Commit strategy

- `feat(auth): chain verification endpoint + verifyChain option in requireAuth`
- `feat(registry): chain-verified node registration + DID resolution (#416)`
- `feat(fair): portable attribution with chain-backed creator proof (#418)`
- `feat(pay): chain-verified settlement parties (#419)`
