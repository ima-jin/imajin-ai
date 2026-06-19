/**
 * GET /media/api/assets/[id]/receipts
 *
 * Returns settlement history (audit trail) for the owner's asset.
 * Requires owner authentication.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, assets, settlements, accessLog } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq, desc } from "drizzle-orm";
import { createLogger } from "@imajin/logger";

const log = createLogger("kernel");

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // 1. Authenticate
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const requesterDid = resolveActingDid(authResult.identity);

  // 2. Look up asset
  let asset;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (asset?.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden — owner only" }, { status: 403 });
  }

  // 3. Fetch settlements
  const settlementRows = await db
    .select()
    .from(settlements)
    .where(eq(settlements.assetId, id))
    .orderBy(desc(settlements.settledAt));

  // 4. Fetch access log
  const accessRows = await db
    .select()
    .from(accessLog)
    .where(eq(accessLog.assetId, id))
    .orderBy(desc(accessLog.at));

  return NextResponse.json({
    assetId: id,
    settlements: settlementRows,
    accessLog: accessRows,
  });
}
