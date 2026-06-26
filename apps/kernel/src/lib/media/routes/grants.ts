import { NextRequest, NextResponse } from "next/server";
import { db, assets } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { isFairManifestV1_1 } from "@imajin/fair";
import type { FairManifestV1_1 } from "@imajin/fair";
import { createLogger } from "@imajin/logger";
import { updateManifestFlow } from "@/src/lib/media/manifest-helpers";
import { corsHeaders } from "@/src/lib/kernel/cors";

const log = createLogger("kernel");

export async function patchGrants(
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
  const requesterDid = resolveActingDid(authResult.identity);

  // 2. Parse body
  let body: { add?: unknown; remove?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors }
    );
  }

  const add = Array.isArray(body.add) ? (body.add as unknown[]).filter((d): d is string => typeof d === "string") : [];
  const remove = Array.isArray(body.remove) ? (body.remove as unknown[]).filter((d): d is string => typeof d === "string") : [];

  if (add.length === 0 && remove.length === 0) {
    return NextResponse.json(
      { error: "add or remove must contain at least one DID string" },
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

  // Ensure access is an object
  if (typeof manifest.access === "string") {
    manifest.access = { type: manifest.access };
  }

  // Merge grants into allowedDids
  const current = new Set(manifest.access.allowedDids ?? []);
  for (const did of add) current.add(did);
  for (const did of remove) current.delete(did);

  // If grants exist, switch access type to trust-graph so allowedDids are honored
  const hasGrants = current.size > 0;
  manifest.access = {
    type: hasGrants ? "trust-graph" : (manifest.access.type ?? "private"),
    allowedDids: hasGrants ? Array.from(current) : undefined,
  };

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
