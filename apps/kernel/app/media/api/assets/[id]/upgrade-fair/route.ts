import { NextRequest, NextResponse } from "next/server";
import { db, assets } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq } from "drizzle-orm";
import type { FairManifest } from "@imajin/fair";
import { upgradeToV1_1 } from "@imajin/fair";
import { getNodeDid } from "@/src/lib/kernel/node-identity";
import { signFairAsNode } from "@/src/lib/kernel/sign-fair-manifest";
import { createLogger } from "@imajin/logger";
import * as bus from "@imajin/bus";

const log = createLogger("kernel");

/**
 * POST /api/assets/[id]/upgrade-fair
 * Manually upgrade a v1.0 .fair manifest to v1.1, sign with platform key,
 * persist, and publish a bus event.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // 1. Auth
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const requesterDid = authResult.identity.actingAs || authResult.identity.id;

  // 2. Load asset
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

  if (!asset || asset.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden — owner only" }, { status: 403 });
  }

  // 3. Load current manifest
  let manifest: FairManifest | null = null;
  if (
    asset.fairManifest &&
    typeof asset.fairManifest === "object" &&
    Object.keys(asset.fairManifest as object).length > 0
  ) {
    manifest = asset.fairManifest as FairManifest;
  }

  if (!manifest) {
    return NextResponse.json(
      { error: "No .fair manifest found for this asset" },
      { status: 404 }
    );
  }

  // 4. Normalize pre-1.0 manifests (e.g. version 0.2.0 — no `type`, no `fair`,
  //    `createdAt` instead of `created`). Backfill from asset row when possible.
  const raw = manifest as Record<string, unknown>;
  const oldVersion = String(raw.version ?? raw.fair ?? "1.0");
  const normalized: Record<string, unknown> = {
    ...raw,
    fair: typeof raw.fair === "string" ? raw.fair : "1.0",
    type: typeof raw.type === "string" ? raw.type : asset.mimeType,
    created: typeof raw.created === "string"
      ? raw.created
      : typeof raw.createdAt === "string"
        ? raw.createdAt
        : new Date().toISOString(),
    owner: typeof raw.owner === "string" ? raw.owner : asset.ownerDid,
    id: typeof raw.id === "string" ? raw.id : asset.id,
  };

  // 5. Upgrade to v1.1
  const upgraded = upgradeToV1_1(normalized as unknown as FairManifest);

  // 6. Sign with node key (shared helper — same path as PUT /fair).
  const signResult = await signFairAsNode(upgraded);
  if (!signResult.ok) {
    return NextResponse.json({ error: signResult.error }, { status: signResult.status });
  }
  const signed = signResult.signed;
  const nodeDid = await getNodeDid();

  // 6. Persist to DB
  try {
    await db
      .update(assets)
      .set({ fairManifest: signed as unknown as Record<string, unknown> })
      .where(eq(assets.id, id));
  } catch (err) {
    log.error({ err: String(err) }, "Failed to persist upgraded manifest");
    return NextResponse.json({ error: "Database update failed" }, { status: 500 });
  }

  // 7. Publish bus event
  try {
    await bus.publish("asset.fair.upgraded", {
      issuer: nodeDid,
      subject: asset.ownerDid,
      scope: "media",
      payload: {
        assetId: id,
        oldVersion,
        newVersion: "1.1",
        signer: nodeDid,
      },
    });
  } catch (err) {
    log.error({ err: String(err) }, "Bus event publish failed (non-fatal)");
  }

  // 8. Return upgraded manifest
  return NextResponse.json({ ok: true, manifest: signed });
}
