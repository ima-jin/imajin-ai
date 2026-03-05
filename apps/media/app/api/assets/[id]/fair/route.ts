import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { db, assets } from "@/src/db";
import { requireAuth } from "@/src/lib/auth";
import { eq } from "drizzle-orm";
import type { FairManifest } from "@imajin/fair";

function getAccessType(
  access: FairManifest["access"]
): "public" | "private" | "trust-graph" {
  if (!access) return "private";
  if (access === "public") return "public";
  if (access === "private") return "private";
  return access.type;
}

function getAllowedDids(access: FairManifest["access"]): string[] {
  if (!access || typeof access === "string") return [];
  return access.allowedDids ?? [];
}

// ---------------------------------------------------------------------------
// GET /api/assets/[id]/fair — return .fair manifest (same access rules apply)
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
    console.error("DB lookup failed:", err);
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (!asset || asset.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 2. Get .fair manifest
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
      // No manifest on disk
    }
  }

  if (!manifest) {
    return NextResponse.json(
      { error: "No .fair manifest found for this asset" },
      { status: 404 }
    );
  }

  const access = manifest.access ?? "private";
  const accessType = getAccessType(access);

  // 3. Access control (same rules as the asset itself)
  if (accessType !== "public") {
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: "Access denied", reason: "Authentication required" },
        { status: 403 }
      );
    }
    const requesterDid = authResult.identity.id;

    if (accessType === "private") {
      if (requesterDid !== asset.ownerDid) {
        return NextResponse.json(
          { error: "Access denied", reason: "Private asset — owner only" },
          { status: 403 }
        );
      }
    } else if (accessType === "trust-graph") {
      const allowedDids = getAllowedDids(access);
      if (
        requesterDid !== asset.ownerDid &&
        !allowedDids.includes(requesterDid)
      ) {
        return NextResponse.json(
          { error: "Access denied", reason: "Not in trust graph" },
          { status: 403 }
        );
      }
    }
  }

  return NextResponse.json(manifest, {
    headers: { "X-Fair-Access": accessType },
  });
}
