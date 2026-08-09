# Spike: corpus identity + auth + provenance architecture

Addresses: #1749, #1750, #1751 (tracked under spike issue #1752)

Risk: low — this is a design document only. No production code was
modified as part of this spike.

## Summary

The corpus service (`apps/corpus/`) is a standalone Express/SQLite service
with **zero authentication** and **zero identity of its own**. It is invoked
today only through the kernel MCP proxy (`apps/kernel/src/lib/mcp/tools/corpus.ts`),
which forwards `ctx.did` (the verified resource-owner DID from the caller's MCP
session) as the corpus service's `:did` path parameter — a plain, unsigned
HTTP call over the internal LAN. `ctx.did` today also doubles as the SQLite
partition key (`CorpusStore.databaseForDid`), which means **the corpus index
is currently partitioned by caller, not by source** — this is the root cause
of #1749 (two callers ingesting `github:ima-jin/imajin-ai` today get two
separate SQLite databases).

The good news: the platform already has almost every primitive the three
briefs need. `packages/auth` ships Ed25519 signing/verification
(`crypto.ts`, `sign.ts`, `verify.ts`), a canonical-JSON signer
(`canonicalize`), a DID-minting convention (`providers/keypair.ts`), a public,
unauthenticated DID resolver (`GET /registry/api/identity/:did` +
`createHttpResolver` in `resolve.ts`), and a full attestation
pipeline (`emit-attestation.ts`, `auth.attestations` table, the bus
`attestationReactor`). None of it is wired into the corpus service. The work
is almost entirely *composition*, not new cryptography.

## Architecture

```
┌──────────────┐   MCP tool call: corpus_search / corpus_load / corpus_sync
│  MCP client   │   ctx.did = verified resource-owner DID (session/token)
└──────┬───────┘
       ▼
┌───────────────────────────────────────────────────────────────────┐
│ KERNEL  (apps/kernel)                                              │
│  1. requiredScope gate — corpus:read / corpus:write (unchanged)    │
│  2. resolve canonical corpusDid from `source` (deterministic hash) │
│  3. mint an EPHEMERAL CLAIM, sign with the kernel's OWN node DID   │
│     keypair (already exists — bootstrap-node-identity.ts, custody │
│     in auth.stored_keys). No new kernel keypair needed.            │
└──────┬──────────────────────────────────────────────────────────┘
       │ HTTP  Authorization: Imajin-Claim <base64url(claim)>.<sig>
       │ internal LAN — corpus never calls back to the kernel to verify
       ▼
┌───────────────────────────────────────────────────────────────────┐
│ CORPUS SERVICE (apps/corpus) — mints its own did:imajin:corpus:*   │
│  1. verify claim signature against the kernel's public key,       │
│     fetched once at startup (+ periodic refresh) via the existing │
│     PUBLIC endpoint GET /registry/api/identity/:kernelDid          │
│     (createHttpResolver from @imajin/auth — no per-request hop)   │
│  2. check claim.expiresAt + nonce replay window (in-memory, short)│
│  3. resolveCorpusDid(source) — deterministic, same fn kernel used  │
│  4. ingest(): upsert ThreadDocuments (unchanged), compute          │
│     contentHash, sign an IngestionAttestation with the corpus's    │
│     OWN private key, store attestationId on the written rows      │
│  5. search(): returns hits including attestationId — already a    │
│     stored column, zero added latency                              │
└──────┬──────────────────────────────────────────────────────────┘
       │ fire-and-forget POST {AUTH_SERVICE_URL}/api/attestations/internal
       │ (same two-phase pattern as packages/auth/src/emit-attestation.ts)
       ▼
┌───────────────────────────────────────────────────────────────────┐
│ KERNEL  auth.attestations (Postgres) — durable record of truth     │
│  type = 'corpus.ingested' (new ATTESTATION_TYPES entry)            │
└───────────────────────────────────────────────────────────────────┘
```

Two identities are introduced, both plain Ed25519 `did:imajin` DIDs, no new
cryptosystem:

- **Kernel's existing node DID** (already minted by
  `scripts/bootstrap-node-identity.ts`, key custodied in `auth.stored_keys`,
  decrypted via `MFA_ENCRYPTION_KEY`) becomes the *claim issuer*. No new
  keypair is needed on the kernel side.
