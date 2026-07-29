import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink, rename } from "node:fs/promises";
import path from "node:path";
import { db, assets, assetReferences } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import { getAccessType } from "@/src/lib/media/read-access";
import { getActiveAsset } from "@/src/lib/media/queries";
import { resolveManifest, buildFairHeaders } from "@/src/lib/media/resolve-manifest";
import { determineAction, handleSettlement } from "@/src/lib/media/settle";
import { checkAssetReadAccess, serveAssetResponse } from "@/src/lib/media/serve-asset";

const log = createLogger("kernel");

// ---------------------------------------------------------------------------
// GET /api/assets/[id] — serve asset file with .fair access control
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // 1. Resolve asset
  let asset;
  try {
    asset = await getActiveAsset(id);
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }
  if (!asset) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 2. Resolve manifest + compute access
  const manifest = await resolveManifest(asset);
  const access = manifest?.access ?? "private";
  const accessType = getAccessType(access);
  const fairHeaders = buildFairHeaders(id, manifest, asset.fairDfosEventId ?? null);

  // 3. Authorization (public assets skip auth entirely)
  if (accessType !== "public") {
    const deny = await checkAssetReadAccess(request, asset, access);
    if (deny) return deny;
  }

  // 4. Determine action and handle settlement
  const action = determineAction(request, asset.mimeType);
  const settlementDeny = await handleSettlement(request, id, manifest, action);
  if (settlementDeny) return settlementDeny;

  // 5. Read file from storage
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(asset.storagePath);
  } catch {
    return NextResponse.json({ error: "File not found on storage" }, { status: 404 });
  }

  // 6. Serve with content negotiation
  return serveAssetResponse(request, asset, fileBuffer, accessType, fairHeaders);
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
