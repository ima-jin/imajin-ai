import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { db, assets } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import type { FairManifest, FairManifestV1_1 } from "@imajin/fair";
import { isFairManifestV1_1 } from "@imajin/fair";
import { signFairAsNode } from "@/src/lib/kernel/sign-fair-manifest";
import { createLogger } from "@imajin/logger";
import { renderFairHtml } from "@/src/lib/media/render-fair-html";
import { getAccessType } from "@/src/lib/media/read-access";
import { authorizeAssetRead } from "@/src/lib/media/authorize-read";

const log = createLogger("kernel");

/**
 * Load the .fair manifest for an asset: prefer the DB column, fall back to disk.
 */
async function loadFairManifest(
  asset: { fairManifest: unknown; fairPath: string | null }
): Promise<FairManifest | null> {
  if (
    asset.fairManifest &&
    typeof asset.fairManifest === "object" &&
    Object.keys(asset.fairManifest as object).length > 0
  ) {
    return asset.fairManifest as FairManifest;
  }
  if (asset.fairPath) {
    try {
      const raw = await readFile(asset.fairPath, "utf-8");
      return JSON.parse(raw) as FairManifest;
    } catch {
      // No manifest on disk — fall through to return null
    }
  }
  return null;
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
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (asset?.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 2. Get .fair manifest
  const manifest = await loadFairManifest(asset);
  if (!manifest) {
    return NextResponse.json(
      { error: "No .fair manifest found for this asset" },
      { status: 404 }
    );
  }

  const access = manifest.access ?? "private";
  const accessType = getAccessType(access);

  // 3. Access control (same rules as the asset itself, incl. conversation
  // membership #1168 and group/business identity_members membership #1851)
  if (accessType !== "public") {
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: "Access denied", reason: "Authentication required" },
        { status: 403 }
      );
    }
    const requesterDid = resolveActingDid(authResult.identity);
    const decision = await authorizeAssetRead(
      { ownerDid: asset.ownerDid, access, metadata: asset.metadata },
      requesterDid,
    );
    if (!decision.allowed) {
      return NextResponse.json(
        { error: "Access denied", reason: decision.reason },
        { status: 403 }
      );
    }
  }

  // Content negotiation: HTML for browsers, JSON for API consumers.
  // ?format=json forces JSON even from a browser.
  const wantsJson =
    request.nextUrl.searchParams.get("format") === "json" ||
    !request.headers.get("accept")?.includes("text/html");

  if (wantsJson) {
    return NextResponse.json(manifest, {
      headers: { "X-Fair-Access": accessType },
    });
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.MEDIA_PUBLIC_URL ||
    new URL(request.url).origin;

  const html = renderFairHtml(manifest, id, baseUrl);
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Fair-Access": accessType,
      "Cache-Control": "public, max-age=300",
    },
  });
}

// ---------------------------------------------------------------------------
// PUT /api/assets/[id]/fair — update .fair manifest (owner only)
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

  // Immutability guard
  if (asset.immutable) {
    return NextResponse.json({ error: "Immutable asset — manifest cannot be modified" }, { status: 403 });
  }

  let manifest: FairManifest;
  try {
    manifest = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // v1.1 manifests are always node-signed. If the owner edited the content,
  // the existing signature is over stale data — re-sign with the node key
  // before persisting. v1.0 manifests are written through as-is for now.
  let toPersist: FairManifest = manifest;
  if (isFairManifestV1_1(manifest)) {
    const result = await signFairAsNode(manifest as FairManifestV1_1);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    toPersist = result.signed;
  }

  // Update DB
  await db
    .update(assets)
    .set({ fairManifest: toPersist as unknown as Record<string, unknown> })
    .where(eq(assets.id, id));

  // TODO(#894): On manual manifest upgrade, re-publish to DFOS so the
  // updated signature propagates. Wire up publishContentEvent + update
  // assets.fair_dfos_event_id when D5 ships.

  // Update sidecar file if it exists
  if (asset.fairPath) {
    try {
      await writeFile(asset.fairPath, JSON.stringify(toPersist, null, 2));
    } catch {
      // Non-fatal — DB is source of truth
    }
  }

  return NextResponse.json({ ok: true, manifest: toPersist });
}