- **A new corpus service DID**, minted once via a `bootstrap-corpus-identity.ts`
  script modeled directly on the node-identity bootstrap. Its private key is
  custodied by the corpus service itself (env var / vault secret), not by the
  kernel — the corpus service signs its own attestations autonomously, which
  is the point of #1751.

## Ephemeral claim schema

```typescript
/** Minted by the kernel per proxied MCP call; verified by corpus with no callback. */
interface CorpusAccessClaim {
  /** DID the action is attributed to — ctx.did, the resource-owner/caller. */
  actingDid: string;
  /** Canonical corpus DID this claim authorizes access to (see resolution algorithm below). */
  corpusDid: string;
  /** Scope granted for this single call. Mirrors the MCP tool's requiredScope. */
  scope: 'corpus:read' | 'corpus:write';
  /** DID of the claim issuer — the kernel's own node DID. */
  issuerDid: string;
  /** Unix ms when the claim was minted. */
  issuedAt: number;
  /** Unix ms after which corpus must reject the claim. Short-lived — e.g. issuedAt + 60_000. */
  expiresAt: number;
  /** Random nonce; corpus keeps a short in-memory replay window keyed on this. */
  nonce: string;
}

interface SignedCorpusAccessClaim {
  claim: CorpusAccessClaim;
  /** Ed25519 signature (hex), over canonicalize(claim), by issuerDid's private key. */
  signature: string;
}
```

Verification (corpus-side, no callback):

1. Reject if `Date.now() > claim.expiresAt` or `claim.expiresAt - claim.issuedAt`
   exceeds a max TTL (defense against a kernel bug minting long-lived claims).
2. Reject if `nonce` was already seen within the replay window (in-memory
   `Map<nonce, expiresAt>`, swept lazily — claims are short-lived so this
   never grows large).
3. Resolve `issuerDid`'s public key — fetched once at corpus startup (and
   refreshed on a timer) via `createHttpResolver` (`packages/auth/src/resolve.ts`)
   against the existing public `GET /registry/api/identity/:did` endpoint, then
   cached in memory. This is a one-time/periodic fetch, never a per-request
   callback, satisfying the "no callback" requirement while still rooting
   trust in the same DID resolution path the rest of the platform uses.
4. `crypto.verifySync(signature, canonicalize(claim), cachedKernelPublicKey)`
   using the existing `packages/auth/src/crypto.ts` primitives.
5. Reject if `claim.corpusDid` does not match the corpus DID being addressed
   by this request.

## Ingestion attestation schema

```typescript
interface IngestionAttestation {
  /** Corpus-local id (e.g. ing_xxx), distinct from the kernel's auth.attestations.id. */
  id: string;
  /** e.g. "github:ima-jin/imajin-ai" */
  source: string;
  /** Canonical corpus DID this ingestion targets (subject). */
  corpusDid: string;
  /** actingDid from the claim that authorized this ingest — who requested it. */
  ingesterDid: string;
  /** sha256 over the sorted (docId, updated) pairs of the ingested batch. */
  contentHash: string;
  /** Documents written in this batch. */
  threadCount: number;
  /** ISO 8601. */
  timestamp: string;
  /** Ed25519 hex, corpus DID signs canonicalize({source, corpusDid, ingesterDid, contentHash, threadCount, timestamp}). */
  signature: string;
}
```

Storage — **both** corpus DB and kernel, each for a different reason:

- **Corpus SQLite** (new `ingestion_attestations` table, keyed by `id`, plus
  a new `attestation_id` column on `threads`): needed so `search()` can
  return provenance with zero added latency (§ below). This is the corpus
  service's own signed local record — it does not depend on the kernel being
  reachable at ingest time.
- **Kernel `auth.attestations`** (fire-and-forget, mirroring the existing
  two-phase `emitAttestation()` pattern in `packages/auth/src/emit-attestation.ts`):
  the platform's durable, cross-service record of truth, consistent with
  every other attestation type and discoverable via the existing
  `GET /auth/api/attestations` route. Requires one new `ATTESTATION_TYPES`
  entry: `'corpus.ingested'`.

## Source → DID resolution algorithm

Today `:did` in every corpus route is the **caller's** DID, used as the
SQLite partition key. That is the bug #1749 describes: it makes ownership
per-caller instead of per-source. The fix is to stop keying the corpus
partition off the caller and key it off the **source** instead, with a pure,
deterministic function both the kernel and corpus can compute independently:

