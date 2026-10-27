import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import { verifyManifest, type SignedFairManifest } from '@imajin/fair';
import { db, assets, identities, type Asset } from '@/src/db';
import { getNodeDid } from '../kernel/node-identity';
import { createAsset } from '../media/create-asset';
import { updateAssetContent } from '../media/update-asset';
import { releaseLegalEntity } from './legal-entity-release';
import {
  LEGAL_ENTITY_MAX_BYTES, type LegalEntityInput,
} from './legal-entity-schema';
import { composeLegalEntity, composeLegalEntityRevocation, parseLegalEntity } from './legal-entity-document';

// Select the newest active legal-entity record when retained history contains duplicates.
async function findLegalEntityAsset(did: string): Promise<Asset | null> {
  const [asset] = await db.select().from(assets).where(and(
    eq(assets.ownerDid, did),
    eq(assets.status, 'active'),
    sql`${assets.metadata}->>'kind' = 'legal-entity'`,
  )).limit(1);
  return asset ?? null;
}

/** Bounded read + signed hash binding: the file, not metadata, holds every value and gate. */
async function readSignedLegalEntity(asset: Asset) {
  const file = await open(asset.storagePath, 'r');
  let content: string;
  try {
    const buffer = Buffer.alloc(LEGAL_ENTITY_MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LEGAL_ENTITY_MAX_BYTES) throw new Error('Document exceeds size cap');
    content = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  const hash = createHash('sha256').update(content).digest('hex');
  const manifest = asset.fairManifest as SignedFairManifest | null;
  const nodeDid = await getNodeDid();
  if (!manifest?.signature || !nodeDid || manifest.signature.signer !== nodeDid
    || manifest.owner !== asset.ownerDid || manifest.id !== asset.id
    || manifest.integrity?.hash !== hash || asset.hash !== hash
    || manifest.integrity.size !== Buffer.byteLength(content, 'utf8')) {
    throw new Error('Document signature binding mismatch');
  }
  const verified = await verifyManifest(manifest, async signer => {
    const [identity] = await db.select({ publicKey: identities.publicKey })
      .from(identities).where(eq(identities.id, signer)).limit(1);
    if (!identity?.publicKey) throw new Error('Signer unavailable');
    return new Uint8Array(Buffer.from(identity.publicKey, 'hex'));
  });
  if (!('ok' in verified) || !verified.ok) throw new Error('Document signature invalid');
  return parseLegalEntity(content, asset.ownerDid);
}

/** Kernel read contract for invoices and other consumers. No projections and no cached grants. */
export async function getLegalEntity(did: string, viewerDid: string | null) {
  const asset = await findLegalEntityAsset(did);
  if (!asset) return null;
  try {
    const parsed = await readSignedLegalEntity(asset);
    if (!parsed.input) return null;
    const released = await releaseLegalEntity(did, viewerDid, parsed.input, parsed.releasePolicy);
    // Reject a concurrent edit/revocation during signature/broker checks.
    const current = await findLegalEntityAsset(did);
    return current?.id === asset.id && current.hash === asset.hash ? released : null;
  } catch {
    return null; // Missing, malformed, tampered or unverifiable source fails closed.
  }
}

/** Internal owner-settings read; the route/page MUST requireDocumentActor({ write: true }). */
export async function getOwnerLegalEntity(did: string) {
  const asset = await findLegalEntityAsset(did);
  if (!asset) return null;
  const parsed = await readSignedLegalEntity(asset);
  return parsed.input ? { record: parsed.input, assetId: asset.id, version: asset.versionCount } : null;
}

/** Serializes create/edit/revoke per DID across processes, without any schema additions. */
export function saveLegalEntity(did: string, composedBy: string, input: LegalEntityInput | null) {
  const content = input ? composeLegalEntity(did, input) : composeLegalEntityRevocation(did);
  const lockKey = `legal-entity:${did}`;
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    let asset = await findLegalEntityAsset(did);
    if (!asset) {
      if (!input) return;
      const created = await createAsset({
        ownerDid: did,
        uploadedBy: composedBy,
        buffer: Buffer.from(content, 'utf8'),
        filename: 'legal-entity.md',
        mimeType: 'text/markdown',
        access: 'private',
        dedup: false,
        classify: false,
        controlDocument: 'legal-entity',
      });
      asset = created.asset;
    }
    // Uses the #1205/#1208 rail for every operation, including a signed,
    // value-free deletion revision. Lore history and the asset row are retained.
    const result = await updateAssetContent({
      assetId: asset.id, requesterDid: did, content,
      controlDocument: 'legal-entity', composedBy,
    });
    if (!result.ok) throw new Error(`Legal-entity write failed: ${result.code}`);
  });
}
