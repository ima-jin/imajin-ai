import { NextRequest, NextResponse } from "next/server";
import { db, assets } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import { hasHistoryAccess, getAssetRevisionHistory } from "@/src/lib/media/history-resolver";
import { corsHeaders } from "@/src/lib/kernel/cors";

const log = createLogger("kernel");

// ---------------------------------------------------------------------------
// GET /api/assets/[id]/history — revision history for an asset
//
// Access policy: most-specific-wins, default HEAD-only (#1122 Bundle 4).
//   - Owner: full history (versionNumber, loreRef, parentRef per revision)
//   - Others: 403 "History access not granted" (HEAD-only)
//
// Returns revisions HEAD-first (v<N> at index 0, v1 = genesis at end).
// An empty `revisions` array means the asset was uploaded before Lore
// integration or Lore tracking failed — content is still accessible via
// the main GET route.
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cors = corsHeaders(request);
  const { id } = await params;

  // 1. Auth
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const callerDid = resolveActingDid(authResult.identity);

  // 2. Load asset
  let asset;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }

  if (asset?.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: cors });
  }

  // 3. History access policy
  if (!hasHistoryAccess(callerDid, asset.ownerDid)) {
    return NextResponse.json(
      {
        error: "History access not granted",
        reason: "Version history is HEAD-only by default. The asset owner can grant history access.",
      },
      { status: 403, headers: cors },
    );
  }

  // 4. Fetch revision history from Lore
  const revisions = await getAssetRevisionHistory(asset.ownerDid, asset.loreRef);

  return NextResponse.json(
    {
      assetId: id,
      currentCid: asset.cid ?? null,
      currentLoreRef: asset.loreRef ?? null,
      total: revisions.length,
      revisions,
    },
    { status: 200, headers: cors },
  );
}
