import { db, assets } from '@/src/db';
import type { Asset } from '@/src/db';
import { eq } from 'drizzle-orm';
import { isFairManifestV1_1 } from '@imajin/fair';
import type { FairManifest, FairManifestV1_1 } from '@imajin/fair';
import { createLogger } from '@imajin/logger';
import { updateManifestFlow } from '@/src/lib/media/manifest-helpers';

const log = createLogger('kernel');

type ApplyGrantsOk = { ok: true; asset: Asset };
type ApplyGrantsErr = { ok: false; status: number; message: string };
export type ApplyGrantsResult = ApplyGrantsOk | ApplyGrantsErr;

/**
 * Pure grant mutation — the canonical in-process path for adding/removing DIDs
 * from an asset's allowedDids list. Used by both patchGrants (HTTP) and the
 * media_grant_access MCP tool (direct call, no HTTP self-call).
 *
 * - Owner-only: returns 403 if requesterDid !== asset.ownerDid.
 * - Auto-flips access to trust-graph when any allowedDid remains; reverts to
 *   private when the last DID is removed.
 * - Immutable assets are rejected (403).
 */
export async function applyGrants(
  assetId: string,
  requesterDid: string,
  add: string[],
  remove: string[],
  baseUrl: string,
): Promise<ApplyGrantsResult> {
  if (add.length === 0 && remove.length === 0) {
    return { ok: false, status: 400, message: 'add or remove must contain at least one DID string' };
  }

  let asset: Asset | undefined;
  try {
    [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  } catch (err) {
    log.error({ err: String(err) }, 'DB lookup failed');
    return { ok: false, status: 500, message: 'Database failure' };
  }

  if (asset?.status !== 'active') {
    return { ok: false, status: 404, message: 'Not found' };
  }
  if (asset.ownerDid !== requesterDid) {
    return { ok: false, status: 403, message: 'Forbidden' };
  }
  if (asset.immutable) {
    return { ok: false, status: 403, message: 'Immutable asset — grants cannot be modified' };
  }

  let manifest: FairManifestV1_1;
  if (
    asset.fairManifest &&
    typeof asset.fairManifest === 'object' &&
    Object.keys(asset.fairManifest as object).length > 0 &&
    isFairManifestV1_1(asset.fairManifest as FairManifest)
  ) {
    manifest = { ...(asset.fairManifest as FairManifestV1_1) };
  } else {
    manifest = {
      fair: '1.1',
      version: '1.1',
      id: asset.id,
      type: asset.mimeType,
      owner: asset.ownerDid,
      created: (asset.createdAt ?? new Date()).toISOString(),
      access: { type: 'private' },
      attribution: [{ did: asset.ownerDid, role: 'creator', share: 1 }],
    };
  }

  if (typeof manifest.access === 'string') {
    manifest.access = { type: manifest.access };
  }

  const current = new Set(manifest.access.allowedDids ?? []);
  for (const did of add) current.add(did);
  for (const did of remove) current.delete(did);

  const hasGrants = current.size > 0;
  manifest.access = {
    type: hasGrants ? 'trust-graph' : (manifest.access.type ?? 'private'),
    allowedDids: hasGrants ? Array.from(current) : undefined,
  };

  try {
    await updateManifestFlow(
      {
        id: asset.id,
        ownerDid: asset.ownerDid,
        fairPath: asset.fairPath,
        fairDfosEventId: asset.fairDfosEventId ?? null,
      },
      manifest,
      baseUrl,
    );
  } catch (err) {
    log.error({ err: String(err), assetId }, 'updateManifestFlow failed');
    return { ok: false, status: 500, message: 'Failed to update manifest' };
  }

  const [updated] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  return { ok: true, asset: updated };
}
