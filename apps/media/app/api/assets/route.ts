import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { extname } from "path";
import { nanoid } from "nanoid";
import { db, assets, folders, assetFolders } from "@/src/db";
import { requireAuth } from "@/src/lib/auth";
import { corsHeaders, corsOptions } from "@/src/lib/cors";
import { eq, and } from "drizzle-orm";
import { classifyAsset } from "@/src/lib/classify";
import { rateLimit, getClientIP } from "@/src/lib/rate-limit";

// Context → folder mapping
const CONTEXT_FOLDER_MAP: Record<string, { name: string; icon: string }> = {
  bugs: { name: "Bug Reports", icon: "🐛" },
  chat: { name: "Chat", icon: "💬" },
  profile: { name: "Profile", icon: "👤" },
  events: { name: "Events", icon: "🎫" },
};

export const dynamic = "force-dynamic";

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

const MEDIA_ROOT = process.env.MEDIA_ROOT || "/mnt/media";
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

const ALLOWED_MIME_PREFIXES = ["image/", "audio/", "video/", "text/"];
const ALLOWED_MIME_EXACT = ["application/pdf"];

/** Map file extensions to MIME types for files browsers send as octet-stream */
const EXT_TO_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".xml": "text/xml",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function inferMime(browserMime: string, filename: string): string {
  // If the browser gave us a real type, trust it
  if (browserMime && browserMime !== "application/octet-stream") {
    return browserMime;
  }
  // Infer from extension
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return EXT_TO_MIME[ext] || browserMime || "application/octet-stream";
}

