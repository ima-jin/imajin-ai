import { NextRequest, NextResponse } from "next/server";
import { readFile, unlink } from "node:fs/promises";
import { db, assets, assetReferences } from "@/src/db";
import { requireMediaAuth, mediaAuthErrorResponse, agentApprovalRequiredResponse } from "@/src/lib/media/require-media-auth";
import { eq } from "drizzle-orm";
import { createLogger } from "@imajin/logger";
import { getAccessType } from "@/src/lib/media/read-access";
import { getActiveAsset } from "@/src/lib/media/queries";
import { resolveManifest, buildFairHeaders } from "@/src/lib/media/resolve-manifest";
import { determineAction, handleSettlement } from "@/src/lib/media/settle";
import { checkAssetReadAccess, serveAssetResponse } from "@/src/lib/media/serve-asset";
import { validateFilename } from "@/src/lib/media/safe-path";

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

  // #2393: accepts a scoped app-token (requires `media:write`) alongside the
  // session cookie / legacy Bearer PAT — additive, see requireMediaAuth's
  // own docblock.
  const authResult = await requireMediaAuth(request, "media:write");
  if ("error" in authResult) {
    return mediaAuthErrorResponse(authResult);
  }
  const { auth } = authResult;

  const approvalRequired = agentApprovalRequiredResponse(auth, "delete", id);
  if (approvalRequired) return approvalRequired;

  const requesterDid = auth.did;

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
//
// #2681: `filename` is a display name only. The on-disk name
// (`{assetId}{ext}`) never depends on it, so rename updates the `filename`
// column and leaves `storagePath` / `fairPath` alone — nothing on disk moves,
// so nothing can be overwritten or escape the owner folder. The name is still
// validated as a single safe segment because other code (downloads, legacy
// fallbacks) treats it as a filename.
// ---------------------------------------------------------------------------
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // #2393: accepts a scoped app-token (requires `media:write`) alongside the
  // session cookie / legacy Bearer PAT — additive, see requireMediaAuth's
  // own docblock.
  const authResult = await requireMediaAuth(request, "media:write");
  if ("error" in authResult) {
    return mediaAuthErrorResponse(authResult);
  }
  const { auth } = authResult;

  const approvalRequired = agentApprovalRequiredResponse(auth, "rename", id);
  if (approvalRequired) return approvalRequired;

  const requesterDid = auth.did;

  let body: { filename?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const check = validateFilename(body.filename);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }
  const newFilename = check.filename;

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

  await db.update(assets).set({ filename: newFilename }).where(eq(assets.id, id));

  return NextResponse.json({ ok: true, filename: newFilename });
}
