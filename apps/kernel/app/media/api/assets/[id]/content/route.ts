import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { db, assets } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import type { FairManifest, FairManifestV1_1 } from "@imajin/fair";
import { isFairManifestV1_1 } from "@imajin/fair";
import { computeCid } from "@imajin/cid";
import { contentSigner } from "@/src/lib/media/content-signer";
import { blobStore } from "@/src/lib/media/blob-store-lore";
import { createLogger } from "@imajin/logger";

const log = createLogger("kernel");

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
  const manifest = asset.fairManifest;
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
    if ((resolveActingDid(authResult.identity)) !== asset.ownerDid) {
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

  // Immutability guard — locked assets cannot have their content edited
  if (asset.immutable) {
    return NextResponse.json(
      { error: "Immutable asset — content cannot be edited" },
      { status: 403 }
    );
  }

  try {
    await writeFile(asset.storagePath, content, "utf-8");
  } catch (err) {
    log.error({ err: String(err) }, "File write failed");
    return NextResponse.json({ error: "File write failed" }, { status: 500 });
  }

  const hash = createHash("sha256").update(content).digest("hex");
  const size = Buffer.byteLength(content, "utf-8");

  // New CID for this version of the content (#1122 Bundle 3 — new CID per edit).
  // The alias (asset_xxx) stays the same; the CID tracks the current content state.
  const cid = await computeCid(new Uint8Array(Buffer.from(content, "utf-8")));

  // Register new revision in Lore and capture the revision hash (non-fatal).
  // loreRef now points to the Lore revision for THIS version of the content;
  // prior versions are soft-superseded (chunks retained in Lore's immutable store).
  const blobRef = await blobStore
    .put(asset.ownerDid, asset.storagePath, { assetId: id, sizeBytes: size })
    .catch((err: unknown) => {
      log.error({ err: String(err), assetId: id }, "Lore put after content edit failed (non-fatal)");
      return null;
    });

  // Re-sign .fair manifest so the signature covers the current content state.
  // Non-fatal: if signing fails the content is still saved; the manifest will
  // be re-signed on the next explicit PUT /fair or on the next upload.
  let updatedFairManifest = asset.fairManifest as Record<string, unknown> | undefined;
  const rawManifest = asset.fairManifest as Record<string, unknown> | null;
  if (rawManifest && isFairManifestV1_1(rawManifest)) {
    await contentSigner
      .sign(rawManifest as unknown as FairManifestV1_1)
      .then(async (signed) => {
        updatedFairManifest = signed as unknown as Record<string, unknown>;
        if (asset.fairPath) {
          await writeFile(asset.fairPath, JSON.stringify(signed, null, 2)).catch(
            (err: unknown) =>
              log.warn({ err: String(err), assetId: id }, "Could not write re-signed .fair to disk (non-fatal)")
          );
        }
      })
      .catch((err: unknown) =>
        log.warn({ err: String(err), assetId: id }, "Could not re-sign .fair after content edit (non-fatal)")
      );
  }

  await db
    .update(assets)
    .set({
      hash,
      size,
      cid,
      loreRef: blobRef?.loreRef ?? asset.loreRef,  // keep prior ref if Lore put failed
      fairManifest: updatedFairManifest ?? asset.fairManifest,
      updatedAt: new Date(),
    })
    .where(eq(assets.id, id));

  return NextResponse.json({ ok: true });
}
