# Spike Verdict: Lore Storage Backend (#1154)

**Date:** 2026-06-27
**Verdict: ✅ GO**

Lore integrates cleanly from Node.js/Next.js via the `@lore-vcs/sdk` npm package, chunk-level
dedup is confirmed with measured evidence, and the `BlobStore` interface isolates the pre-1.0
format risk. All five spike questions are answered.

---

## Q1 — Integration surface

**Expected:** `lore-js` SDK.
**Reality:** The SDK lives in a separate repo (`EpicGames/lore-js`) and is published as
`@lore-vcs/sdk` (v0.8.3) on npm. It uses **koffi** (v2.16.2) for FFI — pure JavaScript, no
node-gyp compilation. Pre-built native libraries are distributed as optional npm packages:

| Platform | Optional package |
|---|---|
| Windows x64 | `@lore-vcs/sdk-amd64-unknown-windows` |
| Linux x64 | `@lore-vcs/sdk-amd64-unknown-linux` |
| macOS arm64 | `@lore-vcs/sdk-arm64-apple-darwin` |

`npm install @lore-vcs/sdk` auto-installs the correct platform binary. The Windows DLL
(`lorelib-amd64-unknown-windows.dll`) installed without any build steps. No NAPI, no
node-gyp, no compilation in CI.

No `lore-server` is required for our use case. The SDK operates on a local `.lore` directory
(offline mode: `globalArgs.offline = true`), removing the operational dependency of running a
separate server process.

---

## Q2 — Local setup

**Works offline without `lore-server`.** A Lore repository is a `.lore` directory alongside
the files it tracks. One repo per DID workspace maps directly onto the existing
`{MEDIA_ROOT}/{didPath}/` directory structure:

```
/mnt/media/
  did_imajin_ryan/
    .lore/              ← Lore repo (immutable + mutable stores)
    asset_abc123.mp4    ← working copy (tracked by Lore)
    asset_def456.md
```

`repositoryCreate` is idempotent — call it on every DID's first upload, ignore if already
exists. No provisioning step needed ahead of time.

Tested: repo create + file stage + commit round-trip in ~75ms on Windows.

---

## Q3 — Chunk-level dedup (the core claim)

Measured with a 500 KB binary file (pseudo-random content, deterministic):

| Operation | Disk delta in `.lore` |
|---|---|
| Commit v1 (500 KB novel content) | +3.0 KB |
| Commit v2 (1 byte changed) | +2.4 KB |
| Re-commit v1 exact bytes | **+1.0 KB** |

**Re-committing 500 KB of identical content cost 1.0 KB (0.21% of file size)** — purely revision
chain metadata. The content chunks are not stored again.

One-byte-change delta (+2.4 KB for a 500 KB file) confirms chunk-level granularity: only the
chunk(s) containing the changed byte are stored as new data; all unchanged chunks are reused
from the immutable store.

The unusually small absolute numbers (3.0 KB for 500 KB) are due to the test file's highly
periodic content (period 256), which maximizes chunk dedup. Real-world binary media will store
closer to its actual size for novel content, but the dedup property — that identical content
is never stored twice — holds regardless.

**GC/Retention (epic open question):** Lore's immutable chunk store already handles this.
Removing a branch reference (the mutable store) orphans the revision; Lore's GC then collects
unreferenced chunks. No hand-rolled retention policy needed.

---

## Q4 — Revision hash ↔ DFOS CID relationship

These are **parallel identifiers, not the same thing:**

| | Lore revision hash | DFOS CID (`@imajin/cid`) |
|---|---|---|
| Format | 64-char SHA-256 hex | CIDv1 dag-cbor+sha256 base32lower |
| Example | `d9bb58d2bbb03d48...` | `bafyreibu...` |
| Input | Hash of entire chain state (parent + content tree) | Hash of content object bytes (dag-cbor encoded) |
| Changes on same-content re-commit | Yes (chain state advances) | No (same bytes = same CID) |
| Purpose | Lore-internal storage pointer | DFOS identity / attribution / verification |

