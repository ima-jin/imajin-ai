# Work Order: DFOS DID Bridge — Chain-Backed Identity for Imajin

**Epic:** #395  
**Date:** March 20, 2026  
**Status:** Ready to build

---

## What We're Building

Rebuild Imajin's auth foundation on DFOS identity chain primitives. Every `did:imajin` identity gets a cryptographic proof chain underneath it — self-certifying, rotatable, with multifactor key roles and bilateral attestations. Nothing existing breaks. This is additive.

## Why

`did:imajin:xxx` is currently a database row. It means nothing without our auth server. After this work, any Imajin DID can be verified by anyone with the chain and a hash function. No server, no trust assumption, no phone home.

This is also the DFOS integration foundation (Discussion #393). Same Ed25519 curve, byte-compatible keys. One keypair, two DIDs.

---

## Context

### The Codebase

- **Monorepo:** `imajin-ai/` — pnpm workspaces, Next.js apps, shared packages
- **Auth app:** `apps/auth/` — registration, login, challenges, sessions, attestations, magic links
- **Auth package:** `packages/auth/` — `@imajin/auth` (crypto, signing, verification, types, middleware)
- **Database:** Postgres on 192.168.1.193, schema `auth.*` (Drizzle ORM)

### Current Auth Model

- **Keys:** Ed25519 via `@noble/ed25519`, stored as 64-char hex strings
- **DIDs:** `did:imajin:{base58(publicKey)}` for hard DIDs, `did:imajin:{nanoid}` for soft DIDs
- **Signing:** `SignedMessage<T>` with JSON canonicalization + Ed25519 signature
- **Sessions:** JWT tokens in cookies, validated against DB
- **Tiers:** soft (email-only) → preliminary (keypair) → established (future)
- **No key rotation, no key roles, no chain structure, no content addressing**

### Current Database (dev)

| Tier | Type | Count | Real Ed25519 Key? |
|------|------|-------|-------------------|
| hard | human | 1 | ✅ |
| preliminary | human | 5 | ✅ |
| preliminary | event | 2 | ✅ |
| preliminary | service | 1 | ✅ |
| soft | human | 7 | ❌ (soft_* placeholder) |

**9 identities with real keys get DFOS chains. 7 soft DIDs are skipped.**

FK references to `auth.identities` are only from `auth.challenges` and `auth.tokens` — both internal to auth. No cross-schema foreign keys.

### DFOS Protocol

- **Package:** `@metalabel/dfos-protocol` (MIT, npm published, ~1,700 lines)
- **Deps:** `@noble/curves`, `@ipld/dag-cbor` (lightweight)
- **Repo cloned:** `~/workspace/dfos/` — read `packages/dfos-protocol/src/` for implementation
- **Key files:**
  - `src/crypto/ed25519.ts` — keypair generation, sign, verify
  - `src/chain/identity-chain.ts` — create/verify identity chains
  - `src/chain/content-chain.ts` — create/verify content chains
  - `src/chain/countersign.ts` — witness countersignatures
  - `src/chain/schemas.ts` — Zod schemas (IdentityOperation, ContentOperation, etc.)
  - `src/chain/derivation.ts` — DID derivation from CID bytes
  - `src/chain/multikey.ts` — Multikey encoding/decoding
  - `src/crypto/id.ts` — 22-char ID generation (custom alphabet: `2346789acdefhknrtvz`)
- **Key types:**
  - `Signer = (message: Uint8Array) => Promise<Uint8Array>`
  - `MultikeyPublicKey = { id, type: "Multikey", publicKeyMultibase }`
  - Identity operations: `create`, `update`, `delete` (append-only chain)
  - Three key roles: `authKeys`, `assertKeys`, `controllerKeys` (up to 16 each)
- **Encoding:** dag-cbor canonical → SHA-256 → CIDv1. Multikey = `z` + base58btc(`0xed01` + 32 pubkey bytes)
- **Node version:** Their tests require Node 24, but the published npm package works on Node 22

---

## Build Order

### Phase 1: Foundation (parallel, no dependencies between these)

#### #399 — Key format utilities in `@imajin/auth`

Add to `packages/auth/src/crypto.ts`:

```typescript
bytesToMultibase(publicKey: Uint8Array): string    // z + base58btc(0xed01 + key)
multibaseToPubkey(multibase: string): Uint8Array   // validates 0xed01 header
hexToMultibase(publicKeyHex: string): string
multibaseToHex(multibase: string): string
```

`bs58` is already a dependency in `apps/auth/lib/crypto.ts` — may need to add to `packages/auth`.

#### #396 — `@imajin/dfos` shared package

Create `packages/dfos/`:

```
packages/dfos/
├── src/
│   ├── index.ts          # public API exports
│   ├── bridge.ts         # createIdentityChain(), key conversion wrappers
│   ├── signer.ts         # createSigner(hexPrivateKey) → DFOS Signer type
│   ├── resolve.ts        # getDfosDid(), getImajinDid() — DB queries
│   └── types.ts          # re-exports from @metalabel/dfos-protocol
├── package.json          # deps: @metalabel/dfos-protocol, @imajin/auth, @imajin/db
└── tsconfig.json
```

Key function — `createIdentityChain()`:
1. Take Imajin hex private key + public key
2. Convert public key to Multikey format via `hexToMultibase()`
3. Build genesis operation: `{ version: 1, type: "create", authKeys: [mk], assertKeys: [mk], controllerKeys: [mk], createdAt: ISO }`
4. Create signer from hex private key
5. Call `signIdentityOperation()` from dfos-protocol
6. Return `{ did: "did:dfos:xxx", log: [jwsToken], operationCID }`

**Critical:** Same keypair must ALWAYS produce same `did:dfos`. The DID is derived from the genesis CID, which is derived from the payload content. As long as `createdAt` is fixed for a given keypair, it's deterministic. **Decision needed:** use a deterministic timestamp (e.g., identity's `created_at` from DB) or accept that the DFOS DID is generated once and stored.

