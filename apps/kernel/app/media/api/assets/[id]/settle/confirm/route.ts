// TODO(#904): Replace owner-confirms-receipt with atomic node-ledger debit when MJNx balance system lands. Until then, settlement is operator-mediated.

/**
 * POST /media/api/assets/[id]/settle/confirm
 *
 * Owner-mediated settlement confirmation for MJNx-direct.
 *
 * The asset owner (authenticated) confirms receipt of an MJNx payment,
 * triggering receipt JWT signing and DFOS event publication.
 *
 * Full ledger integration (buyer-side atomic debit) is tracked in #904.
 *
 * Body: { settlementId, txHash? }
 */

import { NextRequest, NextResponse } from "next/server";
import { db, assets, settlements } from "@/src/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "@imajin/auth";
import { signReceipt, loadSigningKey, receiptExpiryForAction } from "@imajin/fair";
import { createLogger } from "@imajin/logger";

const log = createLogger("kernel");

// Cache signing key
let signKeyPromise: Promise<import("jose").KeyLike> | null = null;
function getSignKey(): Promise<import("jose").KeyLike> {
  if (!signKeyPromise) {
    const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
    if (!privateKeyHex) {
      signKeyPromise = Promise.reject(new Error("AUTH_PRIVATE_KEY not configured"));
    } else {
      signKeyPromise = loadSigningKey(privateKeyHex);
    }
  }
  return signKeyPromise;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await params;

  // Require authentication — caller must be the asset owner
  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const requesterDid = authResult.identity.actingAs || authResult.identity.id;

  // Parse body
  let body: {
    settlementId?: unknown;
    txHash?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const settlementId = typeof body.settlementId === "string" ? body.settlementId : undefined;
  const txHash = typeof body.txHash === "string" ? body.txHash : undefined;

  if (!settlementId) {
    return NextResponse.json({ error: "Missing settlementId" }, { status: 400 });
  }

  // Look up settlement
  const [settlement] = await db
    .select()
    .from(settlements)
    .where(eq(settlements.id, settlementId))
    .limit(1);

  if (!settlement) {
    return NextResponse.json({ error: "Settlement not found" }, { status: 404 });
  }

  // Verify the requester is the asset owner
  const [asset] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, settlement.assetId))
    .limit(1);

  if (!asset || asset.ownerDid !== requesterDid) {
    return NextResponse.json({ error: "Forbidden — only the asset owner can confirm settlement" }, { status: 403 });
  }

  // Idempotency: already completed
  if (settlement.status === "completed") {
    return NextResponse.json({ received: true, receipt: settlement.receiptToken });
  }

  // Settlement must have a buyer for buyer-bound receipts
  if (!settlement.buyerDid) {
    log.error({ settlementId }, "Settlement has no buyer DID — cannot mint receipt");
    return NextResponse.json({ error: "Settlement missing buyer" }, { status: 400 });
  }

  // Sign receipt — bound to the buyer DID (non-transferable in v1)
  let receiptToken: string;
  try {
    const signKey = await getSignKey();
    receiptToken = await signReceipt(
      {
        aud: `asset:${settlement.assetId}`,
        sub: settlementId,
        buyer: settlement.buyerDid,
        action: settlement.action,
        amount: settlement.amount,
        currency: settlement.currency,
        manifestDigest: settlement.fairManifestDigest,
        exp: receiptExpiryForAction(settlement.action),
      },
      signKey
    );
  } catch (err) {
    log.error({ err: String(err), settlementId }, "Receipt signing failed");
    return NextResponse.json({ error: "Receipt signing failed" }, { status: 500 });
  }

  // Update settlement row
  try {
    await db
      .update(settlements)
      .set({
        receiptToken,
        status: "completed",
        externalReceiptId: txHash || "mjnx-confirmed",
        settledAt: new Date(),
      })
      .where(eq(settlements.id, settlementId));
  } catch (err) {
    log.error({ err: String(err), settlementId }, "Failed to update settlement row");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  // Publish to DFOS if available (feature-detect)
  let dfosEventId: string | null = null;
  try {
    const { publishContentEvent } = await import("@imajin/dfos");
    const result = await publishContentEvent({
      topic: "fair.settlement.completed",
      payload: {
        assetId: settlement.assetId,
        settlementId,
        action: settlement.action,
        amount: settlement.amount,
        currency: settlement.currency,
        scheme: settlement.scheme,
        buyerDid: settlement.buyerDid,
        externalReceiptId: txHash || "mjnx-confirmed",
        manifestDigest: settlement.fairManifestDigest,
        settledAt: new Date().toISOString(),
      },
    });
    dfosEventId = result.eventId;
  } catch (err) {
    log.warn({ err: String(err), settlementId }, "DFOS publish failed (non-fatal)");
  }

  if (dfosEventId) {
    try {
      await db.update(settlements).set({ dfosEventId }).where(eq(settlements.id, settlementId));
    } catch (err) {
      log.warn({ err: String(err), settlementId }, "Failed to store DFOS eventId");
    }
  }

  log.info({ settlementId, txHash, assetId: settlement.assetId }, "Settlement confirmed by owner via MJNx");

  return NextResponse.json({ received: true, receipt: receiptToken });
}
