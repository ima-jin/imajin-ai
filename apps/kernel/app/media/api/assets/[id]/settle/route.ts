/**
 * POST /media/api/assets/[id]/settle
 *
 * Initiate settlement for a priced asset action.
 *
 * Body: { action?, scheme: "mjnx-direct" }
 * - action defaults to "reproduction"
 * - scheme: must be "mjnx-direct" (fiat rails deferred to #904)
 *
 * Returns: { settlementId, uri } where uri is the mjnx:pay deep link
 */

import { NextRequest, NextResponse } from "next/server";
import { db, assets, settlements } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { canonicalize } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { isFairManifestV1_1 } from "@imajin/fair";
import type { FairManifestV1_1 } from "@imajin/fair";
import { createLogger } from "@imajin/logger";
import { nanoid } from "nanoid";
import { createHash } from "crypto";

const log = createLogger("kernel");

function isValidAction(s: unknown): s is "reproduction" | "streaming" | "derivative" | "syndication" {
  return (
    typeof s === "string" &&
    ["reproduction", "streaming", "derivative", "syndication"].includes(s)
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // 1. Parse body
  let body: {
    action?: unknown;
    scheme?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = isValidAction(body.action) ? body.action : "reproduction";
  const scheme = body.scheme;

  if (scheme !== "mjnx-direct") {
    return NextResponse.json(
      {
        error: "Only mjnx-direct settlement is supported on this node. Fiat rails are tracked in #904.",
        scheme,
      },
      { status: 400 }
    );
  }

  // 2. Look up asset
  let asset;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  if (!asset || asset.status !== "active") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 3. Resolve manifest
  let manifest: FairManifestV1_1 | null = null;
  if (
    asset.fairManifest &&
    typeof asset.fairManifest === "object" &&
    Object.keys(asset.fairManifest as object).length > 0 &&
    isFairManifestV1_1(asset.fairManifest as Record<string, unknown>)
  ) {
    manifest = asset.fairManifest as unknown as FairManifestV1_1;
  }

  if (!manifest) {
    return NextResponse.json({ error: "No .fair manifest" }, { status: 400 });
  }

  const distRight = manifest.distribution?.[action];
  if (!distRight?.price) {
    return NextResponse.json(
      { error: `Action "${action}" is not priced` },
      { status: 400 }
    );
  }

  // 4. Auth — single attempt; capture buyerDid if present.
  // Derivative + commercial-not-allowed requires authentication.
  const authResult = await requireAuth(request);
  let buyerDid: string | null = null;
  if (!("error" in authResult)) {
    buyerDid = authResult.identity.actingAs || authResult.identity.id;
  } else if (action === "derivative" && manifest.commercial?.allowed === false) {
    return NextResponse.json(
      { error: "Authentication required for derivative settlement" },
      { status: 401 }
    );
  }

  // 5. Validate manifest.owner is a DID before interpolating into URI
  if (!manifest.owner || !manifest.owner.startsWith("did:")) {
    log.error({ assetId: id, owner: manifest.owner }, "manifest.owner is not a valid DID");
    return NextResponse.json({ error: "Asset manifest has invalid owner DID" }, { status: 500 });
  }

  // 6. Create settlement row
  const settlementId = `stl_${nanoid(16)}`;
  const price = distRight.price;
  const manifestDigest = `sha256:${createHash('sha256').update(canonicalize(manifest)).digest('hex')}`;

  try {
    await db.insert(settlements).values({
      id: settlementId,
      assetId: id,
      action,
      buyerDid,
      amount: price.amount,
      currency: price.currency,
      scheme: "mjnx-direct",
      status: "pending",
      receiptToken: "pending",
      fairManifestDigest: manifestDigest,
    });
  } catch (err) {
    log.error({ err: String(err) }, "Failed to create settlement row");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  // 7. Build MJNx deep-link URI
  const uri = `mjnx:pay?to=${encodeURIComponent(manifest.owner)}&amount=${price.amount}&currency=${encodeURIComponent(price.currency)}&memo=settle:${settlementId}`;

  return NextResponse.json({
    settlementId,
    uri,
    scheme: "mjnx-direct",
  });
}