**Recommendation:** Generate once at bridge time, store the result. Don't try to make it re-derivable — the `createdAt` timestamp makes pure determinism fragile. The stored chain IS the identity.

#### #404 — Verification test suite

Setup Vitest at workspace root. Write tests alongside #399 and #396. See issue for full test list (~50 cases across 9 sections). Key principle: every test asks "does our code produce artifacts that DFOS protocol's own verification functions accept?"

### Phase 2: Storage + Migration (depends on Phase 1)

#### #397 — Schema + migration

**New table** in `apps/auth/src/db/schema.ts`:

```typescript
export const identityChains = authSchema.table('identity_chains', {
  did: text('did').primaryKey().references(() => identities.id),
  dfosDid: text('dfos_did').notNull().unique(),
  log: jsonb('log').notNull(),           // JWS token array
  headCid: text('head_cid').notNull(),
  keyCount: integer('key_count').notNull().default(1),
  isDeleted: boolean('is_deleted').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
```

**Migration script:** `scripts/migrate-dfos-chains.ts`
- For each identity where `public_key` is valid 64-char hex (not `soft_*`)
- Create DFOS chain via `@imajin/dfos`
- Insert into `auth.identity_chains`
- Insert credential: `(did, 'dfos', dfosDid)` into `auth.credentials`
- `--dry-run` flag, idempotent, transaction-wrapped per identity

**Registration hook:** Update `apps/auth/app/api/register/route.ts` — after creating identity, create DFOS chain. New identities get chains from birth.

### Phase 3: Auth Rebuild (depends on Phase 2, items parallelizable)

#### #398 — Resolution endpoints

- `GET /api/identity/:did/chain` — serve DFOS chain log
- `GET /api/resolve/dfos/:dfosDid` — resolve to Imajin identity
- Extend existing `GET /api/identity/:did` with `dfosDid` field

#### #401 — Key rotation + multifactor key roles

**Endpoints:**
- `POST /api/identity/:did/rotate` — full rotation (controller key signs chain update)
- `POST /api/identity/:did/keys` — role separation (add/remove keys per role)
- `GET /api/identity/:did/keys` — current key state

**Schema extensions:**
- `auth.identities`: add `key_roles JSONB` (nullable — null = single key in all roles)
- `auth.tokens`: add `key_id TEXT`, `key_role TEXT` (which key created this session)

**Operation → key role mapping:**
- Browse/chat/read → authKey
- Sign content/attestations/tips → assertKey
- Rotate keys/delete identity/transfers → controllerKey

Rate limit rotations (1/hour/DID). Notify via email on rotation.

#### #402 — Countersignature attestations

Rework `auth.attestations`:
- Add columns: `cid TEXT`, `author_jws TEXT`, `witness_jws TEXT`, `attestation_status TEXT`
- Lifecycle: author signs → pending → witness countersigns → bilateral (or declined)
- Old attestations (no JWS) coexist — don't migrate, different format
- `POST /api/attestations/:id/countersign` + `POST /api/attestations/:id/decline`

