import { NextRequest, NextResponse } from "next/server";
import { db, workspaceSnapshots, workspaceBranches } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq, and, desc } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import { corsHeaders } from "@/src/lib/kernel/cors";
import { nanoid } from "nanoid";

const log = createLogger("kernel");

// ---------------------------------------------------------------------------
// GET /api/workspace/branch — list all branches for the authenticated DID
//
// Response: { branches: [{ id, branchName, headSnapshotId, manifestCid, updatedAt }] }
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  try {
    const branches = await db
      .select({
        id: workspaceBranches.id,
        branchName: workspaceBranches.branchName,
        headSnapshotId: workspaceBranches.headSnapshotId,
        manifestCid: workspaceSnapshots.manifestCid,
        assetCount: workspaceSnapshots.manifest,
        createdAt: workspaceBranches.createdAt,
        updatedAt: workspaceBranches.updatedAt,
      })
      .from(workspaceBranches)
      .leftJoin(workspaceSnapshots, eq(workspaceBranches.headSnapshotId, workspaceSnapshots.id))
      .where(eq(workspaceBranches.ownerDid, ownerDid))
      .orderBy(desc(workspaceBranches.updatedAt));

    return NextResponse.json(
      {
        branches: branches.map((b) => ({
          id: b.id,
          branchName: b.branchName,
          headSnapshotId: b.headSnapshotId,
          manifestCid: b.manifestCid ?? null,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        })),
      },
      { status: 200, headers: cors },
    );
  } catch (err) {
    log.error({ err: String(err) }, "Branch list failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }
}

// ---------------------------------------------------------------------------
// POST /api/workspace/branch — create a new named branch
//
// Forks from the current HEAD of 'main' (or the specified fromSnapshotId).
// The new branch is immediately set to that snapshot as its HEAD.
//
// Request body: { branchName: string, fromSnapshotId?: string }
// Response: { id, branchName, headSnapshotId, manifestCid }
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  let body: { branchName?: unknown; fromSnapshotId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
  }

  if (!body.branchName || typeof body.branchName !== "string" || !body.branchName.trim()) {
    return NextResponse.json({ error: "branchName is required" }, { status: 400, headers: cors });
  }
  const branchName = body.branchName.trim();

  // Resolve the starting snapshot
  let headSnapshotId: string | null = null;

  if (typeof body.fromSnapshotId === "string" && body.fromSnapshotId.trim()) {
    // Explicit starting snapshot — verify ownership
    const [snap] = await db
      .select({ id: workspaceSnapshots.id })
      .from(workspaceSnapshots)
      .where(and(eq(workspaceSnapshots.id, body.fromSnapshotId.trim()), eq(workspaceSnapshots.ownerDid, ownerDid)))
      .limit(1);
    if (!snap) {
      return NextResponse.json({ error: "fromSnapshotId not found" }, { status: 404, headers: cors });
    }
    headSnapshotId = snap.id;
  } else {
    // Fork from current 'main' HEAD
    const [main] = await db
      .select({ headSnapshotId: workspaceBranches.headSnapshotId })
      .from(workspaceBranches)
      .where(and(eq(workspaceBranches.ownerDid, ownerDid), eq(workspaceBranches.branchName, "main")))
      .limit(1);
    headSnapshotId = main?.headSnapshotId ?? null;
  }

  // Get manifestCid for response
  let manifestCid: string | null = null;
  if (headSnapshotId) {
    const [snap] = await db
      .select({ manifestCid: workspaceSnapshots.manifestCid })
      .from(workspaceSnapshots)
      .where(eq(workspaceSnapshots.id, headSnapshotId))
      .limit(1);
    manifestCid = snap?.manifestCid ?? null;
  }

  const branchId = `wbranch_${nanoid(16)}`;
  try {
    await db
      .insert(workspaceBranches)
      .values({ id: branchId, ownerDid, branchName, headSnapshotId })
      .onConflictDoNothing(); // silently succeed if branch already exists
  } catch (err) {
    log.error({ err: String(err) }, "Branch create failed");
    return NextResponse.json({ error: "Database failure — branch name may already exist" }, { status: 500, headers: cors });
  }

  log.info({ ownerDid, branchName, headSnapshotId }, "Workspace branch created");

  return NextResponse.json(
    { id: branchId, branchName, headSnapshotId, manifestCid },
    { status: 201, headers: cors },
  );
}
