import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink, rename, stat, open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { db, assets, settlements, accessLog, assetReferences } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq, and, sql } from "drizzle-orm";
import type { FairManifest, FairAction } from "@imajin/fair";
import { isFairManifestV1_1, build402Response, verifyReceipt, loadVerifyKey, canonicalize } from "@imajin/fair";
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
      const start = Number.parseInt(match[1], 10);
      const end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
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
import { getAccessType } from "@/src/lib/media/read-access";
import { authorizeAssetRead } from "@/src/lib/media/authorize-read";

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
let verifyKeyPromise: Promise<CryptoKey> | null = null;
function getVerifyKey(): Promise<CryptoKey> {
  if (!verifyKeyPromise) {
    const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
    if (privateKeyHex) {
      verifyKeyPromise = loadVerifyKey(privateKeyHex);
    } else {
      verifyKeyPromise = Promise.reject(new Error('AUTH_PRIVATE_KEY not configured'));
    }
  }
  return verifyKeyPromise;
}

/** Build .fair sidecar headers for an asset response (#882) */
function buildFairHeaders(
  assetId: string,
  manifest: FairManifest | null,
  dfosEventId: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  headers["Link"] = `</media/api/assets/${assetId}/fair>; rel="fair"; type="application/fair+json"`;

  if (manifest) {
    const digest = createHash("sha256").update(canonicalize(manifest)).digest("hex");
    headers["X-Fair-Digest"] = `sha256:${digest}`;
  }

  if (dfosEventId) {
    headers["X-Fair-Dfos"] = `dfos:event:${dfosEventId}`;
  }

  return headers;
}

