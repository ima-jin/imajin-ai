# Batch 1: Foundation — #417 (Profile) + #420 (Events/Door-Check)

**Depends on:** #425 (auth consolidation — in progress)
**Parallel:** Both issues are independent, can run simultaneously.

---

## Issue #417: Surface Chain Verification Status in Profile

### Context

Profile currently shows handle, name, avatar. No indication of identity verification depth. With the unified identity substrate, profile should surface the *trust tier* — not chain-specific details.

### What to build

**1. Auth: Add `chainVerified` to session/identity response**

File: `apps/auth/app/api/session/route.ts` (and anywhere the session response is constructed)

When returning session data, look up whether the DID has a chain in `auth.identity_chains`:

```typescript
// After resolving the identity
const chain = await db.query.identityChains.findFirst({
  where: eq(identityChains.did, identity.id),
  columns: { did: true, headCid: true },
});

// Add to response
return {
  ...existingResponse,
  chainVerified: !!chain,
};
```

**2. @imajin/auth: Extend Identity type**

File: `packages/auth/src/types.ts`

```typescript
export interface Identity {
  id: string;
  type: "human" | "agent" | "presence";
  name?: string;
  handle?: string;
  tier?: "soft" | "preliminary" | "established";
  chainVerified?: boolean;  // NEW — does this identity have a verified chain?
}
```

Update `require-auth.ts` to pass through `chainVerified` from the session response.

**3. Profile API: Return trust tier**

File: `apps/profile/app/api/profile/[handle]/route.ts` (or equivalent)

Add to profile response:
```json
{
  "handle": "ryan",
  "name": "Ryan Veteze",
  "trustTier": "established",
  "chainVerified": true
}
```

The trust tier comes from `identity.tier`. `chainVerified` comes from the auth session. No new columns in the profile database.

**4. Profile UI: Verification badge**

On the profile page, show a subtle verification indicator:
- No badge for `soft` / unverified
- Shield icon for `preliminary` + chain verified
- Filled shield for `established` + chain verified

Keep it simple — a small icon next to the handle. No raw DIDs, no chain details.

**5. Public identity endpoint**

File: `apps/profile/app/api/profile/[handle]/identity/route.ts` (new)

```typescript
// GET /api/profile/:handle/identity
// Public endpoint — returns trust tier + verification status
// Used by other services and external systems
{
  "handle": "ryan",
  "did": "did:imajin:...",
  "tier": "established",
  "chainVerified": true,
  "attestationCount": 12  // optional, from auth
}
```

### What NOT to do

- No `dfosDid` field anywhere in profile
- No chain-specific UI (no "DFOS chain" label)
- Profile does not import `@imajin/dfos` — it only talks to `@imajin/auth`

### Build & test

```bash
cd apps/profile && rm -rf .next && npx next build
```

---

## Issue #420: Chain-Verified Attestations + Door-Check Type

### Context

The check-in route (`POST /api/events/[id]/tickets/[ticketId]/check-in`) currently just sets `used_at` timestamp. It creates no attestation. The door-check is the foundational operation linking chain identity to physical presence — it should produce a signed attestation.

### What to build

**1. Add `institution.verified` to attestation vocabulary**

File: `packages/auth/src/types/attestation.ts`

```typescript
export const ATTESTATION_TYPES = [
  'event.attendance',
  'institution.verified',     // NEW — physical presence verified by trusted actor
  'vouch.given',
  'vouch.received',
  // ... rest unchanged
] as const;
```

**2. Auth: attestation issuance endpoint (if not already existing)**

Check if `POST /api/attestations/internal` (used by connections) supports arbitrary types. If yes, no changes needed — it already accepts type + payload.

If it validates against `ATTESTATION_TYPES`, update the validation to include `institution.verified`.

**3. Events: emit attestation on check-in**

File: `apps/events/app/api/events/[id]/tickets/[ticketId]/check-in/route.ts`

After setting `used_at`, emit an `institution.verified` attestation:

```typescript
// After successful check-in
const [ticketInfo] = await sql`
  SELECT t.buyer_did, e.did as event_did, e.title as event_title
  FROM events.tickets t
  JOIN events.events e ON e.id = t.event_id
  WHERE t.id = ${ticketId}
`;

// Emit the door-check attestation
// issuer = the person doing the check-in (organizer/door person)
// subject = the ticket holder being verified
await emitAttestation({
  issuer_did: identity.id,           // the door person
  subject_did: ticketInfo.buyer_did, // the attendee
  type: 'institution.verified',
  context_id: ticketInfo.event_did,
  context_type: 'event',
  payload: {
    event_title: ticketInfo.event_title,
    ticket_id: ticketId,
    verified_at: new Date().toISOString(),
    method: 'in-person',            // vs future: 'video', 'nfc', etc.
  },
});
```

**4. Import `emitAttestation` helper**

The connections service already has this pattern in `src/lib/attestations.ts`. The events service needs the same helper. Options:

a) Copy the `emitAttestation` function to `apps/events/src/lib/attestations.ts` (quick, matches existing pattern)
b) Move it to `@imajin/auth` as a shared utility (cleaner, but bigger change)

**Recommendation:** Option (a) for now. Create `apps/events/src/lib/attestations.ts` with the same HTTP-to-auth-internal pattern. Moving to shared package can be a follow-up.

**5. Events: emit `event.attendance` attestation too**

The check-in should produce TWO attestations:
- `institution.verified` — "a trusted actor verified this person's physical presence" (the door-check primitive)
- `event.attendance` — "this person attended this event" (the event-specific fact)

These are semantically different. `institution.verified` is about identity verification. `event.attendance` is about participation. Both matter for standing computation.

### What NOT to do

- No chain-specific code in events — attestations go through auth's internal API
- No `dfosDid` on ticket records
- Don't block check-in if attestation emission fails (fire-and-forget, log errors)

### Build & test

```bash
cd apps/events && rm -rf .next && npx next build
```

Test: check in a ticket, verify attestation appears in auth's attestations table with correct type and payload.

---

## Commit strategy

- One commit per issue
- `feat(auth): add chainVerified to identity + institution.verified attestation type`
- `feat(profile): surface chain verification status (#417)`
- `feat(events): emit door-check attestation on check-in (#420)`
