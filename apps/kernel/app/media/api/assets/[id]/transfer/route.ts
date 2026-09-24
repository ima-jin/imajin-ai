import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db, assets, identities, type Asset } from "@/src/db";
import { requireAuth, resolveActingDid } from "@imajin/auth";
import { eq } from "drizzle-orm";
import type { FairManifest, FairManifestV11 } from "@imajin/fair";
import { canonicalize, isFairManifestV11 } from "@imajin/fair";
import { signFairAsNode } from "@/src/lib/kernel/sign-fair-manifest";
import { writeManifestToDisk } from "@/src/lib/media/manifest-helpers";
import { publishContentEvent } from "@imajin/dfos";
import { createLogger } from "@imajin/logger";

const log = createLogger("kernel");

/**
 * Reassign the `.fair` chain's `seller` role (and the top-level `owner`) to
 * the new owner. Every other chain entry (protocol/node/buyer_credit/platform
 * splits) is left untouched, and `attribution` is never touched here — the
 * original uploader's `creator` credit must survive an ownership transfer
 * (#1128).
 */
function reassignManifestOwnership(
  manifest: FairManifestV11,
  toDid: string
): FairManifestV11 {
  const chain = (manifest.chain ?? []).map((entry) =>
    entry.role === "seller" ? { ...entry, did: toDid } : entry
  );
  return { ...manifest, owner: toDid, chain };
}

/**
 * Load the asset, then apply the same owner-gate + immutability guard that
 * DELETE/PATCH/PUT-fair apply in this directory. Returns either the loaded
 * asset or a ready-to-return error response.
 */
async function loadOwnedAsset(
  id: string,
  actingDid: string
): Promise<{ asset: Asset } | { error: NextResponse }> {
  let asset: Asset | undefined;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  } catch (err) {
    log.error({ err: String(err) }, "DB lookup failed");
    return { error: NextResponse.json({ error: "Database failure" }, { status: 500 }) };
  }

  if (asset?.status !== "active") {
    return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  if (asset.ownerDid !== actingDid) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (asset.immutable) {
    return {
      error: NextResponse.json(
        { error: "Immutable asset — cannot transfer ownership" },
        { status: 403 }
      ),
    };
  }
  return { asset };
}

/**
 * Validate the transfer target: `toDid` must resolve to a real identity
 * (equivalent to GET /auth/api/identity/{did} — done here as a direct
 * in-process query against the same `identities` table that route reads,
 * rather than a self-referential HTTP round trip, since both routes run in
 * this same Next.js app/process — #1128 decision), and must differ from the
 * current owner (#1128 decision: reject a no-op transfer with 409 rather
 * than idempotently accepting it — documented here since the issue left the
 * choice open).
 */
async function validateTransferTarget(
  toDid: string,
  currentOwnerDid: string
): Promise<NextResponse | null> {
  const [targetIdentity] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(eq(identities.id, toDid))
    .limit(1);
  if (!targetIdentity) {
    return NextResponse.json({ error: "Target identity not found" }, { status: 404 });
  }
  if (toDid === currentOwnerDid) {
    return NextResponse.json({ error: "Already owner" }, { status: 409 });
  }
  return null;
}

/**
 * Reassign + re-sign the `.fair` manifest for the new owner and persist it
 * (DB row + sidecar file). The chain/owner reassignment only makes sense for
 * v1.1 manifests (v1.0 has no `chain` split — see upgrade-fair route).
 */
async function transferManifest(
  asset: Asset,
  toDid: string
): Promise<{ signed: FairManifestV11 } | { error: NextResponse }> {
  const manifest: FairManifest | null =
    asset.fairManifest &&
    typeof asset.fairManifest === "object" &&
    Object.keys(asset.fairManifest as object).length > 0
      ? (asset.fairManifest as FairManifest)
      : null;

  if (!manifest || !isFairManifestV11(manifest)) {
    return {
      error: NextResponse.json(
        { error: "Asset has no v1.1 .fair manifest — run POST /upgrade-fair first" },
        { status: 400 }
      ),
    };
  }

  // Owner/chain changed below — the existing signature is now stale. Re-sign
  // with the node key (same signer used by PUT /fair and /upgrade-fair).
  const signResult = await signFairAsNode(reassignManifestOwnership(manifest, toDid));
  if (!signResult.ok) {
    return { error: NextResponse.json({ error: signResult.error }, { status: signResult.status }) };
  }
  const signed = signResult.signed;

  // Persist ownerDid + manifest together. Deliberately does NOT touch
  // storagePath/fairPath — ownership transfer is a logical/manifest change,
  // never a filesystem move (#1128 scope).
  try {
    await db
      .update(assets)
      .set({
        ownerDid: toDid,
        fairManifest: signed as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(assets.id, asset.id));
  } catch (err) {
    log.error({ err: String(err) }, "DB update failed");
    return { error: NextResponse.json({ error: "Database failure" }, { status: 500 }) };
  }

  if (asset.fairPath) {
    try {
      await writeManifestToDisk(signed, asset.fairPath);
    } catch (err) {
      log.warn({ err: String(err) }, "Failed to write updated .fair sidecar (non-fatal)");
    }
  }

  return { signed };
}

/**
 * Anchor a DFOS event for the transfer (best-effort, never blocks — mirrors
 * the upload route's publishContentEvent pattern in create-asset.ts).
 */
async function anchorTransferEvent(input: {
  assetId: string;
  previousOwner: string;
  toDid: string;
  actingDid: string;
  signedManifest: FairManifestV11;
}): Promise<void> {
  const { assetId, previousOwner, toDid, actingDid, signedManifest } = input;
  const manifestDigest = `sha256:${createHash("sha256").update(canonicalize(signedManifest)).digest("hex")}`;
  try {
    const dfosResult = await publishContentEvent({
      topic: "asset.ownership.transferred",
      payload: {
        assetId,
        previousOwner,
        newOwner: toDid,
        issuer: actingDid,
        subject: toDid,
        manifestDigest,
        transferredAt: new Date().toISOString(),
      },
    });
    if (dfosResult) {
      await db.update(assets).set({ fairDfosEventId: dfosResult.eventId }).where(eq(assets.id, assetId));
    }
  } catch (err) {
    log.error({ err: String(err), assetId }, "DFOS publish failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// POST /api/assets/[id]/transfer — transfer asset ownership to another DID
// (owner only). Body: { toDid: "did:imajin:..." }
// ---------------------------------------------------------------------------
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const authResult = await requireAuth(request);
  if ("error" in authResult) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const actingDid = resolveActingDid(authResult.identity);

  let body: { toDid?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const toDid = body.toDid;
  if (typeof toDid !== "string" || !toDid.trim()) {
    return NextResponse.json({ error: "toDid is required" }, { status: 400 });
  }

  const ownedAssetResult = await loadOwnedAsset(id, actingDid);
  if ("error" in ownedAssetResult) {
    return ownedAssetResult.error;
  }
  const { asset } = ownedAssetResult;

  const targetError = await validateTransferTarget(toDid, asset.ownerDid);
  if (targetError) {
    return targetError;
  }

  const previousOwner = asset.ownerDid;
  const manifestResult = await transferManifest(asset, toDid);
  if ("error" in manifestResult) {
    return manifestResult.error;
  }
  const { signed: signedManifest } = manifestResult;

  await anchorTransferEvent({ assetId: id, previousOwner, toDid, actingDid, signedManifest });

  return NextResponse.json({
    ok: true,
    id,
    previousOwner,
    newOwner: toDid,
    fairManifest: signedManifest,
  });
}
