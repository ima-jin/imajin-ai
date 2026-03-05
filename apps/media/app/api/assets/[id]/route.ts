import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { db, assets } from "@/src/db";
import { requireAuth } from "@/src/lib/auth";
import { eq } from "drizzle-orm";
import type { FairManifest } from "@imajin/fair";

function getAccessType(
  access: FairManifest["access"]
): "public" | "private" | "trust-graph" {
  if (!access) return "private";
  if (access === "public") return "public";
  if (access === "private") return "private";
  return access.type;
}

function getAllowedDids(access: FairManifest["access"]): string[] {
  if (!access || typeof access === "string") return [];
  return access.allowedDids ?? [];
}

// ---------------------------------------------------------------------------
// GET /api/assets/[id] — serve asset file with .fair access control
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // 1. Look up asset
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

  // 2. Get .fair manifest (prefer DB, fallback to disk)
  let manifest: FairManifest | null = null;

  if (
    asset.fairManifest &&
    typeof asset.fairManifest === "object" &&
    Object.keys(asset.fairManifest as object).length > 0
  ) {
    manifest = asset.fairManifest as FairManifest;
  } else if (asset.fairPath) {
    try {
      const raw = await readFile(asset.fairPath, "utf-8");
      manifest = JSON.parse(raw) as FairManifest;
    } catch {
      // No manifest on disk — default to private below
    }
  }

  const access = manifest?.access ?? "private";
  const accessType = getAccessType(access);

  // 3. Access control
  if (accessType !== "public") {
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: "Access denied", reason: "Authentication required" },
        { status: 403 }
      );
    }
    const requesterDid = authResult.identity.id;

    if (accessType === "private") {
      if (requesterDid !== asset.ownerDid) {
        return NextResponse.json(
          { error: "Access denied", reason: "Private asset — owner only" },
          { status: 403 }
        );
      }
    } else if (accessType === "trust-graph") {
      const allowedDids = getAllowedDids(access);
      if (
        requesterDid !== asset.ownerDid &&
        !allowedDids.includes(requesterDid)
      ) {
        return NextResponse.json(
          { error: "Access denied", reason: "Not in trust graph" },
          { status: 403 }
        );
      }
    }
  }

  // 4. Read file from storage
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(asset.storagePath);
  } catch {
    return NextResponse.json(
      { error: "File not found on storage" },
      { status: 404 }
    );
  }

  const { searchParams } = new URL(request.url);
  const widthParam = searchParams.get("w");
  const download = searchParams.get("download") === "true";

  // 5. Thumbnail generation for images (?w=<pixels>)
  let outputBuffer: Buffer = fileBuffer;
  const outputMime = asset.mimeType;

  if (widthParam && asset.mimeType.startsWith("image/")) {
    try {
      const sharp = (await import("sharp")).default;
      outputBuffer = await sharp(fileBuffer)
        .resize({ width: parseInt(widthParam, 10), withoutEnlargement: true })
        .toBuffer();
    } catch {
      // sharp unavailable or failed — fall through with original
    }
  }

  // 6. ETag / conditional GET
  const etag = `"${asset.hash}"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new NextResponse(null, { status: 304 });
  }

  // 7. Build response headers
  const headers = new Headers();
  headers.set("Content-Type", outputMime);
  headers.set("ETag", etag);
  headers.set("X-Fair-Access", accessType);

  if (accessType === "public") {
    headers.set("Cache-Control", "public, max-age=86400");
  } else {
    headers.set("Cache-Control", "private, max-age=3600");
  }

  if (download) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(asset.filename)}"`
    );
  }

  return new NextResponse(outputBuffer, { status: 200, headers });
}