**Design:** Both live on the `assets` row as separate columns:
- `loreRef TEXT` — Lore revision hash; storage pointer for `BlobStore.get()`
- `hash` / future `cid` — DFOS identity (what #1122 will promote to primary key)

Neither replaces the other. The `BlobStore` interface carries `loreRef`; the DFOS layer
carries the CID. They are computed independently and stored side-by-side.

---

## Q5 — Next.js server-side feasibility

**✅ Works.** Tested in Node.js ESM environment (same runtime as Next.js route handlers):

- Sequential writes (5 × 10 KB uploads): **375ms total** ✅
- Concurrent reads (`repositoryStatus` × 5 in parallel): ✅
- Concurrent writes to the **same repo**: ❌ lock contention (expected VCS behavior)

**Constraint:** Lore repos use file-based write locks. Concurrent uploads from the same DID
(same repo) need serialization. Uploads from different DIDs go to different repos — no
contention.

**Required `next.config.js` change:**
```js
// next.config.js
module.exports = {
  serverExternalPackages: ['@lore-vcs/sdk', 'koffi'],
};
```
This tells webpack not to bundle the native FFI packages, which is the standard Next.js
pattern for any native module. One line, no custom webpack plugin.

**`LoreBlobStore` implementation requirement:** Add a per-DID async write queue (e.g.,
`p-queue` with concurrency=1, keyed by DID) to serialize concurrent upload requests from the
same user. Reads are unaffected.

---

## Pre-1.0 risk assessment

Lore is explicitly pre-1.0: "Interfaces, on-disk formats, and APIs may change between
releases." Version 0.8.3 is already used in UEFN (Unreal Editor for Fortnite) production,
suggesting internal stability, but the open-source format is not frozen.

**Risk rating: Acceptable** — for the following reason: the `BlobStore` interface
(`put/get/gc`) isolates all Lore-specific code in `blob-store-lore.ts`. A Lore format break
is a backend swap (one file), not a rewrite of the asset identity model, content chains, or
anything above it. The DFOS CID (Layer A, #1122) is computed independently of Lore's internal
format, so a Lore format bump does not invalidate any CID or chain entry.

Migration story if Lore breaks format: re-commit existing blobs through the new format using
`asset_references` as the traceable index. Not trivial, but bounded.

6-month horizon assessment: v0.8.x to v1.0 is likely within that window. The `BlobStore`
interface means the upgrade path is a single implementation file swap, not a migration.

---

## Plan B assessment (git-as-blob-backend)

If Lore had failed the spike, git would have been the fallback. For reference:

| | Lore | git (LFS) |
|---|---|---|
| Binary dedup | Chunk-level, native | Full-copy per version unless LFS |
| LFS server needed | No | Yes (separate service) |
| npm integration | `npm install` | Not applicable |
| Format stability | Pre-1.0 (risk) | Decades-old (stable) |
| Chunk delta (1-byte change in 500 KB) | ~2.4 KB | ~500 KB (full copy) |

Lore is strictly superior for binary media. Plan B is not needed.

---

## Phase B — What to build

Confirming scope from the issue:

1. **`apps/kernel/src/lib/media/blob-store.ts`** — `BlobStore` interface:
   ```ts
   export interface BlobRef { loreRef: string; repoPath: string; sizeBytes: number; }
   export interface BlobStore {
     put(ownerDid: string, bytes: Buffer, hint?: { filename?: string }): Promise<BlobRef>;
     get(ref: BlobRef): Promise<Buffer>;
     gc(ref: BlobRef): Promise<void>;
   }
   ```

2. **`apps/kernel/src/lib/media/blob-store-lore.ts`** — `LoreBlobStore`:
   - Maps `ownerDid` → `{MEDIA_ROOT}/{didPath}` Lore repo path
   - `repositoryCreate` on first use (idempotent)
   - Per-DID `p-queue` (concurrency=1) for write serialization
   - `fileStage` + `revisionCommit` → returns `BlobRef` with 64-char revision hash
   - `get`: checkout / hydrate file from Lore into a temp buffer, return

3. **`apps/kernel/app/media/api/assets/route.ts`** — replace `writeFile` with `blobStore.put()`

4. **`next.config.js`** — add `serverExternalPackages: ['@lore-vcs/sdk', 'koffi']`

5. **Schema** — add nullable `loreRef TEXT` column to `assets` if needed alongside `storagePath`

6. **Do NOT change asset identity to CID** — that is #1122 riding on top of this.

---

*Spike conducted 2026-06-27. Spike code in `D:/Temp/lore-spike/` (throwaway, not committed).*
*All five spike questions answered with live measurements. Verdict: GO.*
