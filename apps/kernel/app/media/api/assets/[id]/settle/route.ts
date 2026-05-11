/**
 * POST /media/api/assets/[id]/settle
 *
 * Initiate settlement for a priced asset action.
 *
 * Body: { action?, scheme, returnUrl? }
 * - action defaults to "reproduction"
 * - scheme: "stripe-link" | "mjnx-direct" | "x402" | "solana-pay" | "lightning"
 *
 * Returns: { settlementId, url } for stripe-link, { settlementId, uri } for mjnx-direct
 */

import { NextRequest, NextResponse } from "next/server";
import { db, assets, settlements } from "@/src/db";
import { requireAuth } from "@imajin/auth";
import { eq } from "drizzle-orm";
import { isFairManifestV1_1 } from "@imajin/fair";
import type { FairManifestV1_1, SettlementScheme } from "@imajin/fair";
import { getPaymentService } from "@/src/lib/pay/pay";
import { createLogger } from "@imajin/logger";
import { nanoid } from "nanoid";

const log = createLogger("kernel");

function isValidScheme(s: unknown): s is SettlementScheme {
  return (
    typeof s === "string" &&
    ["x402", "stripe-link", "mjnx-direct", "solana-pay", "lightning"].includes(s)
  );
}

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
    returnUrl?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = isValidAction(body.action) ? body.action : "reproduction";
  const scheme = body.scheme;
  const returnUrl = typeof body.returnUrl === "string" ? body.returnUrl : undefined;

  if (!isValidScheme(scheme)) {
    return NextResponse.json({ error: "Invalid or missing scheme" }, { status: 400 });
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

  // 4. Auth check
  // Anonymous settlement allowed for reproduction; required for derivative if commercial not allowed
  let buyerDid: string | null = null;
  if (action === "derivative" && manifest.commercial?.allowed === false) {
    const authResult = await requireAuth(request);
    if ("error" in authResult) {
      return NextResponse.json(
        { error: "Authentication required for derivative settlement" },
        { status: 401 }
      );
    }
    buyerDid = authResult.identity.actingAs || authResult.identity.id;
  }

  // Optional auth for other actions (capture buyer DID if available)
  if (!buyerDid) {
    const authResult = await requireAuth(request);
    if (!("error" in authResult)) {
      buyerDid = authResult.identity.actingAs || authResult.identity.id;
    }
  }

  // 5. Create settlement row
  const settlementId = `stl_${nanoid(16)}`;
  const price = distRight.price;

  // Compute manifest digest (simple sha256 of canonical JSON)
  const manifestDigest = `sha256:${await sha256Text(JSON.stringify(manifest))}`;

  try {
    await db.insert(settlements).values({
      id: settlementId,
      assetId: id,
      action,
      buyerDid,
      amount: price.amount,
      currency: price.currency,
      scheme,
      receiptToken: "pending", // will be updated on confirmation
      fairManifestDigest: manifestDigest,
    });
  } catch (err) {
    log.error({ err: String(err) }, "Failed to create settlement row");
    return NextResponse.json({ error: "Database failure" }, { status: 500 });
  }

  // 6. Scheme-specific handling
  if (scheme === "stripe-link") {
    try {
      const pay = getPaymentService();
      const baseUrl = `${new URL(request.url).origin}/media/api/assets`;
      const successUrl = returnUrl || `${baseUrl}/${id}?settlement=${settlementId}`;
      const cancelUrl = `${baseUrl}/${id}?settlement=${settlementId}&canceled=true`;

      const splitsJson = distRight.splits ? JSON.stringify(distRight.splits) : undefined;

      const checkout = await pay.checkout({
        items: [
          {
            name: `${manifest.type} — ${action}`,
            amount: price.amount,
            quantity: 1,
          },
        ],
        currency: price.currency as "USD" | "CAD" | "EUR" | "GBP",
        successUrl,
        cancelUrl,
        metadata: {
          settlementId,
          assetId: id,
          action,
          buyerDid: buyerDid || "",
          splits: splitsJson || "",
          manifestDigest,
          service: "media",
        },
      });

      return NextResponse.json({
        settlementId,
        url: checkout.url,
        scheme: "stripe-link",
      });
    } catch (err) {
      log.error({ err: String(err), settlementId }, "Stripe checkout creation failed");
      return NextResponse.json({ error: "Payment provider error" }, { status: 500 });
    }
  }

  if (scheme === "mjnx-direct") {
    const uri = `mjnx:pay?to=${encodeURIComponent(manifest.owner)}&amount=${price.amount}&currency=${encodeURIComponent(price.currency)}&memo=settle:${settlementId}`;
    return NextResponse.json({
      settlementId,
      uri,
      scheme: "mjnx-direct",
    });
  }

  // Stubs for not-yet-supported schemes
  if (scheme === "x402" || scheme === "solana-pay" || scheme === "lightning") {
    return NextResponse.json(
      { error: "Scheme not supported on this node", scheme },
      { status: 501 }
    );
  }

  return NextResponse.json({ error: "Unknown scheme" }, { status: 400 });
}

async function sha256Text(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
