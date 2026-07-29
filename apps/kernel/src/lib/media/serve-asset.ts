import { stat, open, readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import type { FairManifest } from "@imajin/fair";
import type { Asset } from "@/src/db";
import { createLogger } from "@imajin/logger";
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
import { type AssetAccessType } from "@/src/lib/media/read-access";
import { authorizeAssetRead } from "@/src/lib/media/authorize-read";
import {
  respondUnauthorized,
  respondForbidden,
} from "@/src/lib/http/route-response";

const log = createLogger("kernel");

// ---------------------------------------------------------------------------
// Range-aware file serving
// ---------------------------------------------------------------------------

/**
 * Serve a file with HTTP Range support (needed for video seeking/scrubbing).
 * Falls back to a full 200 response when no Range header is present.
 *
 * Moved from GET /media/api/assets/[id] as part of the family-① Sonar sweep
 * (issue #1467).
 */
export async function serveFileWithRange(
  request: NextRequest,
  filePath: string,
  contentType: string,
  extraHeaders?: Record<string, string>,
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

  const fileBuffer = await readFile(filePath);
  headers.set("Content-Length", String(fileSize));
  return new NextResponse(new Uint8Array(fileBuffer), { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Video quality variant serving
// ---------------------------------------------------------------------------

/**
 * Serve a specific video quality variant, kicking off transcoding if needed.
 * Returns 202 Accepted (with Retry-After) while transcoding is in progress.
 */
export async function handleVideoQuality(
  request: NextRequest,
  asset: Asset,
  quality: VideoQuality,
): Promise<NextResponse> {
  if (await variantExists(asset.storagePath, quality)) {
    return serveFileWithRange(request, getVariantPath(asset.storagePath, quality), "video/mp4", {
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  }

  if (isTranscoding(asset.storagePath, quality)) {
    return NextResponse.json(
      { status: "transcoding", quality, retryAfter: 30 },
      { status: 202, headers: { "Retry-After": "30" } },
    );
  }

  // Kick off transcode fire-and-forget
  transcodeVideo(asset.storagePath, quality).catch((err) =>
    log.error({ err: String(err), storagePath: asset.storagePath, quality }, "Background transcode error"),
  );
  return NextResponse.json(
    { status: "transcoding", quality, retryAfter: 30 },
    { status: 202, headers: { "Retry-After": "30" } },
  );
}

// ---------------------------------------------------------------------------
// Markdown article HTML rendering
// ---------------------------------------------------------------------------

/** Strip the leading H1 heading from a markdown body (avoids duplicate title rendering). */
function stripLeadingH1(body: string): string {
  const lines = body.split("\n");
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start += 1;
  if (start < lines.length && lines[start].startsWith("# ")) {
    start += 1;
    while (start < lines.length && lines[start].trim() === "") start += 1;
  }
  return lines.slice(start).join("\n");
}

/** Build the full article HTML page from parsed frontmatter and rendered body. */
function buildArticleHtml(
  fm: Record<string, unknown>,
  articleHtml: string,
): string {
  const esc = (s: string) =>
    s.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  const escapedTitle = esc(typeof fm.title === "string" ? fm.title : "");
  const escapedSubtitle = typeof fm.subtitle === "string" ? esc(fm.subtitle) : "";
  const escapedDesc = typeof fm.description === "string" ? esc(fm.description) : "";
  const author = typeof fm.author === "string" ? fm.author : "";
  const date = typeof fm.date === "string"
    ? new Date(fm.date).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";

  return `<!DOCTYPE html>
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
}

/**
 * Render a markdown asset as an HTML article page for browser clients.
 *
 * Returns `null` when the request should fall through to binary serving:
 * - MIME type is not text/markdown
 * - `?download=true` is set
 * - Accept: application/octet-stream (raw bytes requested)
 * - Frontmatter does not carry a `title` field
 */
export async function serveMarkdown(
  request: NextRequest,
  asset: Asset,
  fileBuffer: Buffer,
  accessType: AssetAccessType,
  fairHeaders: Record<string, string>,
): Promise<NextResponse | null> {
  const { searchParams } = new URL(request.url);
  const download = searchParams.get("download") === "true";

  if (asset.mimeType !== "text/markdown") return null;
  if (download) return null;
  if (request.headers.get("accept") === "application/octet-stream") return null;

  const matter = (await import("gray-matter")).default;
  const { data: fm, content: body } = matter(fileBuffer.toString("utf-8"));

  if (!fm.title) return null;

  const { remark } = await import("remark");
  const remarkGfm = (await import("remark-gfm")).default;
  const remarkHtml = (await import("remark-html")).default;

  const processed = await remark()
    .use(remarkGfm)
    .use(remarkHtml, { sanitize: false })
    .process(stripLeadingH1(body));

  const html = buildArticleHtml(fm as Record<string, unknown>, processed.toString());

  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Cache-Control",
    accessType === "public" ? "public, max-age=3600" : "private, max-age=3600",
  );
  for (const [k, v] of Object.entries(fairHeaders)) headers.set(k, v);
  return new NextResponse(html, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Access check helper (reusable for family-① route sweep)
// ---------------------------------------------------------------------------

/**
 * Authorize a READ request for an asset.
 *
 * Returns `null` when access is granted. Returns a terminal `NextResponse`
 * (401 or 403) when access is denied — respecting HTML vs JSON content
 * negotiation.
 *
 * Callers that already know the asset is `public` should skip this function
 * entirely.
 */
export async function checkAssetReadAccess(
  request: NextRequest,
  asset: Asset,
  access: FairManifest["access"],
): Promise<NextResponse | null> {
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return respondUnauthorized(request, request.nextUrl.pathname);
  }

  const requesterDid = resolveActingDid(authResult.identity);
  const decision = await authorizeAssetRead(
    { ownerDid: asset.ownerDid, access, metadata: asset.metadata },
    requesterDid,
  );

  if (!decision.allowed) {
    const [title, message] =
      decision.accessType === "trust-graph"
        ? [
            "Access Restricted",
            "This asset is only accessible to members of the owner's trust graph.",
          ]
        : ["Private Asset", "This asset is private and only accessible to its owner."];
    return respondForbidden(request, title, message, "Access denied", decision.reason);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cache-Control resolution
// ---------------------------------------------------------------------------

function resolveCacheControl(accessType: AssetAccessType, isResized: boolean): string {
  if (accessType !== "public") return "private, max-age=3600";
  // Resized variants: 1 hour (sellers may update images)
  // Originals: 24 hours (raw file doesn't change)
  return isResized ? "public, max-age=3600" : "public, max-age=86400";
}

// ---------------------------------------------------------------------------
// Unified asset response
// ---------------------------------------------------------------------------

/**
 * Build the final HTTP response for a successfully authorized asset GET.
 *
 * Handles (in order):
 * 1. Video quality variant serving (`?quality=720p`)
 * 2. Markdown article HTML rendering for browser clients
 * 3. Image thumbnail generation (`?w=<px>`)
 * 4. ETag / 304 conditional GET
 * 5. Video range-aware serving
 * 6. Regular binary file response
 *
 * Extracted from GET /media/api/assets/[id] as part of the family-①
 * Sonar sweep (issue #1467).
 */
export async function serveAssetResponse(
  request: NextRequest,
  asset: Asset,
  fileBuffer: Buffer,
  accessType: AssetAccessType,
  fairHeaders: Record<string, string>,
): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const widthParam = searchParams.get("w");
  const qualityParam = searchParams.get("quality") as VideoQuality | null;
  const download = searchParams.get("download") === "true";

  // 1. Video quality variant
  const isVideoQualityRequest =
    qualityParam !== null &&
    asset.mimeType.startsWith("video/") &&
    (VIDEO_QUALITIES as readonly string[]).includes(qualityParam);
  if (isVideoQualityRequest) {
    return handleVideoQuality(request, asset, qualityParam as VideoQuality);
  }

  // 2. Markdown article HTML for browsers
  const markdownResponse = await serveMarkdown(request, asset, fileBuffer, accessType, fairHeaders);
  if (markdownResponse) return markdownResponse;

  // 3. Image thumbnail generation
  let outputBuffer: Buffer = fileBuffer;
  if (widthParam && asset.mimeType.startsWith("image/")) {
    try {
      const sharp = (await import("sharp")).default;
      outputBuffer = await sharp(fileBuffer)
        .rotate()
        .resize({ width: Number.parseInt(widthParam, 10), withoutEnlargement: true })
        .toBuffer();
    } catch {
      // sharp unavailable or failed — fall through with original
    }
  }

  // 4. ETag / conditional GET (include resize params so variants cache separately)
  const isResized = !!widthParam;
  const etag = isResized ? `"${asset.hash}-w${widthParam}"` : `"${asset.hash}"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new NextResponse(null, { status: 304 });
  }

  // 5. Video: range-aware serving for seeking/scrubbing
  if (asset.mimeType.startsWith("video/") && !isResized) {
    const variants = await getAvailableVariants(asset.storagePath);
    const transcoding = getTranscodingStatus(asset.storagePath);
    return serveFileWithRange(request, asset.storagePath, asset.mimeType, {
      ETag: etag,
      "X-Fair-Access": accessType,
      "X-Variants": JSON.stringify(variants),
      "X-Transcoding": JSON.stringify(transcoding),
      "Cache-Control": resolveCacheControl(accessType, false),
      ...fairHeaders,
    });
  }

  // 6. Regular binary response
  const headers = new Headers();
  headers.set("Content-Type", asset.mimeType);
  headers.set("ETag", etag);
  headers.set("X-Fair-Access", accessType);
  headers.set("Cache-Control", resolveCacheControl(accessType, isResized));
  for (const [k, v] of Object.entries(fairHeaders)) headers.set(k, v);
  headers.set("Content-Length", String(outputBuffer.length));

  if (download) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(asset.filename)}"`,
    );
  }

  return new NextResponse(new Uint8Array(outputBuffer), { status: 200, headers });
}
