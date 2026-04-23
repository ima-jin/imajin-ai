## BUG-23 — Event Private Keys Returned in API Response ✅ RESOLVED 2026-04-08

**Resolved:** The group/event identity creation endpoint at `apps/kernel/app/auth/api/groups/route.ts` now encrypts the private key client-side (PBKDF2 + AES-256-GCM) before persistence and returns only `{ did, scope, handle, name }` to the client. The encrypted blob lives in `auth.stored_keys.encrypted_key`. No decrypted key material flows through any HTTP response. The schema also enforces this: `auth.stored_keys.encrypted_key` is the only key column and it stores ciphertext (`apps/kernel/src/db/schemas/auth.ts:144–155`).

**File:** `apps/kernel/app/auth/api/groups/route.ts`, `apps/kernel/src/db/schemas/auth.ts`
**Severity:** HIGH — key material exposure
**Detected:** April 7, 2026
**Resolved:** confirmed in April 8 audit (kernel merge era)

### The Problem

Earlier event/group DID endpoints returned private key material in API response bodies. While `auth.stored_keys` stored encrypted keys, the decrypted key appeared in HTTP responses, exposable via browser devtools, logging middleware, or CDN caching.

### How it was Resolved

1. The kernel-era group create endpoint generates the keypair, encrypts the private key with `encryptPrivateKey()` (PBKDF2 → AES-GCM), stores the ciphertext + salt in `auth.stored_keys`, and returns only the DID + identity metadata.
2. Encryption uses `GROUP_KEY_ENCRYPTION_SECRET` server-side. There is no decryption path — no endpoint returns the plaintext key.
3. The `stored_keys` schema column is named `encryptedKey: text('encrypted_key').notNull()` — there is no plaintext column to leak.

### Caveat — separate, smaller problem

A follow-up issue remains: there is no signing endpoint either, so group keys are currently "dead keys" — encrypted and stored but never used. This is tracked separately as **Proposal P33 (Group Key Sovereignty)**, not as a regression of BUG-23. The original problem (key exposure) is fully resolved.

### Detection Confirmed

- `apps/kernel/app/auth/api/groups/route.ts` POST returns `{ did, scope, handle, name }` only
- No grep matches for plaintext private key in any API response body across the kernel
- `encryptPrivateKey()` invoked before persistence
