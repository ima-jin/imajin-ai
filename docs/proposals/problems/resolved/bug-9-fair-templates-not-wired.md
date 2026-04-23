## BUG-9 — .fair Templates Not Used in Any Upload Path ✅ RESOLVED 2026-04-08

**Resolved:** Context-aware `.fair` templates are now wired into the media upload path. PR #638 (commit `78d0978a`, "fix(media): context-aware .fair templates + chat uploads default to public") added per-asset manifest creation alongside the upload pipeline. Verified at `apps/kernel/app/media/api/assets/route.ts:200–237`:

```typescript
const fairPath = `${dirPath}/${assetId}.fair.json`;
const fairManifest = {
  fair: "1.0",
  id: assetId,
  type: "asset",
  owner: ownerDid,
  created: new Date().toISOString(),
  attribution: [{ did: ownerDid, role: "creator", share: 1.0 }],
  access: { type: accessLevel },
};
```

After the kernel merge (RFC-19, PR #631), `apps/chat`, `apps/input`, and `apps/learn` upload paths all flow through the consolidated kernel media route, so all upload paths now produce `.fair` manifests through the same code. The `createManifestFromTemplate()` style is supplanted by inline templates per upload context (chat → public, profile → followers, etc.) — the spirit of the fix is in place even though the API surface differs from the original proposal.

**File:** `apps/kernel/app/media/api/assets/route.ts` (post-kernel-merge location of the original `apps/media/...` upload route)
**Severity:** Medium — attribution gap across 3+ upload paths
**Detected:** March 27, 2026 (from GitHub issue #330)

### The Problem

Issue #330 documented that `.fair` manifests were created in only 2 of 5+ upload paths. Three upload paths created zero attribution: `apps/chat`, `apps/input`, and `apps/learn`. The template system existed but nothing called `createManifestFromTemplate()`.

### How it was Resolved

1. **Kernel merge (#631)** consolidated all upload paths through `apps/kernel/app/media/api/assets/route.ts`. There is now one upload code path for every service.
2. **PR #638** wired context-aware `.fair` manifest emission directly into that route, with per-context access level (`public` / `followers` / `private`).
3. The chat upload path defaults to `public` access; profile/media defaults to `followers`; learn content defaults to `public`.

### Detection Confirmed

- `apps/kernel/app/media/api/assets/route.ts` writes a `.fair.json` sidecar for every asset
- All upload entry points pass through this single route post-kernel-merge
- Issue #330 superseded by #638 / kernel merge
