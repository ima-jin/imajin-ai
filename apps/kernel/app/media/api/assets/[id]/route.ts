import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink, rename, stat, open } from "fs/promises";
import path from "path";
import { db, assets, settlements, accessLog } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq, and, sql } from "drizzle-orm";
import { createReadStream } from "fs";
import type { FairManifest } from "@imajin/fair";
import { isFairManifestV1_1, build402Response, verifyReceipt, loadVerifyKey } from "@imajin/fair";
import type { FairAction } from "@imajin/fair";
import { createLogger } from "@imajin/logger";

const log = createLogger("kernel");

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

function determineAction(request: NextRequest, mimeType: string): FairAction {
  const { searchParams } = new URL(request.url);
  const explicit = searchParams.get("action");
  if (explicit === 'reproduction' || explicit === 'streaming' || explicit === 'derivative' || explicit === 'syndication') {
    return explicit;
  }

  const rangeHeader = request.headers.get("range");
  if (rangeHeader && (mimeType.startsWith("audio/") || mimeType.startsWith("video/"))) {
    return 'streaming';
  }

  return 'reproduction';
}

// Cache the verify key loaded from AUTH_PRIVATE_KEY
let verifyKeyPromise: Promise<import('jose').KeyLike> | null = null;
function getVerifyKey(): Promise<import('jose').KeyLike> {
  if (!verifyKeyPromise) {
    const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
    if (!privateKeyHex) {
      verifyKeyPromise = Promise.reject(new Error('AUTH_PRIVATE_KEY not configured'));
    } else {
      verifyKeyPromise = loadVerifyKey(privateKeyHex);
    }
  }
  return verifyKeyPromise;
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
    log.error({ err: String(err) }, "DB lookup failed");
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

  // 4. Determine action and check for priced distribution
  const action = determineAction(request, asset.mimeType);
  const distRight = isFairManifestV1_1(manifest) ? manifest.distribution?.[action] : undefined;
  const hasPrice = !!distRight?.price;

  // 4a. Price-aware settlement flow
  if (hasPrice) {
    const receiptHeader = request.headers.get("X-Payment-Receipt");

    if (!receiptHeader) {
      // No receipt → 402 with settlement options
      try {
        const baseUrl = `${new URL(request.url).origin}/media/api/assets`;
        const resp = build402Response({
          manifest: manifest as import("@imajin/fair").FairManifestV1_1,
          assetId: id,
          action,
          supportedSchemes: ['stripe-link', 'mjnx-direct'],
          baseUrl,
        });
        return NextResponse.json(resp.body, { status: 402, headers: resp.headers });
      } catch (err) {
        log.error({ err: String(err), assetId: id, action }, "build402Response failed");
        return NextResponse.json({ error: "Settlement configuration error" }, { status: 500 });
      }
    }

    // Verify receipt
    let receiptPayload;
    try {
      const verifyKey = await getVerifyKey();
      receiptPayload = await verifyReceipt(receiptHeader, verifyKey);
    } catch {
      receiptPayload = null;
    }

    if (!receiptPayload) {
      return NextResponse.json({ error: "Invalid payment receipt" }, { status: 402 });
    }

    // Validate receipt claims match this request
    if (receiptPayload.aud !== `asset:${id}`) {
      return NextResponse.json({ error: "Receipt audience mismatch" }, { status: 402 });
    }
    if (receiptPayload.action !== action) {
      return NextResponse.json({ error: "Receipt action mismatch" }, { status: 402 });
    }

    // Check receipt against database settlement record
    const [settlement] = await db
      .select()
      .from(settlements)
      .where(
        and(
          eq(settlements.id, receiptPayload.sub),
          eq(settlements.assetId, id),
          eq(settlements.action, action),
          eq(settlements.receiptToken, receiptHeader)
        )
      )
      .limit(1);

    if (!settlement) {
      return NextResponse.json({ error: "Settlement not found" }, { status: 402 });
    }

    // Replay protection: check for excessive access from same settlement
    const replayWindow = new Date(Date.now() - 60 * 60 * 1000); // 1 hour
    const recentAccessCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(accessLog)
      .where(
        and(
          eq(accessLog.settlementId, settlement.id),
          sql`${accessLog.at} > ${replayWindow}`
        )
      );

    const accessCount = recentAccessCount[0]?.count ?? 0;
    if (accessCount > 100) {
      return NextResponse.json(
        { error: "Rate limit exceeded for this settlement" },
        { status: 429 }
      );
    }

    // Log access
    try {
      const { nanoid } = await import('nanoid');
      await db.insert(accessLog).values({
        id: `acc_${nanoid(16)}`,
        assetId: id,
        action,
        settlementId: settlement.id,
        buyerDid: settlement.buyerDid ?? undefined,
        ip: request.headers.get("x-forwarded-for") || request.ip || undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      });
    } catch (err) {
      log.error({ err: String(err), assetId: id }, "Access log insertion failed");
      // Non-blocking — continue serving
    }
  }

  // 5. Read file from storage
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
      log.error({ err: String(err), storagePath: asset.storagePath, quality }, "Background transcode error")
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
    log.error({ err: String(err) }, "DB lookup failed");
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
    log.error({ err: String(err) }, "DB lookup failed");
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
    log.error({ err: String(err) }, "File rename failed");
    return NextResponse.json({ error: "File rename failed" }, { status: 500 });
  }

  await db.update(assets).set({ filename: newFilename, storagePath: newStoragePath }).where(eq(assets.id, id));

  return NextResponse.json({ ok: true, filename: newFilename });
}