#### #403 — Chain-aware auth middleware

- Extend `requireAuth()` with `verifyChain` and `requiredKeyRole` options
- Add `requireAssertKey()`, `requireControllerKey()` convenience middleware
- Backward compat: null `key_roles` = single key treated as all roles
- Background consistency check: chain key state vs DB public_key
- `GET /api/identity/:did/verify` — public chain verification endpoint

### Parallel Track

#### #400 — dag-cbor content addressing

Separate from the auth rebuild. Adopt `dagCborCanonicalEncode()` → CIDv1 for content addressing. Incremental rollout: add CID columns to tables one at a time. Start with `auth.attestations`, then chat messages, tickets, etc.

---

## Key Decisions (Pre-Made)

1. **Option B (derivation)** — same keypair, two DIDs. Not linked pair.
2. **Generate once, store** — DFOS chain created once at bridge time, not re-derived.
3. **Published package** — use `@metalabel/dfos-protocol` from npm, don't fork.
4. **Additive** — nothing existing changes. New tables, new columns (nullable), new endpoints.
5. **Backward compat everywhere** — null `key_roles` = old behavior. Null `author_jws` = old attestation format.
6. **Tests first** — write verification tests alongside the code, not after.

## Key Decisions (Needed During Build)

1. **Timestamp for genesis** — use identity's `created_at` from DB? Or current time? (Recommendation: current time, store result.)
2. **Key ID format** — DFOS uses `key_xxx` IDs. Match their format or use our own? (Recommendation: match theirs — `key_` prefix + their ID generation.)
3. **bs58 dependency** — currently in `apps/auth` but not `packages/auth`. Move or add?

---

## What NOT To Do

- Don't edit code on the server. Edit locally, commit, push.
- Don't touch soft DIDs — they have no real keys.
- Don't migrate old attestations to countersignature format — they use different canonicalization.
- Don't test DFOS protocol internals — that's their job (149 tests, 5 languages).
- Don't build UI for key separation — backend only for now.
- Don't deploy without Ryan's go-ahead — ask "ready to build?" and wait.

---

## Files to Read Before Starting

1. `packages/auth/src/crypto.ts` — current Imajin crypto primitives
2. `packages/auth/src/sign.ts` — SignedMessage creation + canonicalize()
3. `packages/auth/src/verify.ts` — signature verification
4. `packages/auth/src/types.ts` — Identity, SignedMessage, Keypair types
5. `apps/auth/src/db/schema.ts` — current auth schema (Drizzle)
6. `apps/auth/app/api/register/route.ts` — registration flow
7. `apps/auth/lib/crypto.ts` — didFromPublicKey(), verifySignature()
8. `~/workspace/dfos/packages/dfos-protocol/src/chain/identity-chain.ts` — chain create/verify
9. `~/workspace/dfos/packages/dfos-protocol/src/chain/countersign.ts` — countersignature primitive
10. `~/workspace/dfos/packages/dfos-protocol/src/chain/schemas.ts` — operation types + Zod schemas

## Summary of Changes by File

| File | Change |
|------|--------|
| `packages/auth/src/crypto.ts` | Add multibase conversion functions |
| `packages/auth/src/types.ts` | Add MultikeyPublicKey type |
| `packages/dfos/` (new) | Entire new package |
| `apps/auth/src/db/schema.ts` | Add identityChains table, extend identities + tokens |
| `apps/auth/app/api/register/route.ts` | Create DFOS chain at registration |
| `apps/auth/app/api/identity/[did]/chain/route.ts` (new) | Chain serving endpoint |
| `apps/auth/app/api/identity/[did]/rotate/route.ts` (new) | Key rotation endpoint |
| `apps/auth/app/api/identity/[did]/keys/route.ts` (new) | Key role management |
| `apps/auth/app/api/identity/[did]/verify/route.ts` (new) | Chain verification |
| `apps/auth/app/api/resolve/dfos/[dfosDid]/route.ts` (new) | DFOS → Imajin resolution |
| `apps/auth/app/api/attestations/route.ts` | Add CID + JWS fields |
| `apps/auth/app/api/attestations/[id]/countersign/route.ts` (new) | Countersign endpoint |
| `packages/auth/src/middleware/nextjs.ts` | Extend with chain verify + key role options |
| `scripts/migrate-dfos-chains.ts` (new) | Migration script |
| `packages/dfos/tests/` (new) | Verification test suite |
| `package.json` (root) | Add vitest |
