import { NextRequest, NextResponse } from "next/server";
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

  // 4. Upgrade to v1.1
  const upgraded = upgradeToV1_1(manifest);
  const oldVersion = (manifest as Record<string, unknown>).version ?? "1.0";

  // 5. Sign with platform/node key
  const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
  if (!privateKeyHex) {
    log.error({}, "AUTH_PRIVATE_KEY not configured — cannot sign upgraded manifest");
    return NextResponse.json(
      { error: "Signing key not available" },
      { status: 500 }
    );
  }

  const nodeDid = await getNodeDid();

  // AUTH_PRIVATE_KEY may be either:
  //   - 32-byte raw Ed25519 seed (64 hex chars), or
  //   - 48-byte PKCS8 DER (96 hex chars, with 16-byte algorithm-OID prefix).
  // Noble wants the 32-byte raw seed.
  const keyBuf = Buffer.from(privateKeyHex, "hex");
  let seedBytes: Uint8Array;
  if (keyBuf.length === 32) {
    seedBytes = new Uint8Array(keyBuf);
  } else if (keyBuf.length === 48) {
    // PKCS8 DER: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING { <32 bytes> } } }
    // Last 32 bytes are the seed.
    seedBytes = new Uint8Array(keyBuf.subarray(16));
  } else {
    log.error({ len: keyBuf.length }, "AUTH_PRIVATE_KEY wrong length (expected 32 or 48 bytes)");
    return NextResponse.json({ error: "Signing key has wrong length" }, { status: 500 });
  }

  let signed: FairManifestV1_1;
  try {
    signed = await signManifest(upgraded, {
      did: nodeDid,
      privateKey: seedBytes,
    });
  } catch (err) {
    log.error({ err: String(err) }, "Failed to sign upgraded manifest");
    return NextResponse.json(
      { error: "Signing failed" },
      { status: 500 }
    );
  }

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
        oldVersion: String(oldVersion),
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
