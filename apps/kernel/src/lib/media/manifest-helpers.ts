/**
 * Shared manifest helpers for media kernel endpoints.
 *
 * Extracts the common sign / write / publish / update flow so route
 * handlers stay thin.
 */

import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { signManifest, canonicalize } from "@imajin/fair";
import { publishContentEvent } from "@imajin/dfos";
import { hexToBytes } from "@imajin/auth";
import { createLogger } from "@imajin/logger";
import type { FairManifest, FairManifestV1_1 } from "@imajin/fair";
import { db, assets } from "@/src/db";
import { eq } from "drizzle-orm";

const log = createLogger("kernel");

export interface PlatformSigner {
  did: string;
  privateKey: Uint8Array;
}

/**
 * Resolve the platform signer from env vars.
 * Returns null if either PLATFORM_DID or AUTH_PRIVATE_KEY is missing.
 */
export function getPlatformSigner(): PlatformSigner | null {
  const platformDid = process.env.PLATFORM_DID;
  const platformKeyHex = process.env.AUTH_PRIVATE_KEY;
  if (!platformDid || !platformKeyHex) return null;
  return { did: platformDid, privateKey: hexToBytes(platformKeyHex) };
}

/**
 * Sign a manifest with the platform key.
 * Falls back to the unsigned manifest if signing fails.
 */
export async function signManifestWithPlatformKey(
  manifest: FairManifestV1_1
): Promise<FairManifestV1_1> {
  const signer = getPlatformSigner();
  if (!signer) {
    log.warn({}, "Platform signer not configured — manifest will be unsigned");
    return manifest;
  }
  try {
    return await signManifest(manifest, signer);
  } catch (err) {
    log.warn({ err: String(err) }, "Manifest signing failed, using unsigned manifest");
    return manifest;
  }
}

/**
 * Write a manifest to disk as JSON.
 */
export async function writeManifestToDisk(
  manifest: FairManifest,
  fairPath: string
): Promise<void> {
  await writeFile(fairPath, JSON.stringify(manifest, null, 2));
}

/**
 * Publish a fair.manifest.published DFOS event for the given manifest.
 * Returns the eventId on success, null on failure (never throws).
 */
export async function publishManifestDfosEvent(
  assetId: string,
  ownerDid: string,
  manifest: FairManifest,
  baseUrl: string
): Promise<string | null> {
  const manifestUrl = `${baseUrl}/media/api/assets/${assetId}/fair`;
  const manifestDigest = createHash("sha256")
    .update(canonicalize(manifest))
    .digest("hex");

  try {
    const result = await publishContentEvent({
      topic: "fair.manifest.published",
      payload: {
        assetId,
        ownerDid,
        manifestDigest: `sha256:${manifestDigest}`,
        manifestUrl,
        fairVersion: (manifest as { fair?: string }).fair || "1.1",
        signedAt: new Date().toISOString(),
      },
    });
    return result?.eventId ?? null;
  } catch (err) {
    log.error({ err: String(err), assetId }, "DFOS publish failed (non-fatal)");
    return null;
  }
}

/**
 * Full manifest update flow: sign → write → publish → update DB.
 *
 * Returns the updated (signed) manifest and the DFOS event id (or null).
 */
export async function updateManifestFlow(
  asset: {
    id: string;
    ownerDid: string;
    fairPath: string | null;
    fairDfosEventId: string | null;
  },
  manifest: FairManifestV1_1,
  baseUrl: string
): Promise<{ signedManifest: FairManifestV1_1; dfosEventId: string | null }> {
  // 1. Sign
  const signedManifest = await signManifestWithPlatformKey(manifest);

  // 2. Write to disk (if we have a path)
  if (asset.fairPath) {
    await writeManifestToDisk(signedManifest, asset.fairPath);
  }

  // 3. Publish DFOS event
  const dfosEventId = await publishManifestDfosEvent(
    asset.id,
    asset.ownerDid,
    signedManifest,
    baseUrl
  );

  // 4. Update DB
  await db
    .update(assets)
    .set({
      fairManifest: signedManifest,
      fairDfosEventId: dfosEventId ?? asset.fairDfosEventId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(assets.id, asset.id));

  return { signedManifest, dfosEventId };
}