function isAllowedMime(mime: string): boolean {
  if (ALLOWED_MIME_EXACT.includes(mime)) return true;
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

/** Replace chars that are unsafe on most filesystems */
function didToPath(did: string): string {
  return did.replace(/:/g, "_").replace(/[^a-zA-Z0-9._@-]/g, "_");
}

// ---------------------------------------------------------------------------
// POST /api/assets — upload a file
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 20, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, "Retry-After": String(rl.retryAfter) } }
    );
  }

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const ownerDid = identity.id;

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing file field" }, { status: 400 });
  }

  // Size check
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: "File exceeds 50 MB limit" },
      { status: 413 }
    );
  }

  // Extract original filename first (needed for MIME inference)
  const originalName =
    (formData.get("filename") as string | null) ??
    (file as File).name ??
    "upload";

  // MIME check — infer from extension if browser sent octet-stream
  const mimeType = inferMime(file.type, originalName);
  if (!isAllowedMime(mimeType)) {
    return NextResponse.json(
      { error: `MIME type ${mimeType} is not allowed` },
      { status: 415 }
    );
  }

  // Parse optional context (for auto-folder assignment + access override)
  let context: { app?: string; feature?: string; entityId?: string; access?: string } | null = null;
  const contextRaw = formData.get("context");
  if (contextRaw && typeof contextRaw === "string") {
    try { context = JSON.parse(contextRaw); } catch { /* ignore bad JSON */ }
  }

  const assetId = `asset_${nanoid(16)}`;
  const ext = extname(originalName) || "";

  // Read file bytes
  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  // SHA-256 hash
  const hash = createHash("sha256").update(buffer).digest("hex");

  // Storage path: {MEDIA_ROOT}/{didPath}/assets/{assetId}{ext}
  const didPath = didToPath(ownerDid);
  const dirPath = `${MEDIA_ROOT}/${didPath}/assets`;
  const storagePath = `${dirPath}/${assetId}${ext}`;
  const fairPath = `${dirPath}/${assetId}.fair.json`;

  // .fair manifest — allow context to override access (public only)
  const accessLevel = context?.access === "public" ? "public" : "private";
  const fairManifest = {
    fair: "1.0",
    id: assetId,
    type: mimeType,
    owner: ownerDid,
    created: new Date().toISOString(),
    source: "upload",
    access: { type: accessLevel },
    attribution: [{ did: ownerDid, role: "creator", share: 1.0 }],
    transfer: { allowed: false },
  };

  try {
    await mkdir(dirPath, { recursive: true });
    await writeFile(storagePath, buffer);
    await writeFile(fairPath, JSON.stringify(fairManifest, null, 2));
  } catch (err) {
    console.error("Storage write failed:", err);
    return NextResponse.json(
      { error: "Storage failure", detail: String(err) },
      { status: 500 }
    );
  }

  // Insert DB record
  let record;
  try {
    [record] = await db
      .insert(assets)
      .values({
        id: assetId,
        ownerDid,
        filename: originalName,
        mimeType,
        size: file.size,
        storagePath,
        hash,
        fairManifest,
        fairPath,
        status: "active",
        metadata: context ? { context } : {},
      })
      .returning();
  } catch (err) {
    console.error("DB insert failed:", err);
    return NextResponse.json(
      { error: "Database failure", detail: String(err) },
      { status: 500 }
    );
  }

  // Auto-assign to folder based on context
  if (context?.feature || context?.app) {
    const folderKey = context.feature || context.app || "";
    const folderConfig = CONTEXT_FOLDER_MAP[folderKey];
    if (folderConfig) {
      try {
        // Find or create the system folder for this user
        const existing = await db.select().from(folders).where(
          and(eq(folders.ownerDid, ownerDid), eq(folders.name, folderConfig.name), eq(folders.isSystem, true))
        ).limit(1);

        let folderId: string;
        if (existing.length > 0) {
          folderId = existing[0].id;
        } else {
          folderId = `folder_${nanoid(16)}`;
          await db.insert(folders).values({
            id: folderId,
            ownerDid,
            name: folderConfig.name,
            icon: folderConfig.icon,
            isSystem: true,
          });
        }

        // Link asset to folder
        await db.insert(assetFolders).values({ assetId, folderId }).onConflictDoNothing();
      } catch (err) {
        console.error("Auto-folder assignment failed (non-fatal):", err);
      }
    }
  }

  // Build public URL from request origin
  const origin = new URL(request.url).origin;
  const url = `${origin}/api/assets/${record.id}`;

  const response = NextResponse.json(
    {
      id: record.id,
      url,
      filename: record.filename,
      mimeType: record.mimeType,
      size: record.size,
      hash: record.hash,
      storagePath: record.storagePath,
      fairManifest: record.fairManifest,
      createdAt: record.createdAt,
    },
    { status: 201, headers: cors }
  );

  // Fire-and-forget async classification
  const existingMeta = record.metadata;
  classifyAsset(buffer, originalName, mimeType).then(async (result) => {
    await db.update(assets).set({
      classification: result.category,
      classificationConfidence: Math.round(result.confidence * 100),
      metadata: { ...(typeof existingMeta === "object" && existingMeta !== null ? existingMeta : {}), classification: result },
    }).where(eq(assets.id, assetId));
  }).catch(console.error);

  return response;
}

// ---------------------------------------------------------------------------
// GET /api/assets — list assets for authenticated user
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const { identity } = authResult;
  const ownerDid = identity.id;

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");         // e.g. "image"
  const sort = searchParams.get("sort") || "created";
  const order = searchParams.get("order") || "desc";
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  try {
    const { desc: drizzleDesc, asc: drizzleAsc } = await import("drizzle-orm");

    // Build where conditions
    const conditions = [eq(assets.ownerDid, ownerDid), eq(assets.status, "active")];

    // Type filter (mime prefix match)
    let rows = await db
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(
        order === "asc"
          ? drizzleAsc(assets.createdAt)
          : drizzleDesc(assets.createdAt)
      )
      .limit(limit)
      .offset(offset);

    // Post-filter by MIME prefix (simple; can be pushed to DB if needed)
    if (type) {
      rows = rows.filter((r) => r.mimeType.startsWith(`${type}/`));
    }

    return NextResponse.json({ assets: rows, limit, offset, count: rows.length }, { headers: cors });
  } catch (err) {
    console.error("DB query failed:", err);
    return NextResponse.json(
      { error: "Database failure", detail: String(err) },
      { status: 500, headers: cors }
    );
  }
}
