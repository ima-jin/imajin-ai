# Work Order: #401 — Key Rotation + Multi-Device Auth

**Epic:** #395 (DFOS DID Bridge)  
**Issue:** #401  
**Scope:** Key rotation endpoint, role separation, multi-device auth, session token changes.  
**Branch:** `feat/401-key-rotation`  
**Depends on:** PR #407 merged + #398 + #403

---

## What You're Building

The infrastructure for multi-device login and key rotation:

1. **Schema changes** — `key_roles` on identities, `key_id`/`key_role` on tokens
2. **`POST /api/identity/:did/rotate`** — rotate keys via signed chain update
3. **`POST /api/identity/:did/keys`** — add/remove keys per role (device enrollment)
4. **`GET /api/identity/:did/keys`** — current key state
5. **Session token updates** — tokens carry which key created them
6. **`requireAssertKey()` / `requireControllerKey()`** — role-aware middleware

This is the meatiest work order. Read the full issue #401 before starting.

---

## Step 0: Setup

```bash
cd ~/workspace/imajin-ai
git checkout main && git pull
git checkout -b feat/401-key-rotation
```

## Files to Read First

1. `apps/auth/lib/middleware.ts` — current middleware (extended by #403)
2. `apps/auth/lib/jwt.ts` — session token creation + verification
3. `apps/auth/lib/dfos.ts` — chain verification + storage
4. `apps/auth/app/api/register/route.ts` — registration flow (creates genesis chain)
5. `apps/auth/app/api/login/verify/route.ts` — login flow (bridges chain on login)
6. `apps/auth/src/schema.ts` — Drizzle schema (identities, tokens, etc.)
7. `packages/dfos/src/bridge.ts` — `createIdentityChain`, `verifyChain`
8. `packages/auth/src/crypto.ts` — key generation, signing, verification

---

## Step 1: Schema Changes

### Migration: `apps/auth/drizzle/0004_*.sql`

Generate via Drizzle or write manually:

```sql
-- Add key roles to identities
ALTER TABLE auth.identities
  ADD COLUMN IF NOT EXISTS key_roles JSONB;

-- Add key tracking to tokens  
ALTER TABLE auth.tokens
  ADD COLUMN IF NOT EXISTS key_id TEXT,
  ADD COLUMN IF NOT EXISTS key_role TEXT;
```

**⚠️ How to generate:** Check how the existing migrations were created. If using `drizzle-kit generate`, update the schema file first and run the generator. If manual, write the SQL directly. Match the existing pattern in `apps/auth/drizzle/`.

### Schema update: `apps/auth/src/schema.ts`

Add the new columns to the Drizzle table definitions:

```typescript
// On identities table:
keyRoles: jsonb('key_roles'), // { auth: [multikey...], assert: [multikey...], controller: [multikey...] }

// On tokens table:
keyId: text('key_id'),
keyRole: text('key_role'), // 'auth' | 'assert' | 'controller'
```

**⚠️ Find the exact file.** It might be `src/schema.ts`, `src/db.ts`, or `src/db/schema.ts`. Search for the existing `identities` table definition.

### Backward Compatibility

When `key_roles` is NULL, the single `public_key` field is treated as all three roles. **Every existing flow must work unchanged when key_roles is null.** Test this explicitly.

---

## Step 2: Update Session Token

### `apps/auth/lib/jwt.ts`

Extend `SessionPayload` type:

```typescript
interface SessionPayload {
  did: string;
  tier: 'soft' | 'hard';
  // NEW:
  keyId?: string;    // which key created this session
  keyRole?: string;  // 'auth' | 'assert' | 'controller'
}
```

Update `createSessionToken` to accept and encode `keyId` + `keyRole`.

**⚠️ Backward compat:** Existing tokens without these fields must still work. The middleware should treat missing `keyId`/`keyRole` as "legacy token, single-key identity, all roles."

---

## Step 3: DFOS Chain Update Function

### `packages/dfos/src/bridge.ts` — add `updateIdentityChain`

```typescript
/**
 * Create a DFOS identity chain UPDATE operation.
 * Used for key rotation and role separation.
 * Must be signed by a current controller key.
 */
export async function updateIdentityChain(input: {
  privateKeyHex: string;  // controller key signing the update
  publicKeyHex: string;   // controller key's public key
  existingLog: string[];  // current chain log
  newKeys: {
    authKeys: Array<{ publicKeyHex: string }>;
    assertKeys: Array<{ publicKeyHex: string }>;
    controllerKeys: Array<{ publicKeyHex: string }>;
  };
}): Promise<{
  log: string[];           // updated chain log (existing + new entry)
  operationCID: string;
}> {
  // 1. Verify existing chain to get current state
  // 2. Build update operation with new key configuration
  // 3. Sign with controller key
  // 4. Return extended log
}
```

**⚠️ CRITICAL:** Read the DFOS protocol source to understand update operations. The key functions:
- Check `@metalabel/dfos-protocol` for `signIdentityOperation` with `type: 'update'`
- The update operation needs `previousOperationCID` pointing to the chain head
- The `kid` in the JWS header must reference the current controller key

**This is the hardest part of the work order.** The DFOS protocol's update operation format may differ from create. Read their test files for examples:
```bash
find node_modules/@metalabel/dfos-protocol -name "*.test.*" | head -10
# Or check the cloned repo at ~/workspace/dfos/
```

---

## Step 4: Rotation Endpoint — `POST /api/identity/:did/rotate`

**Create:** `apps/auth/app/api/identity/[did]/rotate/route.ts`

This endpoint receives a signed chain update from the client and processes the rotation.

**Flow:**
1. Parse request: signed JWS chain update + new public key(s)
2. Load existing chain from `identity_chains`
3. Verify the update is signed by a current controller key
4. Append update to chain log
5. Update `identities.public_key` to new primary key
6. Update `identities.key_roles` with new role configuration
7. Invalidate all existing tokens for this DID
8. Update `identity_chains` row (new log, new head CID, updated key count)
9. Return success

**Security:**
- Require valid session (controller key session preferred, but at minimum any authenticated session for this DID)
- Rate limit: max 1 rotation per hour per DID (check `identity_chains.updated_at`)
- Send notification email if email credential exists

**⚠️ Email notification:** Find how other auth endpoints send email. Likely uses `@imajin/email` or SendGrid directly. Match the pattern.

```typescript
// Rate limiting check
const chain = await getChainByImajinDid(did);
if (chain) {
  const lastUpdate = new Date(chain.updatedAt);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (lastUpdate > hourAgo) {
    return NextResponse.json(
      { error: 'Key rotation rate limit: max 1 per hour' },
      { status: 429, headers: cors }
    );
  }
}
```

---

## Step 5: Key Management Endpoint — `POST /api/identity/:did/keys`

**Create:** `apps/auth/app/api/identity/[did]/keys/route.ts`

For adding/removing keys from specific roles (multi-device enrollment).

**Request body:**
```json
{
  "chainUpdate": "eyJhbGci...",
  "action": "add",
  "role": "auth",
  "publicKey": "z6Mk..."
}
```

**This is how "add this device" works:**
1. New device generates a keypair
2. User authenticates on new device (magic link or QR from existing device)
3. Existing device (with controller key) signs a chain update adding the new key to `authKeys`
4. Server verifies and stores

**⚠️ The client-side flow is complex and NOT in this work order.** This endpoint is the server half. The client UI for multi-device enrollment is a separate issue. For now, the endpoint exists and works if called correctly.

---

## Step 6: Key State Endpoint — `GET /api/identity/:did/keys`

**Create:** `apps/auth/app/api/identity/[did]/keys/route.ts` (GET handler alongside POST)

```typescript
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const cors = corsHeaders(request);
  const { did } = await params;
  const decodedDid = decodeURIComponent(did);

  // Require auth — you can only see your own keys
  const session = await requireAuth(request);
  if (!session || session.did !== decodedDid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  const chain = await getChainByImajinDid(decodedDid);
  if (!chain) {
    // No chain — return single-key state
    const [identity] = await db
      .select({ publicKey: identities.publicKey })
      .from(identities)
      .where(eq(identities.id, decodedDid))
      .limit(1);

    return NextResponse.json({
      did: decodedDid,
      singleKey: true,
      keyCount: 1,
      roles: null,
      message: 'Single keypair in all roles (default)',
    }, { headers: cors });
  }

  const verified = await verifyChain(chain.log as string[]);

  return NextResponse.json({
    did: decodedDid,
    dfosDid: chain.dfosDid,
    singleKey: false,
    chainLength: (chain.log as string[]).length,
    authKeys: verified.authKeys,
    assertKeys: verified.assertKeys,
    controllerKeys: verified.controllerKeys,
    lastRotated: chain.updatedAt,
  }, { headers: cors });
}
```

---

## Step 7: Role-Aware Middleware

### `apps/auth/lib/middleware.ts`

Add convenience middleware functions:

```typescript
/**
 * Require an assert key session (signing content, attestations, .fair)
 */
export async function requireAssertKey(request: NextRequest): Promise<SessionPayload | null> {
  const session = await requireAuth(request);
  if (!session) return null;

  // Legacy tokens (no key role) — single key does everything
  if (!session.keyRole) return session;

  if (session.keyRole !== 'assert' && session.keyRole !== 'controller') {
    return null; // auth-only key can't sign content
  }
  return session;
}

/**
 * Require a controller key session (rotation, deletion, fund transfers)
 */
export async function requireControllerKey(request: NextRequest): Promise<SessionPayload | null> {
  const session = await requireAuth(request);
  if (!session) return null;

  // Legacy tokens (no key role) — single key does everything
  if (!session.keyRole) return session;

  if (session.keyRole !== 'controller') {
    return null;
  }
  return session;
}
```

**⚠️ Don't add these to any existing endpoints yet.** The rotation endpoint (#Step 4) should use `requireControllerKey`. Everything else stays on `requireAuth`. Migrating existing endpoints to role-aware auth is future work.

---

## Step 8: Session Invalidation on Rotation

When keys rotate, all existing sessions created by the old key must die.

In the rotation endpoint (Step 4), after updating the chain:

```typescript
// Invalidate all tokens for this DID
await db.delete(tokens).where(eq(tokens.did, did));
```

**⚠️ Check the tokens table structure.** The column might be `did`, `identity_id`, `user_id`, etc. Match the actual schema.

For targeted invalidation (future, when tokens carry `key_id`):
```typescript
// Invalidate only tokens created by the compromised key
await db.delete(tokens).where(
  and(eq(tokens.did, did), eq(tokens.keyId, compromisedKeyId))
);
```

---

## Step 9: Tests

Add to `packages/dfos/tests/rotation.test.ts`:

```typescript
describe('key rotation', () => {
  it('creates a valid update operation', async () => {
    // Generate keypair, create chain, rotate to new key, verify chain still valid
  });

  it('new key is recognized after rotation', async () => {
    // After rotation, verify chain shows new key in controller role
  });

  it('old key cannot sign after rotation', async () => {
    // After rotation, old key is no longer in any role
  });
});

describe('role separation', () => {
  it('adds a second auth key', async () => {
    // Genesis with K1 in all roles
    // Update: authKeys=[K1, K2], assertKeys=[K1], controllerKeys=[K1]
    // Verify chain shows 2 auth keys, 1 each for assert/controller
  });
});
```

**⚠️ These tests depend on getting the DFOS update operation working (Step 3).** If the update API is unclear, write the tests first as a specification, then implement to pass them.

---

## Step 10: Build + Test

```bash
# Run package tests
pnpm test

# Build auth
cd apps/auth && npx next build
```

---

## Step 11: Commit + PR

```bash
git add -A
git commit -m "feat(auth): key rotation + multi-device auth (#401)

- POST /api/identity/:did/rotate — full key rotation via chain update
- POST /api/identity/:did/keys — add/remove keys per role
- GET /api/identity/:did/keys — current key state
- key_roles column on identities, key_id/key_role on tokens
- requireAssertKey() + requireControllerKey() middleware
- Session invalidation on rotation
- Rate limit: 1 rotation/hour/DID
- Backward compat: null key_roles = single key in all roles

Closes #401"
git push origin feat/401-key-rotation
gh pr create --title "feat(auth): key rotation + multi-device auth (#401)" \
  --body "Closes #401. Key rotation, role separation, and multi-device auth infrastructure.

## What's new
- Key rotation via DFOS chain update operations
- Multi-device enrollment (add auth keys to specific roles)
- Role-aware middleware (requireAssertKey, requireControllerKey)
- Session tokens track which key created them
- Rate limiting + email notification on rotation

## Backward compat
All existing single-key identities work unchanged. \`key_roles: null\` = single key in all roles."
```

---

## What NOT To Do

- **Don't build the client-side multi-device UI.** This is server infrastructure only. The "Add Device" wizard is a separate issue.
- **Don't migrate existing endpoints to role-aware auth.** Only the rotation endpoint uses `requireControllerKey`. Everything else stays on `requireAuth`.
- **Don't implement M-of-N recovery (#257).** Controller key loss = locked out. That's accepted.
- **Don't modify registration flow.** Genesis chains already create single-key-all-roles. That's correct.
- **Don't add key role separation to the registration UI.** Users start with one key. Separation is opt-in later.

## Hardest Part

**Step 3 — the DFOS update operation.** The create operation is well-documented. The update operation may be less obvious. Read DFOS protocol source carefully:

```bash
# Check for update operation handling
grep -r "update" ~/workspace/dfos/packages/dfos-protocol/src/ --include="*.ts" -l
grep -r "previousOperationCID" ~/workspace/dfos/packages/dfos-protocol/src/ --include="*.ts"
```

If the DFOS protocol doesn't support update operations yet (check their changelog/issues), this work order is blocked. In that case: implement rotation at the Imajin layer only (DB-based key swap + token invalidation) without chain updates, and add chain rotation when DFOS supports it.

## Success Criteria

```
✓ POST /api/identity/:did/rotate — rotates keys, invalidates sessions, updates chain
✓ POST /api/identity/:did/keys — adds/removes keys per role
✓ GET /api/identity/:did/keys — shows current key state
✓ requireAssertKey() and requireControllerKey() work
✓ Legacy tokens (no keyRole) treated as all-roles — no regressions
✓ Rate limit enforced (1/hour)
✓ Tests pass for rotation + role separation
✓ Build passes
✓ PR created against main
```