/** Build a minimal HTML error page for Accept-negotiated browser responses */
function buildErrorHtml(title: string, message: string): string {
  const esc = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { max-width: 480px; padding: 2.5rem; border: 1px solid #222; border-radius: 12px; text-align: center; }
    h1 { font-size: 1.5rem; font-weight: 700; color: #fff; margin: 0 0 0.75rem; }
    p { color: #999; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
  </div>
</body>
</html>`;
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

  if (asset?.status !== "active") {
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

  // 2b. Compute .fair sidecar headers (used for both full and Range responses)
  const fairHeaders = buildFairHeaders(id, manifest, asset.fairDfosEventId ?? null);

  // 3. Access control — shared async decision (src/lib/media/authorize-read.ts):
  //    owner / public / trust-graph grant, plus conversation membership (#1168).
  if (accessType !== "public") {
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      const wantsHtml = request.headers.get("accept")?.includes("text/html");
      if (wantsHtml) {
        const returnTo = request.nextUrl.pathname;
        return NextResponse.redirect(
          new URL(`/auth/login?next=${encodeURIComponent(returnTo)}`, request.url)
        );
      }
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
      );
    }
    const requesterDid = resolveActingDid(authResult.identity);
    const decision = await authorizeAssetRead({ ownerDid: asset.ownerDid, access, metadata: asset.metadata }, requesterDid);
    if (!decision.allowed) {
      const wantsHtml = request.headers.get("accept")?.includes("text/html");
      if (wantsHtml) {
        const [title, message] =
          decision.accessType === "trust-graph"
            ? ["Access Restricted", "This asset is only accessible to members of the owner's trust graph."]
            : ["Private Asset", "This asset is private and only accessible to its owner."];
        return new NextResponse(
          buildErrorHtml(title, message),
          { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      return NextResponse.json(
        { error: "Access denied", reason: decision.reason },
        { status: 403 }
      );
    }
  }

  // 4. Determine action and check for priced distribution
  const action = determineAction(request, asset.mimeType);
  const distRight = manifest && isFairManifestV1_1(manifest) ? manifest.distribution?.[action] : undefined;
  const hasPrice = !!distRight?.price && distRight.price.amount > 0;

  // 4a. Price-aware settlement flow
  if (hasPrice) {
    const receiptHeader = request.headers.get("X-Payment-Receipt");

    if (!receiptHeader) {
      // No receipt → 402 with settlement options
      try {
        const publicBase = process.env.NEXT_PUBLIC_BASE_URL || process.env.MEDIA_PUBLIC_URL || new URL(request.url).origin;
        const baseUrl = `${publicBase}/media/api/assets`;
        const resp = build402Response({
          manifest: manifest,
          assetId: id,
          action,
          supportedSchemes: ['mjnx-direct'],
          baseUrl,
        });
        const wantsHtml = request.headers.get("accept")?.includes("text/html");
        if (wantsHtml) {
          return new NextResponse(
            buildErrorHtml("Payment Required", "This asset requires payment to unlock. Please use a compatible client to complete settlement."),
            { status: 402, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }
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

    // Buyer-binding: caller must be authenticated AND match the receipt's buyer DID.
    // Receipts are non-transferable in v1 — transfer semantics tracked in #904.
    const buyerAuth = await requireAuth(request);
    if ("error" in buyerAuth) {
      return NextResponse.json(
        { error: "Authentication required to redeem payment receipt" },
        { status: 401 }
      );
    }
    const callerDid = resolveActingDid(buyerAuth.identity);
    if (callerDid !== receiptPayload.buyer) {
      return NextResponse.json(
        { error: "Receipt is bound to a different identity" },
        { status: 403 }
      );
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
    const quality = qualityParam;

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

  // 5a. Auto-render markdown articles as HTML
  // If it's text/markdown carrying a frontmatter `title` and the client isn't
  // requesting raw bytes, render as a styled article page. Presence of a
  // `title` is the signal it's an article; `status` no longer gates rendering
  // (a DRAFT/REVIEW doc should still render for anyone allowed to access it —
  // access control already ran above, so private assets stay auth-gated). The
  // public article index filters on DB `metadata.article.status` separately, so
  // rendering here never publishes or lists a doc.
  if (
    asset.mimeType === "text/markdown" &&
    !download &&
    request.headers.get("accept") !== "application/octet-stream"
  ) {
    const mdContent = fileBuffer.toString("utf-8");
    const matter = (await import("gray-matter")).default;
    const { data: fm, content: body } = matter(mdContent);

    if (fm.title) {
      const { remark } = await import("remark");
      const remarkGfm = (await import("remark-gfm")).default;
      const remarkHtml = (await import("remark-html")).default;

      // Strip first H1 if present (avoid duplicate title rendering)
      const bodyLines = body.split('\n');
      let start = 0;
      while (start < bodyLines.length && bodyLines[start].trim() === '') start += 1;
      if (start < bodyLines.length && bodyLines[start].startsWith('# ')) {
        start += 1;
        while (start < bodyLines.length && bodyLines[start].trim() === '') start += 1;
      }
      const bodyClean = bodyLines.slice(start).join('\n');
      const processed = await remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).process(bodyClean);
      const articleHtml = processed.toString();

      const escapedTitle = (fm.title as string).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const escapedSubtitle = fm.subtitle ? (fm.subtitle as string).replaceAll('<', '&lt;').replaceAll('>', '&gt;') : "";
      const escapedDesc = fm.description ? (fm.description as string).replaceAll('<', '&lt;').replaceAll('>', '&gt;') : "";
      const author = fm.author || "";
      const date = fm.date
        ? new Date(fm.date as string).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
        : "";

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
  <meta name="description" content="${escapedDesc}">
  <meta property="og:title" content="${escapedTitle}">
  <meta property="og:description" content="${escapedDesc}">
  <meta property="og:type" content="article">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.7; color: #e0e0e0; background: #0a0a0a; }
    article { max-width: 680px; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
    header { margin-bottom: 2.5rem; border-bottom: 1px solid #222; padding-bottom: 2rem; }
    h1 { font-size: 2.2rem; font-weight: 700; line-height: 1.2; color: #fff; margin-bottom: 0.5rem; }
    .subtitle { font-size: 1.2rem; color: #999; margin-bottom: 1rem; }
    .meta { font-size: 0.85rem; color: #666; }
    .meta span + span::before { content: ' · '; }
    h2 { font-size: 1.5rem; font-weight: 600; color: #fff; margin: 2.5rem 0 1rem; }
    h3 { font-size: 1.2rem; font-weight: 600; color: #ddd; margin: 2rem 0 0.75rem; }
    p { margin-bottom: 1.2rem; }
    ul, ol { margin: 0 0 1.2rem 1.5rem; }
    li { margin-bottom: 0.4rem; }
    strong { color: #fff; }
    a { color: #f97316; text-decoration: none; }
    a:hover { text-decoration: underline; }
    blockquote { border-left: 3px solid #f97316; margin: 1.5rem 0; padding: 0.5rem 1rem; color: #aaa; }
    code { background: #1a1a1a; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.9em; }
    pre { background: #1a1a1a; padding: 1rem; border-radius: 6px; overflow-x: auto; margin-bottom: 1.2rem; }
    pre code { background: none; padding: 0; }
    hr { border: none; border-top: 1px solid #222; margin: 2rem 0; }
  </style>
</head>
<body>
  <article>
    <header>
      <h1>${escapedTitle}</h1>
      ${escapedSubtitle ? `<p class="subtitle">${escapedSubtitle}</p>` : ""}
      <div class="meta">
        ${author ? `<span>${author}</span>` : ""}
        ${date ? `<span>${date}</span>` : ""}
      </div>
    </header>
    ${articleHtml}
  </article>
</body>
</html>`;

      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", "text/html; charset=utf-8");
      responseHeaders.set("Cache-Control", accessType === "public" ? "public, max-age=3600" : "private, max-age=3600");
      for (const [k, v] of Object.entries(fairHeaders)) {
        responseHeaders.set(k, v);
      }
      return new NextResponse(html, { status: 200, headers: responseHeaders });
    }
  }

  // 5b. Thumbnail generation for images (?w=<pixels>)
  let outputBuffer: Buffer = fileBuffer;
  const outputMime = asset.mimeType;

  if (widthParam && asset.mimeType.startsWith("image/")) {
    try {
      const sharp = (await import("sharp")).default;
      outputBuffer = await sharp(fileBuffer)
        .rotate() // auto-orient from EXIF before resize
        .resize({ width: Number.parseInt(widthParam, 10), withoutEnlargement: true })
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
      ...fairHeaders,
    });
  }

  if (accessType === "public") {
    // Resized variants: 1 hour (sellers may update images)
    // Originals: 24 hours (raw file doesn't change)
    headers.set("Cache-Control", isResized ? "public, max-age=3600" : "public, max-age=86400");
  } else {
    headers.set("Cache-Control", "private, max-age=3600");
  }

  // Add .fair sidecar headers
  for (const [k, v] of Object.entries(fairHeaders)) {
    headers.set(k, v);
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
// DELETE /api/assets/[id] — soft-delete asset + files (owner only)
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
  const { identity } = authResult;

  // Approval gate: agents cannot delete via delegation
  if (identity.actingFor) {
    return NextResponse.json({
      error: "Agent delegation does not permit destructive operations",
      code: "AGENT_APPROVAL_REQUIRED",
      action: "delete",
      assetId: id,
      ownerDid: identity.actingFor,
    }, { status: 403 });
  }

  const requesterDid = resolveActingDid(identity);

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

  if (asset?.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Immutability check
  if (asset.immutable) {
    return NextResponse.json({ error: "Immutable asset — cannot delete" }, { status: 403 });
  }

  // Remove files from disk (best-effort — don't fail if already gone)
  try { await unlink(asset.storagePath); } catch {}
  if (asset.fairPath) {
    try { await unlink(asset.fairPath); } catch {}
  }

  // Soft-delete: mark status='deleted' rather than removing the DB row.
  // The row stays for audit trail (settlements, accessLog reference assetId
  // as a plain string with no FK — they are intentionally left intact as
  // financial/audit records). Lore GC will reclaim the blob chunks.
  await db
    .update(assets)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(eq(assets.id, id));

  // Tombstone asset_references rows — these are live dependency trackers,
  // not financial records. Once the asset is gone they're stale.
  await db.delete(assetReferences).where(eq(assetReferences.assetId, id));

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
  const { identity } = authResult;

  // Approval gate: agents cannot rename via delegation
  if (identity.actingFor) {
    return NextResponse.json({
      error: "Agent delegation does not permit destructive operations",
      code: "AGENT_APPROVAL_REQUIRED",
      action: "rename",
      assetId: id,
      ownerDid: identity.actingFor,
    }, { status: 403 });
  }

  const requesterDid = resolveActingDid(identity);

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

  if (asset?.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Immutability check
  if (asset.immutable) {
    return NextResponse.json({ error: "Immutable asset — cannot rename" }, { status: 403 });
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
