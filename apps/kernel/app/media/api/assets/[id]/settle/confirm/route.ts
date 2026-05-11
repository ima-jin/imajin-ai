/**
 * POST /media/api/assets/[id]/settle/confirm
 *
 * Webhook handler for settlement confirmation.
 *
 * Stripe: receives checkout.session.completed webhook,
 * verifies signature, signs receipt, updates settlement row.
 *
 * MJNx-direct: accepts a direct POST from the buyer or node
 * after on-chain confirmation (simplified — no on-chain verification in v1).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, settlements } from "@/src/db";
import { eq } from "drizzle-orm";
import { signReceipt, loadSigningKey, receiptExpiryForAction } from "@imajin/fair";
import { createLogger } from "@imajin/logger";
import Stripe from "stripe";

const log = createLogger("kernel");

// Lazy Stripe initialization
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY not configured");
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-11-20.acacia" as Stripe.LatestApiVersion,
    });
  }
  return _stripe;
}

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

export async function POST(request: NextRequest) {
  const source = request.headers.get("X-Settle-Source") || "stripe";

  if (source === "stripe") {
    return handleStripeWebhook(request);
  }

  if (source === "mjnx") {
    return handleMjnxConfirmation(request);
  }

  return NextResponse.json({ error: "Unknown source" }, { status: 400 });
}

async function handleStripeWebhook(request: NextRequest): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    log.error({}, "STRIPE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    log.error({ err: String(err) }, "Stripe webhook signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const settlementId = session.metadata?.settlementId;
  const assetId = session.metadata?.assetId;

  if (!settlementId || !assetId) {
    log.warn({ sessionId: session.id }, "Missing settlementId or assetId in session metadata");
    return NextResponse.json({ received: true });
  }

  // Find the settlement row
  const [settlement] = await db
    .select()
    .from(settlements)
    .where(eq(settlements.id, settlementId))
    .limit(1);

  if (!settlement) {
    log.warn({ settlementId }, "Settlement row not found");
    return NextResponse.json({ error: "Settlement not found" }, { status: 404 });
  }

  if (settlement.receiptToken !== "pending") {
    log.info({ settlementId }, "Settlement already completed — idempotency skip");
    return NextResponse.json({ received: true, receipt: settlement.receiptToken });
  }

  // Sign receipt
  const paymentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id || session.id;

  let receiptToken: string;
  try {
    const signKey = await getSignKey();
    receiptToken = await signReceipt(
      {
        aud: `asset:${assetId}`,
        sub: settlementId,
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
        externalReceiptId: paymentId,
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
        assetId,
        settlementId,
        action: settlement.action,
        amount: settlement.amount,
        currency: settlement.currency,
        scheme: settlement.scheme,
        buyerDid: settlement.buyerDid,
        externalReceiptId: paymentId,
        manifestDigest: settlement.fairManifestDigest,
        settledAt: new Date().toISOString(),
      },
    });
    dfosEventId = result.eventId;
  } catch (err) {
    log.warn({ err: String(err), settlementId }, "DFOS publish failed (non-fatal)");
    // Non-blocking — don't fail the webhook
  }

  if (dfosEventId) {
    try {
      await db
        .update(settlements)
        .set({ dfosEventId })
        .where(eq(settlements.id, settlementId));
    } catch (err) {
      log.warn({ err: String(err), settlementId, dfosEventId }, "Failed to store DFOS eventId");
    }
  }

  log.info({ settlementId, assetId, paymentId }, "Settlement completed via Stripe");

  return NextResponse.json({ received: true, receipt: receiptToken });
}

async function handleMjnxConfirmation(request: NextRequest): Promise<NextResponse> {
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

  const [settlement] = await db
    .select()
    .from(settlements)
    .where(eq(settlements.id, settlementId))
    .limit(1);

  if (!settlement) {
    return NextResponse.json({ error: "Settlement not found" }, { status: 404 });
  }

  if (settlement.receiptToken !== "pending") {
    return NextResponse.json({ received: true, receipt: settlement.receiptToken });
  }

  let receiptToken: string;
  try {
    const signKey = await getSignKey();
    receiptToken = await signReceipt(
      {
        aud: `asset:${settlement.assetId}`,
        sub: settlementId,
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

  await db
    .update(settlements)
    .set({
      receiptToken,
      externalReceiptId: txHash || "mjnx-confirmed",
      settledAt: new Date(),
    })
    .where(eq(settlements.id, settlementId));

  // DFOS publish (feature-detect)
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

  log.info({ settlementId, txHash }, "Settlement completed via MJNx");

  return NextResponse.json({ received: true, receipt: receiptToken });
}
