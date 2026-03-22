# Batch 3: Federation — #421 (Connections) + #422 (Chat) + #423 (Learn) + #424 (External Onboarding)

**Depends on:** Batches 1 + 2 (chain verification infrastructure must exist)
**Status:** These issues need design decisions before implementation. This work order captures the scope and open questions. Implementation work orders will be written when design is resolved.

---

## Issue #421: Chain-Backed Pods + Cultural DID

### Scope

Pod membership changes (add/remove member, change role) should be recorded as chain operations when the pod owner has chain identity. Cultural DID (collective identity for communities) needs multi-signer chain governance.

### What needs to happen

**Phase A — Chain-recorded membership (implementable now):**

1. When a pod owner with chain identity adds/removes a member, emit an attestation recording the change
2. Pod membership attestations: `pod.member.added`, `pod.member.removed`, `pod.role.changed`
3. These attestations live on the **owner's** chain (unilateral operations)
4. Cross-node pod membership: verify member's chain when they join from another node

**Phase B — Cultural DID (blocked on design):**

1. Collective chains need multi-signer support — one chain governed by N guardians with threshold signatures
2. Per P27 §7.4: propose this to DFOS upstream as a protocol extension, not an MJN-only fork
3. If upstream doesn't support it: design a clean MJN extension using individual chains + countersignatures to simulate collective governance
4. Governance config (quorum thresholds, standing decay, TTLs) as typed content on the collective chain

### Open design questions

- Does `@metalabel/dfos-protocol` 0.2.0 support any multi-signer primitives?
- Can we simulate collective governance with individual chains + countersigned attestations? (Every governance action = N individual countersignatures meeting a threshold)
- What's the minimum viable Cultural DID for April 1? (Maybe just: a pod with a governance config and countersigned membership changes?)

### Recommendation

Write Phase A now (chain-recorded membership). Phase B needs a conversation with the DFOS team about collective chains. Don't build a half-solution for Cultural DID — it's too important to get wrong.

---

## Issue #422: Signed Messages + Federation Prep

### Scope

Messages signed with chain keys for federation. CID-address messages only when they cross node boundaries.

### What needs to happen

**Phase A — Message signing (implementable now):**

1. When sending a message, if the sender has chain identity, sign the message content with their chain key
2. Store signature alongside message: `messagesV2.signature` column (nullable — not all senders have chains)
3. Signature covers: `{ conversationDid, content, fromDid, createdAt }` canonicalized
4. Verification: any recipient can verify the message was sent by the claimed DID

**Phase B — Federation (blocked on relay design):**

1. Cross-node message relay: node A sends signed message to node B
2. Receiving node verifies sender's chain before accepting
3. CID-address the message for content-addressed routing
4. Conversation discovery across nodes

### Open design questions

- What's the relay protocol? WebSocket? HTTP push? DFOS web relay spec?
- How does a node discover conversations on other nodes?
- Message ordering across nodes (vector clocks? chain-ordered?)
- Per P27 §7.1: CID only at trust boundaries. Internal messages don't need CIDs.

### Recommendation

Phase A (message signing) is straightforward and unblocked. Can ship independently. Phase B needs an RFC — federation is a design problem, not an implementation ticket. Write the relay RFC before coding.

### Implementation notes for Phase A

```sql
ALTER TABLE chat.messages_v2 ADD COLUMN signature TEXT;
```

Sign on write:
```typescript
// In POST /api/d/[did]/messages
if (identity.chainVerified) {
  const payload = canonicalize({ conversationDid: did, content, fromDid: identity.id, createdAt: new Date() });
  // Sign via auth service internal endpoint
  const sig = await signWithChainKey(identity.id, payload);
  // Store alongside message
}
```

Verify on read (optional, for federation prep):
```typescript
// GET /api/d/[did]/messages — include signature in response
// Consumers can verify independently
```

---

## Issue #423: Chain-Backed Enrollment + Verifiable Credentials

### Scope

Course completion as a verifiable credential. Smallest issue in the epic.

### What needs to happen

1. When a user completes a course, emit a `learn.completed` attestation
2. If the learner has chain identity, the attestation is chain-anchored (verifiable externally)
3. Use `@metalabel/dfos-protocol@0.2.0` credential module (`/credentials`) for VC-JWT format
4. Enrollment attestation: `learn.enrolled` (already possible with existing attestation infra)

### Implementation

**1. Add attestation types:**

File: `packages/auth/src/types/attestation.ts`

```typescript
'learn.enrolled',
'learn.completed',
'learn.credential',    // the VC-JWT credential
```

**2. Emit on completion:**

File: `apps/learn/app/api/courses/[id]/complete/route.ts` (or wherever completion is recorded)

```typescript
await emitAttestation({
  issuer_did: courseDid,           // the course/instructor DID
  subject_did: identity.id,        // the learner
  type: 'learn.completed',
  context_id: courseId,
  context_type: 'course',
  payload: {
    course_title: course.title,
    completed_at: new Date().toISOString(),
    modules_completed: moduleCount,
  },
});
```

