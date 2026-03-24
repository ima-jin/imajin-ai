import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { db, assets } from "@/src/db";
import { eq } from "drizzle-orm";
import type { FairManifest } from "@imajin/fair";

const OG_MAX_WIDTH = 1200;
const OG_MAX_HEIGHT = 630;
const OG_QUALITY = 80;

/**
 * GET /api/assets/[id]/og — serve an OG-optimized image variant
 *
 * Resizes to fit within 1200×630 (preserving aspect ratio, no crop),
 * compresses to JPEG q80. Typically produces 50-150KB from multi-MB originals.
 *
 * Only serves public assets. No auth required (crawlers can't authenticate).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Look up asset
  let asset;
  try {
    [asset] = await db
      .select()
      .from(assets)
      .where(eq(assets.id, id))
      .limit(1);
  } catch {
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (!asset || asset.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Only serve public assets via OG route (crawlers can't auth)
  const manifest = asset.fairManifest as FairManifest | null;
  const access = manifest?.access ?? "private";
  if (access !== "public") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Only process images
  if (!asset.mimeType.startsWith("image/")) {
    return NextResponse.json({ error: "Not an image" }, { status: 400 });
  }

  // Read original
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(asset.storagePath);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  // Resize with sharp
  let outputBuffer: Buffer;
  try {
    const sharp = (await import("sharp")).default;
    outputBuffer = await sharp(fileBuffer)
      .resize({
        width: OG_MAX_WIDTH,
        height: OG_MAX_HEIGHT,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: OG_QUALITY, progressive: true })
      .toBuffer();
  } catch {
    // Sharp failed — serve original
    outputBuffer = fileBuffer;
  }

  // ETag based on asset hash + og params for cache busting
  const etag = `"${asset.hash}-og"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new NextResponse(null, { status: 304 });
  }

  const headers = new Headers();
  headers.set("Content-Type", "image/jpeg");
  headers.set("Content-Length", String(outputBuffer.length));
  headers.set("ETag", etag);
  headers.set("Cache-Control", "public, max-age=604800"); // 7 days — OG images rarely change

  return new NextResponse(new Uint8Array(outputBuffer), { status: 200, headers });
}
