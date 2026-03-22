# Work Order: #402 — Countersignature-Based Attestations

**Epic:** #395 (DFOS DID Bridge)  
**Issue:** #402  
**Scope:** Bilateral attestation model — author JWS + witness countersignature.  
**Branch:** `feat/402-countersignatures`  
**Depends on:** #400 (dag-cbor CID), #401 (key roles — assert key), PR #407 merged

---

## What You're Building

Replace unilateral attestations with a bilateral countersignature model:

1. Schema changes — `author_jws`, `witness_jws`, `attestation_status`, `cid` on attestations
2. `POST /api/attestations` — create attestation with author JWS + CID
3. `POST /api/attestations/:id/countersign` — witness countersigns same CID
4. `POST /api/attestations/:id/decline` — witness declines
5. `GET /api/attestations` — filter by status (pending/bilateral/declined)
6. Portable verification — both JWS tokens are self-verifying without DB

---

## Step 0: Setup

```bash
cd ~/workspace/imajin-ai
git checkout main && git pull
git checkout -b feat/402-countersignatures
```

## Files to Read First

1. `apps/auth/src/db/schema.ts` — `attestations` table (you're extending this)
2. `apps/auth/app/api/attestations/` — check if attestation endpoints exist already
3. `packages/dfos/src/bridge.ts` — `signIdentityOperation` for JWS creation pattern
4. `packages/cid/src/index.ts` — `computeCid()` (from #400, must be merged first)
5. `packages/auth/src/crypto.ts` — `sign()`, `verify()` functions
6. `apps/auth/lib/middleware.ts` — `requireAssertKey()` from #401
7. DFOS countersignature protocol: check `@metalabel/dfos-protocol` for `signCountersignature`, `verifyCountersignature`

---

## Step 1: Understand DFOS Countersignatures

**Read these first:**

```bash
# Find countersignature functions
grep -n "countersign\|Countersign" node_modules/.pnpm/@metalabel+dfos-protocol@*/node_modules/@metalabel/dfos-protocol/dist/*.js | head -20
```

DFOS countersignatures work like this:
- Author signs a payload → produces JWS with `kid = {authorDID}#{keyId}`
- Witness countersigns the same payload → produces JWS with `kid = {witnessDID}#{keyId}`
- The `kid` DID in the countersignature MUST differ from the content's DID
- Both JWS tokens reference the same canonical CID

**Use DFOS's `signCountersignature` if possible.** If it doesn't fit our attestation shape, build our own JWS creation following the same pattern (EdDSA + kid header).

---

## Step 2: Schema Changes

### Migration: `apps/auth/drizzle/0006_countersignatures.sql`

```sql
-- Add countersignature fields to attestations
ALTER TABLE auth.attestations
  ADD COLUMN IF NOT EXISTS author_jws TEXT,
  ADD COLUMN IF NOT EXISTS witness_jws TEXT,
  ADD COLUMN IF NOT EXISTS attestation_status TEXT DEFAULT 'pending';

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_auth_attestations_status
  ON auth.attestations (attestation_status);
```

**⚠️ Note:** The `cid` column should already exist from #400. If #400 isn't merged yet, add it here:
```sql
ALTER TABLE auth.attestations ADD COLUMN IF NOT EXISTS cid TEXT;
```

### Update `apps/auth/src/db/schema.ts`

Add to the `attestations` table:

```typescript
authorJws: text('author_jws'),        // JWS compact token (author signature)
witnessJws: text('witness_jws'),       // JWS compact token (countersignature)
attestationStatus: text('attestation_status').default('pending'), // 'pending' | 'bilateral' | 'declined'
```

Update journal with `0006_countersignatures` entry.

---

## Step 3: JWS Signing Utility

### Add to `packages/dfos/src/attestation.ts` (new file)

```typescript
import { createJws } from '@metalabel/dfos-protocol';
import { createSigner } from './signer';
import { computeCid } from '@imajin/cid';

/**
 * Sign an attestation payload, producing a JWS token.
 *
 * @param payload — the attestation content (will be CID'd)
 * @param privateKeyHex — signer's Ed25519 private key
 * @param did — signer's DID (for kid header)
 * @param keyId — signer's key identifier
 * @returns JWS compact serialization string + CID
 */
export async function signAttestation(input: {
  payload: Record<string, unknown>;
  privateKeyHex: string;
  did: string;
  keyId: string;
}): Promise<{ jws: string; cid: string }> {
  const cid = await computeCid(input.payload);
  const signer = createSigner(input.privateKeyHex);
  const kid = `${input.did}#${input.keyId}`;

  const jws = await createJws({
    header: { alg: 'EdDSA', typ: 'imajin:attestation', kid, cid },
    payload: input.payload,
    sign: signer,
  });

  return { jws, cid };
}

/**
 * Sign a countersignature over the same CID.
 * The witness DID MUST differ from the author DID.
 */
export async function countersignAttestation(input: {
  payload: Record<string, unknown>;
  expectedCid: string;
  privateKeyHex: string;
  did: string;
  keyId: string;
}): Promise<{ jws: string }> {
  // Verify CID matches
  const computedCid = await computeCid(input.payload);
  if (computedCid !== input.expectedCid) {
    throw new Error(`CID mismatch: expected ${input.expectedCid}, got ${computedCid}`);
  }

  const signer = createSigner(input.privateKeyHex);
  const kid = `${input.did}#${input.keyId}`;

  const jws = await createJws({
    header: { alg: 'EdDSA', typ: 'imajin:countersign', kid, cid: input.expectedCid },
    payload: input.payload,
    sign: signer,
  });

  return { jws };
}
```

**⚠️ Check `createJws` signature carefully.** It's exported from `@metalabel/dfos-protocol`. Read the actual function to understand what it accepts:

```bash
grep -A 10 "createJws" node_modules/.pnpm/@metalabel+dfos-protocol@*/node_modules/@metalabel/dfos-protocol/dist/*.js | head -20
```

If `createJws` doesn't accept arbitrary `typ` values or custom `cid` header fields, you may need to build the JWS manually using `jose` (already in auth's deps). Follow the same pattern: EdDSA + kid + compact serialization.

Export the new functions from `packages/dfos/src/index.ts`.

---

## Step 4: Create Attestation Endpoint

### `apps/auth/app/api/attestations/route.ts`

**POST — Create attestation**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { requireAuth } from '@/lib/middleware';
import { computeCid, verifyCid } from '@imajin/cid';
import { randomUUID } from 'crypto';

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);
  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const body = await request.json();
  const { subjectDid, type, contextId, contextType, payload, authorJws } = body;

  // Validate required fields
  if (!subjectDid || !type || !authorJws) {
    return NextResponse.json(
      { error: 'Missing required fields: subjectDid, type, authorJws' },
      { status: 400, headers: cors }
    );
  }

  // Author must be the authenticated user
  if (session.sub === subjectDid) {
    return NextResponse.json(
      { error: 'Cannot attest to yourself — author and subject must differ' },
      { status: 400, headers: cors }
    );
  }

  // Compute CID over the attestation payload
  const attestationPayload = {
    issuerDid: session.sub,
    subjectDid,
    type,
    contextId: contextId || null,
    contextType: contextType || null,
    payload: payload || null,
    issuedAt: new Date().toISOString(),
  };
  const cid = await computeCid(attestationPayload);

  // TODO: Verify authorJws signature + CID match
  // For now, store the JWS and mark as pending

  const id = `att_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  await db.insert(attestations).values({
    id,
    issuerDid: session.sub,
    subjectDid,
    type,
    contextId: contextId || null,
    contextType: contextType || null,
    payload: payload || null,
    signature: '', // Legacy field — empty for new-style attestations
    cid,
    authorJws,
    attestationStatus: 'pending',
  });

  return NextResponse.json({
    id,
    cid,
    status: 'pending',
    message: 'Attestation created. Awaiting witness countersignature.',
  }, { status: 201, headers: cors });
}
```

**GET — List attestations (extend if exists)**

Add `?status=pending|bilateral|declined` and `?did=` filters.

---

## Step 5: Countersign Endpoint

### `apps/auth/app/api/attestations/[id]/countersign/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/middleware';
import { verifyCid } from '@imajin/cid';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const { id } = await params;
  const body = await request.json();
  const { witnessJws } = body;

  if (!witnessJws) {
    return NextResponse.json({ error: 'Missing witnessJws' }, { status: 400, headers: cors });
  }

  // Load attestation
  const [att] = await db.select().from(attestations).where(eq(attestations.id, id)).limit(1);

  if (!att) {
    return NextResponse.json({ error: 'Attestation not found' }, { status: 404, headers: cors });
  }

  if (att.attestationStatus !== 'pending') {
    return NextResponse.json(
      { error: `Cannot countersign — attestation is ${att.attestationStatus}` },
      { status: 409, headers: cors }
    );
  }

  // Witness must be the subject
  if (session.sub !== att.subjectDid) {
    return NextResponse.json(
      { error: 'Only the attestation subject can countersign' },
      { status: 403, headers: cors }
    );
  }

  // TODO: Verify witnessJws signature matches subject's chain key
  // TODO: Verify witnessJws CID matches attestation CID

  await db.update(attestations)
    .set({
      witnessJws,
      attestationStatus: 'bilateral',
    })
    .where(eq(attestations.id, id));

  return NextResponse.json({
    id,
    status: 'bilateral',
    message: 'Countersignature accepted. Attestation is now bilateral.',
  }, { headers: cors });
}
```

---

## Step 6: Decline Endpoint

### `apps/auth/app/api/attestations/[id]/decline/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth } from '@/lib/middleware';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  const session = await requireAuth(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const { id } = await params;

  const [att] = await db.select().from(attestations).where(eq(attestations.id, id)).limit(1);
  if (!att) {
    return NextResponse.json({ error: 'Attestation not found' }, { status: 404, headers: cors });
  }

  if (att.attestationStatus !== 'pending') {
    return NextResponse.json(
      { error: `Cannot decline — attestation is ${att.attestationStatus}` },
      { status: 409, headers: cors }
    );
  }

  if (session.sub !== att.subjectDid) {
    return NextResponse.json(
      { error: 'Only the attestation subject can decline' },
      { status: 403, headers: cors }
    );
  }

  await db.update(attestations)
    .set({ attestationStatus: 'declined' })
    .where(eq(attestations.id, id));

  return NextResponse.json({
    id,
    status: 'declined',
  }, { headers: cors });
}
```

---

## Step 7: Tests

### `packages/dfos/tests/attestation.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { computeCid, verifyCid } from '@imajin/cid';

describe('attestation CID', () => {
  it('produces deterministic CID for attestation payload', async () => {
    const payload = {
      issuerDid: 'did:imajin:alice',
      subjectDid: 'did:imajin:bob',
      type: 'attendance',
      contextId: 'did:imajin:event-123',
      contextType: 'event',
      payload: { role: 'attendee' },
      issuedAt: '2026-03-21T00:00:00.000Z',
    };
    const cid1 = await computeCid(payload);
    const cid2 = await computeCid(payload);
    expect(cid1).toBe(cid2);
  });

  it('CID changes if payload is tampered', async () => {
    const payload = {
      issuerDid: 'did:imajin:alice',
      subjectDid: 'did:imajin:bob',
      type: 'attendance',
    };
    const cid = await computeCid(payload);
    const tampered = { ...payload, type: 'fraud' };
    expect(await verifyCid(tampered, cid)).toBe(false);
  });
});
```

**⚠️ Full JWS signing/verification tests** depend on how `createJws` works from dfos-protocol. Write these after getting the signing utility working in Step 3. Test:
- Author signs → JWS is valid
- Witness countersigns same CID → both JWS verify
- Witness countersigns wrong CID → rejection
- Author and witness are the same DID → rejection

---

## Step 8: Build + Test

```bash
pnpm test
cd apps/auth && npx next build
```

---

## Step 9: Commit + PR

```bash
git add -A
git commit -m "feat(auth): countersignature-based attestations (#402)

- POST /api/attestations — create with author JWS + CID
- POST /api/attestations/:id/countersign — bilateral proof
- POST /api/attestations/:id/decline — explicit rejection
- author_jws, witness_jws, attestation_status columns
- Signing utilities in @imajin/dfos
- Old attestations (no JWS) continue to work

Closes #402"
```

---

## What NOT To Do

- **Don't migrate old attestations** to JWS format — they used JSON canonicalization, not dag-cbor. Let them age out naturally.
- **Don't add countersignature UI** — this is API only. Client flows are separate.
- **Don't wire countersignatures into events/connections/learn yet** — those services adopt the new attestation model in their own issues (P25 Phase 2).
- **Don't implement real JWS verification on the server yet if it's complex** — mark with TODO, get the schema + endpoints working, add crypto verification as a fast follow. The portable verification (client-side with DFOS libs) is the more important path.
- **Don't remove the legacy `signature` column** — old attestations use it.

## Success Criteria

```
✓ POST /api/attestations — creates attestation with CID + author JWS
✓ POST /api/attestations/:id/countersign — stores witness JWS, status → bilateral
✓ POST /api/attestations/:id/decline — status → declined
✓ Status filtering on GET works
✓ Author ≠ subject enforced
✓ Only subject can countersign/decline
✓ Old attestations (no JWS) still work
✓ CID is deterministic and verifiable
✓ Tests pass
✓ Build passes
✓ PR created against main
```
