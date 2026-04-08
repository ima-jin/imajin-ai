import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink, rename, stat, open } from "fs/promises";
import path from "path";
import { db, assets } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { createReadStream } from "fs";
import type { FairManifest } from "@imajin/fair";

/**
 * Serve a file with HTTP Range support (needed for video seeking/scrubbing).
 * Falls back to full response if no Range header is present.
 */
async function serveFileWithRange(
  request: NextRequest,
  filePath: string,
  contentType: string,
  extraHeaders?: Record<string, string>
): Promise<NextResponse> {
  const fileStat = await stat(filePath);
  const fileSize = fileStat.size;
  const rangeHeader = request.headers.get("range");

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Accept-Ranges", "bytes");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const fd = await open(filePath, "r");
      const buffer = Buffer.alloc(chunkSize);
      await fd.read(buffer, 0, chunkSize, start);
      await fd.close();

      headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      headers.set("Content-Length", String(chunkSize));

      return new NextResponse(new Uint8Array(buffer), { status: 206, headers });
    }
  }

  // No range — serve full file
  const fileBuffer = await readFile(filePath);
  headers.set("Content-Length", String(fileSize));
  return new NextResponse(new Uint8Array(fileBuffer), { status: 200, headers });
}
import {
  VIDEO_QUALITIES,
  type VideoQuality,
  getVariantPath,
  variantExists,
  isTranscoding,
  getAvailableVariants,
  getTranscodingStatus,
  transcodeVideo,
} from "@/src/lib/media/transcode";

function getAccessType(
  access: FairManifest["access"]
): "public" | "private" | "trust-graph" | "conversation" {
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
    const requesterDid = authResult.identity.actingAs || authResult.identity.id;

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
  const qualityParam = searchParams.get("quality") as VideoQuality | null;
  const download = searchParams.get("download") === "true";

  // 5a. Video quality variant serving (?quality=720p etc.)
  if (qualityParam && asset.mimeType.startsWith("video/") && (VIDEO_QUALITIES as readonly string[]).includes(qualityParam)) {
    const quality = qualityParam as VideoQuality;

    if (await variantExists(asset.storagePath, quality)) {
      const variantPath = getVariantPath(asset.storagePath, quality);
      return serveFileWithRange(request, variantPath, "video/mp4", {
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    }

    if (isTranscoding(asset.storagePath, quality)) {
      return NextResponse.json(
        { status: "transcoding", quality, retryAfter: 30 },
        { status: 202, headers: { "Retry-After": "30" } }
      );
    }

    // Kick off transcode fire-and-forget
    transcodeVideo(asset.storagePath, quality).catch((err) =>
      console.error(`[transcode] Background error for ${asset.storagePath} ${quality}:`, err)
    );
    return NextResponse.json(
      { status: "transcoding", quality, retryAfter: 30 },
      { status: 202, headers: { "Retry-After": "30" } }
    );
  }

  // 5. Thumbnail generation for images (?w=<pixels>)
  let outputBuffer: Buffer = fileBuffer;
  const outputMime = asset.mimeType;

  if (widthParam && asset.mimeType.startsWith("image/")) {
    try {
      const sharp = (await import("sharp")).default;
      outputBuffer = await sharp(fileBuffer)
        .rotate() // auto-orient from EXIF before resize
        .resize({ width: parseInt(widthParam, 10), withoutEnlargement: true })
        .toBuffer();
    } catch {
      // sharp unavailable or failed — fall through with original
    }
  }

  // 6. ETag / conditional GET — include resize params so variants cache separately
  const isResized = !!widthParam;
  const etag = isResized ? `"${asset.hash}-w${widthParam}"` : `"${asset.hash}"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new NextResponse(null, { status: 304 });
  }

  // 7. Build response headers
  const headers = new Headers();
  headers.set("Content-Type", outputMime);
  headers.set("ETag", etag);
  headers.set("X-Fair-Access", accessType);

  // Video files: use Range-aware serving for seeking/scrubbing
  if (asset.mimeType.startsWith("video/") && !isResized) {
    const variants = await getAvailableVariants(asset.storagePath);
    const transcoding = getTranscodingStatus(asset.storagePath);
    const cacheControl = accessType === "public" ? "public, max-age=86400" : "private, max-age=3600";
    return serveFileWithRange(request, asset.storagePath, outputMime, {
      "ETag": etag,
      "X-Fair-Access": accessType,
      "X-Variants": JSON.stringify(variants),
      "X-Transcoding": JSON.stringify(transcoding),
      "Cache-Control": cacheControl,
    });
  }

  if (accessType === "public") {
    // Resized variants: 1 hour (sellers may update images)
    // Originals: 24 hours (raw file doesn't change)
    headers.set("Cache-Control", isResized ? "public, max-age=3600" : "public, max-age=86400");
  } else {
    headers.set("Cache-Control", "private, max-age=3600");
  }

  headers.set("Content-Length", String(outputBuffer.length));

  if (download) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(asset.filename)}"`
    );
  }

  return new NextResponse(new Uint8Array(outputBuffer), { status: 200, headers });
}

// ---------------------------------------------------------------------------
// DELETE /api/assets/[id] — hard-delete asset + files (owner only)
// ---------------------------------------------------------------------------
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const requesterDid = authResult.identity.actingAs || authResult.identity.id;

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

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Remove files from disk (best-effort — don't fail if already gone)
  try { await unlink(asset.storagePath); } catch {}
  if (asset.fairPath) {
    try { await unlink(asset.fairPath); } catch {}
  }

  // Delete DB row
  await db.delete(assets).where(eq(assets.id, id));

  return NextResponse.json({ ok: true });
}

// ---------------------------------------------------------------------------
// PATCH /api/assets/[id] — rename asset filename (owner only)
// ---------------------------------------------------------------------------
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const requesterDid = authResult.identity.actingAs || authResult.identity.id;

  let body: { filename?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { filename } = body;
  if (!filename || typeof filename !== "string" || !filename.trim()) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }

  let asset;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  } catch (err) {
    console.error("DB lookup failed:", err);
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (!asset || asset.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const newFilename = filename.trim();
  const newStoragePath = path.join(path.dirname(asset.storagePath), newFilename);

  try {
    await rename(asset.storagePath, newStoragePath);
  } catch (err) {
    console.error("File rename failed:", err);
    return NextResponse.json({ error: "File rename failed" }, { status: 500 });
  }

  await db.update(assets).set({ filename: newFilename, storagePath: newStoragePath }).where(eq(assets.id, id));

  return NextResponse.json({ ok: true, filename: newFilename });
}