```typescript
function resolveCorpusDid(source: string): string {
  const normalized = normalizeSource(source); // lowercase scheme, trim trailing '/'
  const digest = sha256(normalized).toString('hex').slice(0, 32);
  return `did:imajin:corpus:${digest}`;
}
```

This directly generalizes the hashing already used in
`apps/corpus/src/engine/store.ts` (`databaseForDid` hashes `did` today) and
`apps/corpus/src/lib/workspace.ts` (hashes `did` for workspace roots) — same
technique, applied to `source` instead of the caller's DID.

Properties this gives us for free:

- **No coordination required.** Any caller (or the kernel, independently)
  computes the same `corpusDid` for `github:ima-jin/imajin-ai` with zero
  network round-trip and no shared mapping table.
- **Duplicate ingest under different callers converges automatically.**
  Two different `actingDid`s ingesting the same `source` write into the same
  SQLite database, and `CorpusStore.ingest()`'s existing
  `ON CONFLICT(source, doc_id) DO UPDATE` already deduplicates at the row
  level — no new reconciliation logic needed.
- **`actingDid` still matters for authorization, not partitioning.** The
  claim's `scope` + `actingDid` continue to gate *who* may read/write; they
  simply no longer select *which* SQLite file is touched.

An explicit `source_registry` mapping table (source → corpus DID → owner DID)
is **not required for v1 convergence**, but is the natural escape hatch if a
future requirement needs an owner to explicitly claim/rename a source's
canonical DID (e.g. migrating a source to a new corpus identity). Flagged as
a follow-up, not blocking.

## Search result provenance

Yes — zero added latency. Add an `attestation_id TEXT` column to the
`threads` table, populated from the just-created `IngestionAttestation.id`
during `CorpusStore.ingest()`, and surface it on `CorpusSearchHit` (currently
in `apps/corpus/src/engine/types.ts`):

```typescript
interface CorpusSearchHit {
  // ...existing fields unchanged
  attestationId?: string; // ingestion attestation that wrote/last-touched this thread
}
```

This is a plain stored column returned by the same `SELECT` that already
powers `search()` — no join, no extra round-trip, no extra query.

## Existing code to reuse

- `packages/auth/src/crypto.ts` — Ed25519 `generateKeypair`/`sign`/`verify`,
  hex helpers, multibase encoding. Core primitive for both the corpus DID
  keypair and claim/attestation signing.
- `packages/auth/src/sign.ts` (`canonicalize`) — deterministic JSON
  serialization needed so claim/attestation signatures are reproducible.
- `packages/auth/src/verify.ts` — model for claim verification, including
  the existing max-age/future-tolerance pattern
  (`SIGNED_MESSAGE_MAX_AGE`, `FUTURE_TOLERANCE`) to reuse for claim TTL checks.
- `packages/auth/src/providers/keypair.ts` (`generateKeypair`, `createDID`,
  `isValidDID`) — the DID-minting convention to follow for the corpus DID.
- `packages/auth/src/resolve.ts` (`createHttpResolver`) — exactly the
  "no callback" public-key lookup corpus needs for verifying kernel-issued
  claims, pointed at the existing public endpoint.
- `apps/kernel/app/registry/api/identity/[did]/route.ts` — the existing
  public, unauthenticated DID resolver (`GET /registry/api/identity/:did`).
  Already returns the field corpus needs (`publicKey`).
- `scripts/bootstrap-node-identity.ts` — direct template for a new
  `bootstrap-corpus-identity.ts` (generate keypair, derive DID, optionally
  register in `auth.identities` with `subtype: 'service'`).
- `packages/auth/src/emit-attestation.ts` +
  `packages/bus/src/reactors/attestation.ts` + `packages/bus/src/config.ts` —
  the two-phase "write to auth DB, fire-and-forget chain-emit" pattern and
  bus-reactor wiring; template for how corpus forwards ingestion attestations
  to the kernel.
- `packages/auth/src/types/attestation.ts` (`ATTESTATION_TYPES`,
  `Attestation`) — attestation vocabulary and storage shape; needs one new
  enum entry, no structural change.
- `apps/corpus/src/engine/store.ts` (`databaseForDid`'s `sha256(did)`
  partitioning) and `apps/corpus/src/lib/workspace.ts` (`workspaceRootForDid`)
  — the hashing technique generalizes directly to `resolveCorpusDid(source)`.
