import { NextRequest, NextResponse } from "next/server";
import { db, workspaceHistoryGrants } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { and, eq } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import { corsHeaders } from "@/src/lib/kernel/cors";
import { nanoid } from "nanoid";

const log = createLogger("kernel");

// ---------------------------------------------------------------------------
// POST /api/workspace/history-grant — grant workspace-wide history access
//
// Grants `granteeDid` the ability to call GET /api/assets/:id/history for
// any asset owned by the authenticated caller. This is the workspace-default
// tier of the most-specific-wins history access policy (#1122 §4).
//
// Per-asset overrides (owner check in hasHistoryAccess) still take precedence.
// This corresponds to `credential grant --read --broad` in DFOS terms (#1122 §4).
//
// DELETE is not yet implemented — revoke by scope in a future pass.
//
// Request body: { granteeDid: string }
// Response: { ok: true, granteeDid, scope: "broad", createdAt }
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
  let body: { granteeDid?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
  }

  if (!body.granteeDid || typeof body.granteeDid !== "string" || !body.granteeDid.trim()) {
    return NextResponse.json({ error: "granteeDid is required" }, { status: 400, headers: cors });
  }
  const granteeDid = body.granteeDid.trim();

  if (granteeDid === ownerDid) {
    return NextResponse.json({ error: "Cannot grant history access to yourself" }, { status: 400, headers: cors });
  }

  // 3. Upsert grant (idempotent)
  let grant;
  try {
    const id = `whgrant_${nanoid(12)}`;
    [grant] = await db
      .insert(workspaceHistoryGrants)
      .values({ id, ownerDid, granteeDid, scope: "broad" })
      .onConflictDoUpdate({
        target: [workspaceHistoryGrants.ownerDid, workspaceHistoryGrants.granteeDid],
        set: { scope: "broad" },
      })
      .returning();
  } catch (err) {
    log.error({ err: String(err) }, "History grant insert failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }

  log.info({ ownerDid, granteeDid }, "Workspace history grant created");

  return NextResponse.json(
    { ok: true, granteeDid, scope: "broad", createdAt: grant.createdAt },
    { status: 201, headers: cors },
  );
}

// ---------------------------------------------------------------------------
// GET /api/workspace/history-grant — list current workspace history grants
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  try {
    const grants = await db
      .select()
      .from(workspaceHistoryGrants)
      .where(eq(workspaceHistoryGrants.ownerDid, ownerDid));

    return NextResponse.json({ grants }, { status: 200, headers: cors });
  } catch (err) {
    log.error({ err: String(err) }, "Grant list failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/workspace/history-grant — revoke workspace-wide history grant
// ---------------------------------------------------------------------------
export async function DELETE(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const ownerDid = resolveActingDid(authResult.identity);

  let body: { granteeDid?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: cors });
  }

  if (!body.granteeDid || typeof body.granteeDid !== "string") {
    return NextResponse.json({ error: "granteeDid is required" }, { status: 400, headers: cors });
  }

  await db
    .delete(workspaceHistoryGrants)
    .where(and(
      eq(workspaceHistoryGrants.ownerDid, ownerDid),
      eq(workspaceHistoryGrants.granteeDid, body.granteeDid),
    ));

  return NextResponse.json({ ok: true }, { status: 200, headers: cors });
}
