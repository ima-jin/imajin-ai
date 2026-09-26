import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { db, assets, type Asset } from "@/src/db";
import { requireMediaAuth } from "@/src/lib/media/require-media-auth";
import { eq } from "drizzle-orm";
import { updateAssetContent } from "@/src/lib/media/update-asset";
import { createLogger } from "@imajin/logger";
import type { FairManifest } from "@imajin/fair";
import { getAccessType, type AssetAccessType } from "@/src/lib/media/read-access";
import { authorizeAssetRead } from "@/src/lib/media/authorize-read";
import { articleWarningFields } from "@/src/lib/media/article-guard";

const log = createLogger("kernel");

/**
 * Authorize a non-public content read (#2393). Callers must already know
 * `accessType !== "public"` — a public asset's content is readable with no
 * auth at all, mirroring GET /media/api/assets/[id] (raw bytes), which never
 * calls its own equivalent auth check for a public asset either.
 *
 * Two paths, tried in the same order the pre-existing code did:
 *   1. The internal API key (server-to-server): allowed for trust-graph only
 *      now that public short-circuits before this function is ever called.
 *   2. `requireMediaAuth` — a scoped app-token (Authorization: Bearer, #2393)
 *      OR the pre-existing session cookie / legacy Bearer PAT — honoring the
 *      shared read-access decision: owner, trust-graph grant (#1167), or
 *      conversation membership (#1168).
 */
async function authorizeContentRead(
  request: NextRequest,
  asset: Asset,
  access: FairManifest["access"],
  accessType: AssetAccessType,
): Promise<NextResponse | null> {
  const internalApiKey = process.env.MEDIA_INTERNAL_API_KEY;
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (bearerToken && internalApiKey &&
      bearerToken.length === internalApiKey.length &&
      timingSafeEqual(Buffer.from(bearerToken), Buffer.from(internalApiKey))) {
    if (accessType !== "trust-graph") {
      return NextResponse.json(
        { error: "Access denied", reason: "Asset is private" },
        { status: 403 }
      );
    }
    return null;
  }

  const authResult = await requireMediaAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const decision = await authorizeAssetRead(
    { ownerDid: asset.ownerDid, access, metadata: asset.metadata },
    authResult.auth.did,
  );
  if (!decision.allowed) {
    return NextResponse.json({ error: "Forbidden", reason: decision.reason }, { status: 403 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/assets/[id]/content — read text content of a file
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

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

  // Only serve text/* and application/json
  const isReadable =
    asset.mimeType.startsWith("text/") || asset.mimeType === "application/json";
  if (!isReadable) {
    return NextResponse.json(
      { error: "Not a text file", mimeType: asset.mimeType },
      { status: 415 }
    );
  }

  // Determine .fair access level
  const manifest = asset.fairManifest as FairManifest | null;
  const access = manifest?.access ?? "private";
  const accessType = getAccessType(access);

  // #2393: align with GET /media/api/assets/[id] (raw bytes) — a public
  // asset's parsed content is readable with no auth, matching its raw bytes.
  if (accessType !== "public") {
    const denied = await authorizeContentRead(request, asset, access, accessType);
    if (denied) return denied;
  }

  let content: string;
  try {
    content = await readFile(asset.storagePath, "utf-8");
  } catch {
    return NextResponse.json({ error: "File not found on storage" }, { status: 404 });
  }

  return NextResponse.json({ content, filename: asset.filename });
}

// ---------------------------------------------------------------------------
// PUT /api/assets/[id]/content — overwrite text file content (owner only)
// ---------------------------------------------------------------------------
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // #2393: accepts a scoped app-token alongside the session cookie / legacy
  // Bearer PAT — additive, see requireMediaAuth's own docblock.
  const authResult = await requireMediaAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const requesterDid = authResult.auth.did;

  let body: { content?: unknown; strict?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { content } = body;
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }
  // Opt-in hard gate for the article-frontmatter guard (#1542); default is warn.
  const strict = body.strict === true;

  // Owner-only content overwrite + versioning, shared with the media_update MCP
  // tool (#1170). The route keeps HTTP concerns (auth, body parse, content type);
  // updateAssetContent owns authorization + the write/CID/Lore/.fair/versionCount
  // pipeline.
  const result = await updateAssetContent({ assetId: id, requesterDid, content, strict });
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "forbidden":
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      case "immutable":
        return NextResponse.json({ error: result.message }, { status: 403 });
      case "unsupported_media":
        return NextResponse.json({ error: result.message }, { status: 415 });
      case "article_frontmatter_required":
        // strict: true — refuse to write content that would null the projection.
        return NextResponse.json(
          { error: result.message, articleProjection: null },
          { status: 400 },
        );
      case "storage_failed":
        return NextResponse.json({ error: "File write failed" }, { status: 500 });
      case "db_failed":
        return NextResponse.json({ error: result.message }, { status: 500 });
    }
  }

  // Warn (default) when the write left metadata.article null despite article
  // intent — including the dangerous case where it demoted a live article.
  return NextResponse.json({ ok: true, ...articleWarningFields(result.articleWarning ?? null) });
}
