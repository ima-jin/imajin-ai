import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { db, assets } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { computeCid } from "@imajin/cid";
import type { FairManifest } from "@imajin/fair";
import { createLogger } from "@imajin/logger";
import { corsHeaders } from "@/src/lib/kernel/cors";

const log = createLogger("kernel");

function getAccessType(access: FairManifest["access"]): string {
  if (!access) return "private";
  if (typeof access === "string") return access;
  return access.type ?? "private";
}

function getAllowedDids(access: FairManifest["access"]): string[] {
  if (!access || typeof access === "string") return [];
  return (access as { allowedDids?: string[] }).allowedDids ?? [];
}

// ---------------------------------------------------------------------------
// GET /api/assets/[id]/verify — content integrity verification
//
// Re-derives the CID from the file bytes on disk and compares it to the
// stored `assets.cid`. Returns the verification result.
//
// Access control: same rules as GET /api/assets/[id] — if you can read
// the asset, you can verify its integrity.
//
// Response:
//   { valid: true,  cid, storedCid, verifiedAt }
//   { valid: false, cid, storedCid, reason, verifiedAt }
//
// `storedCid` is null for pre-Bundle-2 assets (no CID was computed on upload).
// In that case `valid` is false with reason "no_stored_cid".
// ---------------------------------------------------------------------------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const cors = corsHeaders(request);
  const { id } = await params;

  // 1. Load asset
  let asset;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500, headers: cors });
  }

  if (asset?.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: cors });
  }

  // 2. Access control (mirrors GET /api/assets/[id] — same read rules)
  const manifest = asset.fairManifest as FairManifest | null;
  const access = manifest?.access ?? "private";
  const accessType = getAccessType(access);

  if (accessType !== "public") {
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401, headers: cors });
    }
    const callerDid = resolveActingDid(authResult.identity);

    if (accessType === "private" && callerDid !== asset.ownerDid) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cors });
    }
    if (accessType === "trust-graph") {
      const allowed = getAllowedDids(access);
      if (callerDid !== asset.ownerDid && !allowed.includes(callerDid)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: cors });
      }
    }
  }

  // 3. Read file bytes from disk
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(asset.storagePath);
  } catch {
    return NextResponse.json({ error: "File not found on storage" }, { status: 404, headers: cors });
  }

  // 4. Re-derive CID from current bytes on disk
  const derivedCid = await computeCid(new Uint8Array(fileBuffer));
  const storedCid = asset.cid ?? null;
  const verifiedAt = new Date().toISOString();

  // 5. Compare and return result
  if (!storedCid) {
    return NextResponse.json(
      {
        valid: false,
        reason: "no_stored_cid",
        details: "Asset was uploaded before content-addressing was enabled (Bundle 2). Re-upload to get a CID.",
        cid: derivedCid,
        storedCid: null,
        verifiedAt,
      },
      { status: 200, headers: cors },
    );
  }

  if (derivedCid === storedCid) {
    return NextResponse.json(
      { valid: true, cid: derivedCid, storedCid, verifiedAt },
      { status: 200, headers: cors },
    );
  }

  // CID mismatch — file on disk doesn't match what was stored
  log.warn(
    { assetId: id, storedCid, derivedCid },
    "CID verification failed — file bytes do not match stored CID",
  );
  return NextResponse.json(
    {
      valid: false,
      reason: "cid_mismatch",
      details: "The file on disk does not match the stored content CID. The file may have been modified outside of Imajin.",
      cid: derivedCid,
      storedCid,
      verifiedAt,
    },
    { status: 200, headers: cors },
  );
}