**3. VC-JWT credential (stretch):**

Using dfos-protocol 0.2.0 credentials module:
```typescript
import { createCredential } from '@metalabel/dfos-protocol/credentials';
// Create a verifiable credential for the completion
// This is the portable proof that works outside Imajin
```

This depends on the credential module API. Check the 0.2.0 docs before implementing.

### Recommendation

Steps 1-2 are trivial — just attestation emission, same pattern as events check-in. Step 3 (VC-JWT) depends on dfos-protocol 0.2.0 credential API stability. Do 1-2 now, 3 when the API is confirmed.

---

## Issue #424: External Chain Identity Onboarding

### Scope

"Log in with your chain" — accept external chain identities from any trusted provider.

### What needs to happen

**1. Auth: chain presentation endpoint**

File: `apps/auth/app/api/identity/present-chain/route.ts` (new)

```typescript
// POST /api/identity/present-chain
// An external user presents their chain log
// Auth verifies it, creates a did:imajin alias, returns a session
//
// Request: { chainLog: string[], provider?: string }
// Response: { session, identity: { id, tier: 'preliminary', chainVerified: true } }
```

Flow:
1. Parse the chain log
2. Detect provider (DFOS by chain format, future: other providers)
3. Verify chain cryptographically
4. Check if this chain DID already has a did:imajin alias → return existing session
5. If new: create did:imajin alias + identity row + link to chain → return new session
6. Trust tier: `preliminary` (chain exists but no attestations on this network)

**2. Auth: provider abstraction — REFACTOR existing chain verification**

⚠️ **There are currently TWO separate chain verification paths in auth that must be consolidated:**
- `apps/auth/lib/dfos.ts` → `verifyClientChain()` — used by registration/identity flows, imports `@imajin/dfos` directly
- `apps/auth/app/api/identity/verify-chain/route.ts` — service-to-service endpoint (added in Batch 2 #416), also imports `@imajin/dfos` directly

**Both must be refactored to use the new provider abstraction.** Do NOT add a third path alongside these.

```typescript
// apps/auth/lib/chain-providers.ts
interface ChainProvider {
  name: string;
  canVerify(chainLog: string[]): boolean;  // does this look like our format?
  verify(chainLog: string[]): Promise<ChainVerificationResult>;
  extractDid(chainLog: string[]): string;
  extractPublicKey(chainLog: string[]): string;
}

const providers: ChainProvider[] = [
  dfosProvider,   // @imajin/dfos — first and only provider for now
  // future: other providers register here
];

// Resolves the right provider and verifies
export async function verifyChainLog(chainLog: string[]): Promise<ChainVerificationResult> { ... }
```

**Refactor checklist:**
- [ ] Create `apps/auth/lib/chain-providers.ts` with `ChainProvider` interface + `dfosProvider` implementation
- [ ] Create `apps/auth/lib/providers/dfos.ts` — extract DFOS-specific logic from `apps/auth/lib/dfos.ts`
- [ ] Refactor `apps/auth/lib/dfos.ts` → `verifyClientChain()` to call `verifyChainLog()` instead of importing `@imajin/dfos` directly
- [ ] Refactor `apps/auth/app/api/identity/verify-chain/route.ts` to call `verifyChainLog()` instead of importing `@imajin/dfos` directly
- [ ] `@imajin/dfos` should only be imported in `apps/auth/lib/providers/dfos.ts` — nowhere else in auth

This is the substrate-agnostic hook. Adding a new chain provider = implementing the interface and registering it. All existing chain verification is consolidated behind one abstraction.

**3. UI: "Log in with your chain" button**

On the auth login page, alongside email magic link:
- "Present your identity chain" → file upload or paste of chain log
- Verify → session created → redirect to profile

### Trust semantics (from P27 §7.3)

- External chain user gets `tier: 'preliminary'` — NOT established
- Zero standing on this network. Chain saves keypair generation, not vouching.
- Exception: if the chain carries countersignatures from DIDs this node already trusts, those attestations count toward standing. This is the system working as designed.

### Open design questions

- UX: how does a user "present" their chain? File upload? QR code? URL to their chain endpoint?
- Should we support chain URLs (`https://theirnode.example/api/identity/chain`) in addition to raw log upload?
- Rate limiting: prevent chain presentation spam

### Recommendation

This is medium complexity but clean. The provider abstraction is the key piece — get that right and adding future chain providers is trivial. Can be built after Batch 2 ships the chain verification endpoint in auth.

---

## Summary: What's blocked vs. ready

| Issue | Phase A (now) | Phase B (needs design) |
|-------|--------------|----------------------|
| #421 Connections | Chain-recorded membership ✅ | Cultural DID — needs DFOS collective chain proposal |
| #422 Chat | Message signing ✅ | Federation relay — needs RFC |
| #423 Learn | Attestation emission ✅ | VC-JWT — needs 0.2.0 API review |
| #424 Auth | Chain presentation + provider abstraction ✅ | Multi-provider — future |

Phase A of all four issues can be built now. Phase B needs design conversations first.
