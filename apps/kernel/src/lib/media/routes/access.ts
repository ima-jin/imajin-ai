import { NextRequest, NextResponse } from "next/server";
import { db, assets } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { isFairManifestV1_1 } from "@imajin/fair";
import type { FairManifestV1_1 } from "@imajin/fair";
import { createLogger } from "@imajin/logger";
import { updateManifestFlow } from "@/src/lib/media/manifest-helpers";
import { corsHeaders } from "@/src/lib/kernel/cors";

const log = createLogger("kernel");

const ACCESS_TYPES = ["public", "private", "conversation"] as const;
type AccessType = (typeof ACCESS_TYPES)[number];

export async function patchAccess(
  request: NextRequest,
  id: string
): Promise<NextResponse> {
  const cors = corsHeaders(request);

  // 1. Auth
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status, headers: cors }
    );
  }
  const requesterDid = authResult.identity.actingAs || authResult.identity.id;

  // 2. Parse body
  let body: { access?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  const access = body.access;
  if (!access || !ACCESS_TYPES.includes(access as AccessType)) {
    return NextResponse.json(
      { error: `access must be one of: ${ACCESS_TYPES.join(", ")}` },
      { status: 400, headers: cors }
    );
  }

  // 3. Load asset
  let asset;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json(
      { error: "Database failure" },
      { status: 500, headers: cors }
    );
  }

  if (asset?.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: cors });
  }

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cors });
  }

  // 4. Build updated manifest
  let manifest: FairManifestV1_1;
  if (
    asset.fairManifest &&
    typeof asset.fairManifest === "object" &&
    Object.keys(asset.fairManifest as object).length > 0 &&
    isFairManifestV1_1(asset.fairManifest as Record<string, unknown>)
  ) {
    manifest = { ...(asset.fairManifest as FairManifestV1_1) };
  } else {
    // Fallback: create a minimal v1.1 manifest from asset metadata
    manifest = {
      fair: "1.1",
      version: "1.1",
      id: asset.id,
      type: asset.mimeType,
      owner: asset.ownerDid,
      created: (asset.createdAt ?? new Date()).toISOString(),
      access: { type: "private" },
      attribution: [{ did: asset.ownerDid, role: "creator", share: 1 }],
    };
  }

  manifest.access = { type: access as AccessType };

  // 5. Sign, write, publish, update DB
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.MEDIA_PUBLIC_URL ||
    new URL(request.url).origin;

  try {
    await updateManifestFlow(
      {
        id: asset.id,
        ownerDid: asset.ownerDid,
        fairPath: asset.fairPath,
        fairDfosEventId: asset.fairDfosEventId ?? null,
      },
      manifest,
      baseUrl
    );
  } catch (err) {
    log.error({ err: String(err), assetId: id }, "updateManifestFlow failed");
    return NextResponse.json(
      { error: "Failed to update manifest" },
      { status: 500, headers: cors }
    );
  }

  // 6. Return updated asset
  const [updated] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  return NextResponse.json(updated, { status: 200, headers: cors });
}
