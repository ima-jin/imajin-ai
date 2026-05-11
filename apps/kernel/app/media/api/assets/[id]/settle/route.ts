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
import { and, eq, gte, sql } from "drizzle-orm";
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

  // 4. Auth required — receipts are buyer-bound (non-transferable in v1).
  // Buyer DID is embedded in the receipt JWT and verified at asset access time.
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json(
      { error: "Authentication required to settle" },
      { status: 401 }
    );
  }
  const buyerDid = authResult.identity.actingAs || authResult.identity.id;

  // 5. Validate manifest.owner is a DID before interpolating into URI
  if (!manifest.owner || !manifest.owner.startsWith("did:")) {
    log.error({ assetId: id, owner: manifest.owner }, "manifest.owner is not a valid DID");
    return NextResponse.json({ error: "Asset manifest has invalid owner DID" }, { status: 500 });
  }

  // 6. Rate limit + idempotent dedup of pending settlements for this buyer.
  // - Reuse an existing pending row for the same (buyer, asset, action) within 30 min
  //   so client retries return the same settlementId instead of piling up rows.
  // - Hard cap: more than 10 pending settlements created by this buyer in the last 5 min → 429.
  const dedupWindow = new Date(Date.now() - 30 * 60 * 1000);
  const [existing] = await db
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.buyerDid, buyerDid),
        eq(settlements.assetId, id),
        eq(settlements.action, action),
        eq(settlements.status, "pending"),
        gte(settlements.settledAt, dedupWindow)
      )
    )
    .limit(1);

  const price = distRight.price;

  if (existing) {
    const uri = `mjnx:pay?to=${encodeURIComponent(manifest.owner)}&amount=${price.amount}&currency=${encodeURIComponent(price.currency)}&memo=settle:${existing.id}`;
    return NextResponse.json({
      settlementId: existing.id,
      uri,
      scheme: "mjnx-direct",
      reused: true,
    });
  }

  const rateWindow = new Date(Date.now() - 5 * 60 * 1000);
  const recent = await db
    .select({ count: sql<number>`count(*)` })
    .from(settlements)
    .where(
      and(
        eq(settlements.buyerDid, buyerDid),
        gte(settlements.settledAt, rateWindow)
      )
    );
  if ((recent[0]?.count ?? 0) > 10) {
    return NextResponse.json(
      { error: "Settlement rate limit exceeded — try again in a few minutes" },
      { status: 429 }
    );
  }

  // 7. Create settlement row
  const settlementId = `stl_${nanoid(16)}`;
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
      receiptToken: "", // filled on confirmation
      fairManifestDigest: manifestDigest,
    });
  } catch (err) {
    log.error({ err: String(err) }, "Failed to create settlement row");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  // 8. Build MJNx deep-link URI
  const uri = `mjnx:pay?to=${encodeURIComponent(manifest.owner)}&amount=${price.amount}&currency=${encodeURIComponent(price.currency)}&memo=settle:${settlementId}`;

  return NextResponse.json({
    settlementId,
    uri,
    scheme: "mjnx-direct",
  });
}
