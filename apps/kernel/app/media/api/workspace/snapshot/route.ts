import { NextRequest, NextResponse } from "next/server";
import { db, assets, workspaceSnapshots, workspaceBranches } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq, and } from "drizzle-orm";
import { computeCid } from "@imajin/cid";
import { createLogger } from "@imajin/logger";
import { corsHeaders } from "@/src/lib/kernel/cors";
import { nanoid } from "nanoid";

const log = createLogger("kernel");

// ---------------------------------------------------------------------------
// POST /api/workspace/snapshot — create a workspace snapshot
//
// Captures the current state (CID) of every active asset for the caller's DID
// into a content-addressed manifest. The manifest CID is the immutable,
// verifiable identifier for this point-in-time snapshot.
//
// The snapshot is appended to the 'main' branch by default (or the branch
// specified in the request body). Creates the branch if it doesn't exist yet.
//
// Request body (optional): { branchName?: string }
// Response: { snapshotId, manifestCid, branchName, assetCount, parentSnapshotId }
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  // 1. Auth
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  // 2. Parse optional branch name
  let branchName = "main";
  try {
    const body = await request.json() as { branchName?: unknown };
    if (typeof body.branchName === "string" && body.branchName.trim()) {
      branchName = body.branchName.trim();
    }
  } catch { /* no body — use defaults */ }

  // 3. Fetch all active assets for this DID
  let activeAssets;
  try {
    activeAssets = await db
      .select({
        id: assets.id,
        filename: assets.filename,
        cid: assets.cid,
        loreRef: assets.loreRef,
        versionCount: assets.versionCount,
      })
      .from(assets)
      .where(and(eq(assets.ownerDid, ownerDid), eq(assets.status, "active")));
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }

  // 4. Get current HEAD for this branch (parent snapshot)
  let parentSnapshotId: string | null = null;
  try {
    const [branch] = await db
      .select()
      .from(workspaceBranches)
      .where(and(eq(workspaceBranches.ownerDid, ownerDid), eq(workspaceBranches.branchName, branchName)))
      .limit(1);
    parentSnapshotId = branch?.headSnapshotId ?? null;
  } catch (err) {
    log.error({ err: String(err) }, "Branch lookup failed");
  }

  // 5. Build manifest document
  const assetEntries: Record<string, { cid: string | null; loreRef: string | null; filename: string; versionCount: number }> = {};
  for (const asset of activeAssets) {
    assetEntries[asset.id] = {
      cid: asset.cid,
      loreRef: asset.loreRef,
      filename: asset.filename,
      versionCount: asset.versionCount,
    };
  }

  const snapshotId = `snap_${nanoid(16)}`;
  const manifest = {
    version: "1.0",
    owner: ownerDid,
    branch: branchName,
    snapshotId,
    parentManifestCid: null as string | null,  // filled in below
    assets: assetEntries,
    assetCount: activeAssets.length,
    createdAt: new Date().toISOString(),
  };

  // If there's a parent snapshot, include its manifestCid in the manifest
  // (creates the hash-linked chain analogous to a Merkle DAG)
  if (parentSnapshotId) {
    try {
      const [parent] = await db
        .select({ manifestCid: workspaceSnapshots.manifestCid })
        .from(workspaceSnapshots)
        .where(eq(workspaceSnapshots.id, parentSnapshotId))
        .limit(1);
      manifest.parentManifestCid = parent?.manifestCid ?? null;
    } catch { /* non-fatal */ }
  }

  // 6. Compute manifest CID (content-addresses the entire snapshot state)
  const manifestCid = await computeCid(manifest);

  // 7. Persist snapshot
  try {
    await db.insert(workspaceSnapshots).values({
      id: snapshotId,
      ownerDid,
      branchName,
      manifestCid,
      manifest: manifest as unknown as Record<string, unknown>,
      parentSnapshotId,
    });
  } catch (err) {
    log.error({ err: String(err) }, "Snapshot insert failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }

  // 8. Update (or create) the branch HEAD pointer
  try {
    const branchId = `wbranch_${nanoid(16)}`;
    await db
      .insert(workspaceBranches)
      .values({ id: branchId, ownerDid, branchName, headSnapshotId: snapshotId })
      .onConflictDoUpdate({
        target: [workspaceBranches.ownerDid, workspaceBranches.branchName],
        set: { headSnapshotId: snapshotId, updatedAt: new Date() },
      });
  } catch (err) {
    log.error({ err: String(err) }, "Branch HEAD update failed");
    // Non-fatal — snapshot was created; HEAD pointer update can be retried
  }

  log.info({ ownerDid, snapshotId, manifestCid: manifestCid.slice(0, 16) + "…", assetCount: activeAssets.length, branchName }, "Workspace snapshot created");

  return NextResponse.json(
    { snapshotId, manifestCid, branchName, assetCount: activeAssets.length, parentSnapshotId },
    { status: 201, headers: cors },
  );
}
