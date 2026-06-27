import { NextRequest, NextResponse } from "next/server";
import { db, workspaceSnapshots, workspaceBranches } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq, and } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import { corsHeaders } from "@/src/lib/kernel/cors";

const log = createLogger("kernel");

// ---------------------------------------------------------------------------
// POST /api/workspace/rollback — re-point a branch HEAD to a prior snapshot
//
// This is a manifest-level rollback: the branch pointer moves to the target
// snapshot. Assets' soft-superseded Lore revisions (from Layer 1 #1122) are
// still recoverable — they remain in Lore's immutable chunk store.
//
// This does NOT automatically restore asset state on disk. Use the snapshot's
// manifest to identify the prior CIDs and, if needed, re-upload those bytes
// (a full asset-state restore operation is a future enhancement).
//
// Request body: { snapshotId: string, branchName?: string }
// Response: { branchName, headSnapshotId, manifestCid, previousHeadSnapshotId }
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  // 1. Auth
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  // 2. Parse body
  let body: { snapshotId?: unknown; branchName?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
  }

  if (!body.snapshotId || typeof body.snapshotId !== "string") {
    return NextResponse.json({ error: "snapshotId is required" }, { status: 400, headers: cors });
  }

  const branchName = typeof body.branchName === "string" && body.branchName.trim()
    ? body.branchName.trim()
    : "main";

  // 3. Verify the target snapshot belongs to this owner
  let snapshot;
  try {
    [snapshot] = await db
      .select()
      .from(workspaceSnapshots)
      .where(and(
        eq(workspaceSnapshots.id, body.snapshotId),
        eq(workspaceSnapshots.ownerDid, ownerDid),
      ))
      .limit(1);
  } catch (err) {
    log.error({ err: String(err) }, "Snapshot lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }

  if (!snapshot) {
    return NextResponse.json({ error: "Snapshot not found" }, { status: 404, headers: cors });
  }

  // 4. Get current HEAD (for return value / audit)
  let previousHeadSnapshotId: string | null = null;
  try {
    const [branch] = await db
      .select()
      .from(workspaceBranches)
      .where(and(eq(workspaceBranches.ownerDid, ownerDid), eq(workspaceBranches.branchName, branchName)))
      .limit(1);
    previousHeadSnapshotId = branch?.headSnapshotId ?? null;
  } catch { /* non-fatal */ }

  if (previousHeadSnapshotId === body.snapshotId) {
    return NextResponse.json({ error: "Branch HEAD is already at this snapshot" }, { status: 409, headers: cors });
  }

  // 5. Re-point branch HEAD
  try {
    const branchId = `wbranch_${Date.now()}`;
    await db
      .insert(workspaceBranches)
      .values({ id: branchId, ownerDid, branchName, headSnapshotId: body.snapshotId })
      .onConflictDoUpdate({
        target: [workspaceBranches.ownerDid, workspaceBranches.branchName],
        set: { headSnapshotId: body.snapshotId, updatedAt: new Date() },
      });
  } catch (err) {
    log.error({ err: String(err) }, "Rollback HEAD update failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }

  log.info(
    { ownerDid, branchName, snapshotId: body.snapshotId, previousHeadSnapshotId },
    "Workspace rolled back",
  );

  return NextResponse.json(
    {
      branchName,
      headSnapshotId: body.snapshotId,
      manifestCid: snapshot.manifestCid,
      previousHeadSnapshotId,
    },
    { status: 200, headers: cors },
  );
}
