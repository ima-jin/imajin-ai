import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { db, assets } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { updateAssetContent } from "@/src/lib/media/update-asset";
import { createLogger } from "@imajin/logger";
import type { FairManifest } from "@imajin/fair";
import { getAccessType } from "@/src/lib/media/read-access";
import { authorizeAssetRead } from "@/src/lib/media/authorize-read";

const log = createLogger("kernel");

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

  // Internal API key auth: allow read for public/trust-graph assets
  const internalApiKey = process.env.MEDIA_INTERNAL_API_KEY;
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (bearerToken && internalApiKey &&
      bearerToken.length === internalApiKey.length &&
      timingSafeEqual(Buffer.from(bearerToken), Buffer.from(internalApiKey))) {
    if (accessType !== "public" && accessType !== "trust-graph") {
      return NextResponse.json(
        { error: "Access denied", reason: "Asset is private" },
        { status: 403 }
      );
    }
  } else {
    // Cookie auth — honor the shared read-access decision: owner, public,
    // trust-graph grant (#1167), or conversation membership (#1168).
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const requesterDid = resolveActingDid(authResult.identity);
    const decision = await authorizeAssetRead(
      { ownerDid: asset.ownerDid, access, metadata: asset.metadata },
      requesterDid,
    );
    if (!decision.allowed) {
      return NextResponse.json({ error: "Forbidden", reason: decision.reason }, { status: 403 });
    }
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

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const requesterDid = resolveActingDid(authResult.identity);

  let body: { content?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { content } = body;
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  // Owner-only content overwrite + versioning, shared with the media_update MCP
  // tool (#1170). The route keeps HTTP concerns (auth, body parse, content type);
  // updateAssetContent owns authorization + the write/CID/Lore/.fair/versionCount
  // pipeline.
  const result = await updateAssetContent({ assetId: id, requesterDid, content });
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
      case "storage_failed":
        return NextResponse.json({ error: "File write failed" }, { status: 500 });
      case "db_failed":
        return NextResponse.json({ error: result.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
