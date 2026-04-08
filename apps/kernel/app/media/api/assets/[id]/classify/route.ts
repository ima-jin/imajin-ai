import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { db, assets } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { classifyAsset } from "@/src/lib/media/classify";

// ---------------------------------------------------------------------------
// POST /api/assets/[id]/classify — re-classify an existing asset
// ---------------------------------------------------------------------------
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity } = authResult;

  const { id } = await params;

  // Look up asset
  let asset;
  try {
    [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, id))
      .limit(1);
  } catch (err) {
    console.error("DB lookup failed:", err);
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (!asset || asset.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Owner check
  const ownerDid = identity.actingAs || identity.id;
  if (asset.ownerDid !== ownerDid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Read file from disk
  let buffer: Buffer;
  try {
    buffer = await readFile(asset.storagePath);
  } catch {
    return NextResponse.json({ error: "File not found on storage" }, { status: 404 });
  }

  // Classify
  let result;
  try {
    result = await classifyAsset(buffer, asset.filename, asset.mimeType);
  } catch (err) {
    console.error("Classification failed:", err);
    return NextResponse.json({ error: "Classification failure" }, { status: 500 });
  }

  // Persist
  const existingMeta = asset.metadata;
  try {
    await db.update(assets).set({
      classification: result.category,
      classificationConfidence: Math.round(result.confidence * 100),
      metadata: { ...(typeof existingMeta === "object" && existingMeta !== null ? existingMeta : {}), classification: result },
      updatedAt: new Date(),
    }).where(eq(assets.id, id));
  } catch (err) {
    console.error("DB update failed:", err);
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  return NextResponse.json({ id, classification: result }, { status: 200 });
}
