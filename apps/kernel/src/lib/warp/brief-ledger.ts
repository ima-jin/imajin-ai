import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, assets, attestations, identities } from '@/src/db';
import { createAsset } from '@/src/lib/media/create-asset';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { browserTestingFlag, isBriefStorage, type BriefStorage, type WarpBrief } from './brief';

const PREFERENCE = 'warpBriefStorage';
type Reader = Pick<typeof db, 'select'>;

async function principal(did: string, executor: Reader = db) {
  const [row] = await executor.select({ metadata: identities.metadata }).from(identities)
    .where(eq(identities.id, did)).limit(1);
  if (!row) throw new Error('Brief principal unavailable');
  return row;
}

function storageFromMetadata(metadata: unknown): BriefStorage {
  const value = (metadata as Record<string, unknown> | null)?.[PREFERENCE];
  if (value === undefined) return 'full-text';
  if (!isBriefStorage(value)) throw new Error('Brief storage preference unavailable');
  return value;
}

/** An unreadable preference must never silently revert hash-only to full text. */
export async function readBriefStorage(did: string): Promise<BriefStorage> {
  return storageFromMetadata((await principal(did)).metadata);
}

/** Projection and signed change commit together; every previous event/asset stays. */
export function writeBriefStorage(did: string, actingHumanDid: string, storage: BriefStorage) {
  return db.transaction(async tx => {
    if (!isBriefStorage(storage)) throw new Error('Invalid brief storage preference');
    await tx.select({ id: identities.id }).from(identities).where(eq(identities.id, did)).for('update');
    const { metadata } = await principal(did, tx);
    const previous = storageFromMetadata(metadata);
    const audit = await prepareMechanicalAttestation({
      subjectDid: did, type: 'warp.brief.storage.changed', contextId: did, contextType: 'warp.brief',
      payload: { previous, storage, actingHumanDid },
    });
    await tx.insert(attestations).values(audit);
    await tx.update(identities).set({
      metadata: { ...(metadata as Record<string, unknown>), [PREFERENCE]: storage }, updatedAt: new Date(),
    }).where(eq(identities.id, did));
    return { storage, attestationId: audit.id };
  });
}

/** Called after authority checks, before the provider sees any prompt bytes. */
export async function recordWarpBrief(did: string, text: string): Promise<WarpBrief> {
  const storage = await readBriefStorage(did);
  const buffer = Buffer.from(text, 'utf8');
  const brief: WarpBrief = {
    hash: createHash('sha256').update(buffer).digest('hex'),
    assetId: null, storage, browserTesting: browserTestingFlag(text),
  };
  return db.transaction(async tx => {
    if (storage === 'full-text') {
      const { asset } = await createAsset({
        ownerDid: did, buffer, filename: 'warp-brief.txt', mimeType: 'text/plain',
        access: 'private', dedup: false, classify: false, immutable: true,
        status: 'processing', tx,
      });
      brief.assetId = asset.id;
      await tx.update(assets).set({ status: 'active' }).where(eq(assets.id, asset.id));
    }
    const audit = await prepareMechanicalAttestation({
      subjectDid: did, type: 'warp.brief.recorded', contextId: brief.assetId,
      contextType: 'warp.brief', payload: { ...brief },
    });
    await tx.insert(attestations).values(audit);
    return brief;
  });
}
