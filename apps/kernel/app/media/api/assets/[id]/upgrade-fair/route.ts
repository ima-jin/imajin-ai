import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { db, assets } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq } from "drizzle-orm";
import type { FairManifest, FairManifestV1_1 } from "@imajin/fair";
import { upgradeToV1_1, signManifest } from "@imajin/fair";
import { getNodeDid } from "@/src/lib/kernel/node-identity";
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
    log.error({ service: "kernel", err: String(err) }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (!asset || asset.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden — owner only" }, { status: 403 });
  }

  // 3. Load current manifest (DB or fairPath sidecar)
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

  // 4. Idempotency — already v1.1
  const currentVersion = (manifest as Record<string, unknown>).version ?? "1.0";
  if (currentVersion === "1.1") {
    return NextResponse.json({ ok: true, manifest, alreadyUpgraded: true });
  }

  // 5. Upgrade to v1.1
  const upgraded = upgradeToV1_1(manifest);

  // 6. Sign with platform/node key (owner key infrastructure not yet available server-side)
  const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
  if (!privateKeyHex) {
    log.error({ service: "kernel" }, "AUTH_PRIVATE_KEY not configured — cannot sign upgraded manifest");
    return NextResponse.json(
      { error: "Signing key not available" },
      { status: 500 }
    );
  }

  const nodeDid = await getNodeDid();
  const privateKey = Buffer.from(privateKeyHex, "hex");

  let signed: FairManifestV1_1;
  try {
    signed = await signManifest(upgraded, {
      did: nodeDid,
      privateKey: new Uint8Array(privateKey),
    });
  } catch (err) {
    log.error({ service: "kernel", err: String(err) }, "Failed to sign upgraded manifest");
    return NextResponse.json(
      { error: "Signing failed" },
      { status: 500 }
    );
  }

  // 7. Persist to DB + sidecar
  try {
    await db
      .update(assets)
      .set({ fairManifest: signed as unknown as Record<string, unknown> })
      .where(eq(assets.id, id));
  } catch (err) {
    log.error({ service: "kernel", err: String(err) }, "Failed to persist upgraded manifest");
    return NextResponse.json({ error: "Database update failed" }, { status: 500 });
  }

  if (asset.fairPath) {
    try {
      await writeFile(asset.fairPath, JSON.stringify(signed, null, 2));
    } catch {
      // Non-fatal — DB is source of truth
    }
  }

  // 8. Publish bus event
  try {
    await bus.publish("asset.fair.upgraded", {
      issuer: requesterDid,
      subject: requesterDid,
      scope: "media",
      payload: {
        assetId: id,
        oldVersion: String(currentVersion),
        newVersion: "1.1",
        signer: nodeDid,
      },
    });
  } catch (err) {
    log.error({ service: "kernel", err: String(err) }, "Bus event publish failed (non-fatal)");
  }

  // 9. Re-publish to DFOS (feature-detect — added by #897)
  try {
    const { publishContentEvent } = await import("@imajin/dfos");
    const { canonicalize } = await import("@imajin/auth");
    const canonical = canonicalize(signed);
    const digest = createHash("sha256").update(canonical).digest("hex");
    const eventResult = await publishContentEvent({
      topic: "fair.manifest.published",
      payload: {
        assetId: id,
        ownerDid: requesterDid,
        manifestDigest: `sha256:${digest}`,
        manifestUrl: `${process.env.MEDIA_URL || "https://media.imajin.ai"}/media/api/assets/${id}/fair`,
        fairVersion: "1.1",
        signedAt: signed.signature.signedAt,
      },
    });
    if (eventResult?.eventId) {
      await db
        .update(assets)
        .set({ fairDfosEventId: eventResult.eventId })
        .where(eq(assets.id, id));
    }
  } catch (err) {
    log.warn({ service: "kernel", err: String(err) }, "DFOS re-publish failed (non-fatal)");
  }

  // 10. Return upgraded manifest
  return NextResponse.json({ ok: true, manifest: signed });
}
