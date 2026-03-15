import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { db, assets } from "@/src/db";
import { requireAuth } from "@/src/lib/auth";
import { eq } from "drizzle-orm";
import type { FairManifest } from "@imajin/fair";

function getAccessType(access: FairManifest["access"]): string {
  if (!access) return "private";
  if (typeof access === "string") return access;
  return access.type ?? "private";
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
    console.error("DB lookup failed:", err);
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (!asset || asset.status !== "active") {
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
  const accessType = getAccessType(manifest?.access ?? "private");

  // Internal API key auth: allow read for public/trust-graph assets
  const internalApiKey = process.env.MEDIA_INTERNAL_API_KEY;
  const authHeader = request.headers.get("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (bearerToken && internalApiKey && bearerToken === internalApiKey) {
    if (accessType !== "public" && accessType !== "trust-graph") {
      return NextResponse.json(
        { error: "Access denied", reason: "Asset is private" },
        { status: 403 }
      );
    }
  } else {
    // Fall through to cookie auth — owner always allowed
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    if (authResult.identity.id !== asset.ownerDid) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
  const requesterDid = authResult.identity.id;

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

  try {
    await writeFile(asset.storagePath, content, "utf-8");
  } catch (err) {
    console.error("File write failed:", err);
    return NextResponse.json({ error: "File write failed" }, { status: 500 });
  }

  const hash = createHash("sha256").update(content).digest("hex");
  const size = Buffer.byteLength(content, "utf-8");

  await db
    .update(assets)
    .set({ hash, size, updatedAt: new Date() })
    .where(eq(assets.id, id));

  return NextResponse.json({ ok: true });
}
