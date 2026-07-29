import { NextRequest, NextResponse } from "next/server";
import { db, settlements, accessLog } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq, and, sql } from "drizzle-orm";
import {
  isFairManifestV1_1,
  build402Response,
  verifyReceipt,
  loadVerifyKey,
  type FairManifest,
  type FairManifestV1_1,
  type FairAction,
} from "@imajin/fair";
import { createLogger } from "@imajin/logger";
import { respondPaymentRequired } from "@/src/lib/http/route-response";

const log = createLogger("kernel");

/**
 * Lazy-cached CryptoKey derived from AUTH_PRIVATE_KEY.
 * Shared across requests; loaded once on first priced-asset access.
 */
let verifyKeyPromise: Promise<CryptoKey> | null = null;

function getVerifyKey(): Promise<CryptoKey> {
  if (!verifyKeyPromise) {
    const privateKeyHex = process.env.AUTH_PRIVATE_KEY;
    verifyKeyPromise = privateKeyHex
      ? loadVerifyKey(privateKeyHex)
      : Promise.reject(new Error("AUTH_PRIVATE_KEY not configured"));
  }
  return verifyKeyPromise;
}

/**
 * Determine the FAIR action for this request based on explicit query param,
 * Range header (streaming), or default (reproduction).
 */
export function determineAction(request: NextRequest, mimeType: string): FairAction {
  const { searchParams } = new URL(request.url);
  const explicit = searchParams.get("action");
  if (
    explicit === "reproduction" ||
    explicit === "streaming" ||
    explicit === "derivative" ||
    explicit === "syndication"
  ) {
    return explicit;
  }

  const rangeHeader = request.headers.get("range");
  if (rangeHeader && (mimeType.startsWith("audio/") || mimeType.startsWith("video/"))) {
    return "streaming";
  }

  return "reproduction";
}

/**
 * Handle priced-distribution settlement for a GET asset request.
 *
 * Returns `null` to signal the caller should proceed with serving the file.
 * Returns a `NextResponse` (402, 401, 403, 429, or 500) when the request
 * must be terminated.
 *
 * Encapsulates: hasPrice check → 402 build → receipt verify → claim
 * validation → buyer-auth check → DB settlement lookup → replay check →
 * access-log insert.
 *
 * Extracted from GET /media/api/assets/[id] as part of the family-①
 * Sonar sweep (issue #1467).
 */
export async function handleSettlement(
  request: NextRequest,
  assetId: string,
  manifest: FairManifest | null,
  action: FairAction,
): Promise<NextResponse | null> {
  // Fast path: no manifest or no priced distribution right for this action.
  const distRight =
    manifest && isFairManifestV1_1(manifest)
      ? (manifest as FairManifestV1_1).distribution?.[action]
      : undefined;
  const hasPrice = !!distRight?.price && distRight.price.amount > 0;
  if (!hasPrice) return null;

  const receiptHeader = request.headers.get("X-Payment-Receipt");

  // No receipt → return 402 with settlement options.
  if (!receiptHeader) {
    try {
      const publicBase =
        process.env.NEXT_PUBLIC_BASE_URL ||
        process.env.MEDIA_PUBLIC_URL ||
        new URL(request.url).origin;
      const resp = build402Response({
        manifest: manifest as FairManifestV1_1,
        assetId,
        action,
        supportedSchemes: ["mjnx-direct"],
        baseUrl: `${publicBase}/media/api/assets`,
      });
      return respondPaymentRequired(request, resp.body, resp.headers as Record<string, string>);
    } catch (err) {
      log.error({ err: String(err), assetId, action }, "build402Response failed");
      return NextResponse.json({ error: "Settlement configuration error" }, { status: 500 });
    }
  }

  // Verify receipt signature.
  let receiptPayload: Awaited<ReturnType<typeof verifyReceipt>> | null;
  try {
    const verifyKey = await getVerifyKey();
    receiptPayload = await verifyReceipt(receiptHeader, verifyKey);
  } catch {
    receiptPayload = null;
  }

  if (!receiptPayload) {
    return NextResponse.json({ error: "Invalid payment receipt" }, { status: 402 });
  }

  // Validate receipt claims match this request.
  if (receiptPayload.aud !== `asset:${assetId}`) {
    return NextResponse.json({ error: "Receipt audience mismatch" }, { status: 402 });
  }
  if (receiptPayload.action !== action) {
    return NextResponse.json({ error: "Receipt action mismatch" }, { status: 402 });
  }

  // Buyer-binding: caller must be authenticated and match the receipt's buyer DID.
  const buyerAuth = await requireAuth(request);
  if ("error" in buyerAuth) {
    return NextResponse.json(
      { error: "Authentication required to redeem payment receipt" },
      { status: 401 },
    );
  }
  const callerDid = resolveActingDid(buyerAuth.identity);
  if (callerDid !== receiptPayload.buyer) {
    return NextResponse.json(
      { error: "Receipt is bound to a different identity" },
      { status: 403 },
    );
  }

  // Verify against the DB settlement record.
  const [settlement] = await db
    .select()
    .from(settlements)
    .where(
      and(
        eq(settlements.id, receiptPayload.sub),
        eq(settlements.assetId, assetId),
        eq(settlements.action, action),
        eq(settlements.receiptToken, receiptHeader),
      ),
    )
    .limit(1);

  if (!settlement) {
    return NextResponse.json({ error: "Settlement not found" }, { status: 402 });
  }

  // Replay protection: cap at 100 accesses per settlement per hour.
  const replayWindow = new Date(Date.now() - 60 * 60 * 1000);
  const recentAccessCount = await db
    .select({ count: sql<number>`count(*)` })
    .from(accessLog)
    .where(
      and(
        eq(accessLog.settlementId, settlement.id),
        sql`${accessLog.at} > ${replayWindow}`,
      ),
    );

  const accessCount = recentAccessCount[0]?.count ?? 0;
  if (accessCount > 100) {
    return NextResponse.json(
      { error: "Rate limit exceeded for this settlement" },
      { status: 429 },
    );
  }

  // Record the access (non-blocking — failure must not block the response).
  try {
    const { nanoid } = await import("nanoid");
    await db.insert(accessLog).values({
      id: `acc_${nanoid(16)}`,
      assetId,
      action,
      settlementId: settlement.id,
      buyerDid: settlement.buyerDid ?? undefined,
      ip: request.headers.get("x-forwarded-for") || request.ip || undefined,
      userAgent: request.headers.get("user-agent") || undefined,
    });
  } catch (err) {
    log.error({ err: String(err), assetId }, "Access log insertion failed");
  }

  return null; // All checks passed — proceed to serve.
}