- `apps/kernel/src/lib/mcp/tools/corpus.ts`'s existing `requiredScope` gate
  (`corpus:read` / `corpus:write`) — keep as-is; it already answers "is this
  caller allowed to ask", independent of which corpus DID the request repoints to.

## New code to build

- **apps/corpus**: claim-verification middleware (steps 1–5 above); startup
  fetch + periodic refresh of the kernel's public key via
  `createHttpResolver`; corpus keypair bootstrap/loading
  (`CORPUS_DID`, `CORPUS_DID_PRIVATE_KEY` env/secret); `resolveCorpusDid(source)`;
  ingestion-attestation construction, signing, and local storage (new
  `ingestion_attestations` SQLite table + `attestation_id` column on
  `threads`); fire-and-forget forwarding call to the kernel's attestation
  endpoint, mirroring `emit-attestation.ts`.
- **apps/corpus**: add `@imajin/auth` as a dependency. This is a real,
  deliberate change — `apps/corpus` is currently standalone by design (no
  `@imajin/*` deps at all; see its own module comments). Adding it is the
  cheapest path to reuse `crypto.ts`/`sign.ts`/`verify.ts`/`resolve.ts`
  rather than re-implementing Ed25519 plumbing a second time.
- **apps/kernel**: claim-minting helper invoked by
  `mcp/tools/corpus.ts` before each proxied call (loads the kernel's own
  node private key the same way existing chain-signing code does,
  constructs + signs a `CorpusAccessClaim`); repoint the corpus partition key
  in the proxy from `ctx.did` to `resolveCorpusDid(source)` for
  `corpus_load`/`corpus_sync` (read-only `corpus_search`/`corpus_status`
  need a `source` or explicit `corpusDid` argument added to their input
  schema, since today they only take `ctx.did`).
- **packages/auth/src/types/attestation.ts**: add `'corpus.ingested'` to
  `ATTESTATION_TYPES`.
- **scripts**: new `bootstrap-corpus-identity.ts`.
- New env/secrets: `CORPUS_DID`, `CORPUS_DID_PRIVATE_KEY` (corpus-side);
  no new kernel-side secret is required since the kernel's existing node
  keypair is reused as the claim issuer.

## Verdicts

1. **Service DID minting (#1751)** — **VALIDATED**. `bootstrap-node-identity.ts`
   is a directly reusable template; `packages/auth` already has every crypto
   primitive needed. This is the lowest-risk piece of the three briefs.
2. **Ephemeral signed claims, verified without a callback** — **PARTIAL**.
   All the cryptographic primitives (`canonicalize`, `sign`, `verify`, expiry
   checks) exist and are reusable as-is. The claim shape, corpus-side
   verification middleware, and the "cache the kernel's public key from the
   existing public resolver instead of calling back per-request" wiring do
   not exist yet and must be built. Note this deliberately does **not** reuse
   `X-Acting-For`/`requireAuth`'s `validateActingAs`, which calls back to the
   auth service per request — that pattern is unsuitable for the "no
   callback" requirement.
3. **Canonical source → DID resolution (#1749)** — **PARTIAL**. The hashing
   technique already exists in `apps/corpus` (used for a different purpose —
   partitioning by caller DID). Repointing partitioning from `ctx.did` to
   `resolveCorpusDid(source)` is a real, non-trivial change to
   `apps/corpus/src/routes.ts` and the kernel proxy's argument contract
   (`corpus_search`/`corpus_status` need a `source` argument they don't
   have today), not just an addition.
4. **Ingestion attestation shape and storage** — **PARTIAL**. The kernel-side
   attestation machinery (`emitAttestation`, `auth.attestations`,
   `ATTESTATION_TYPES`) fully covers the durable-storage half. The
   corpus-side half — signing its own attestations, storing them locally,
   and forwarding them — is entirely new code, since corpus currently has no
   signing capability and no outbound calls to the kernel at all.
5. **Search result provenance without added latency** — **VALIDATED** as a
   design decision: storing `attestationId` as a plain column returned by
   the existing `search()` query is sound and adds no round-trip. The column
   itself doesn't exist yet, but it is a trivial addition once #4 lands.
6. **Existing patterns mapped** (`emitAttestation`, `Ed25519`,
   `X-Acting-For`, `requireAuth`, service keypairs, challenge-response) —
   **VALIDATED**. Full map produced above; the platform's identity/auth
   surface is mature enough that this architecture is composition of
   existing pieces plus a well-scoped amount of new corpus-side code, not a
   new subsystem.
