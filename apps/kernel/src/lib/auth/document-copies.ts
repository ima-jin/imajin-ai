import { db, assets, folders, assetFolders } from '@/src/db';
import { and, eq } from 'drizzle-orm';
import { mkdir, copyFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel:documents');
export type DocumentStore = Pick<typeof db, 'select' | 'insert' | 'update'>;

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/mnt/media';

function didToPath(did: string): string {
  return did.replaceAll(':', '_').replaceAll(/[^a-zA-Z0-9._@-]/g, '_');
}

/**
 * Copy a signed document to the signer's media storage.
 */
export async function copyDocumentToSigner(
  originalAsset: typeof assets.$inferSelect,
  signerDid: string,
  documentId: string,
  options: { store?: DocumentStore; required?: boolean } = {},
): Promise<string | null> {
  const store = options.store ?? db;
  try {
    const signerPath = didToPath(signerDid);
    const signedDir = `${MEDIA_ROOT}/${signerPath}/.signed`;
    await mkdir(signedDir, { recursive: true });

    const originalExt = path.extname(originalAsset.storagePath);
    const newAssetId = `asset_${nanoid(16)}`;
    const newStoragePath = `${signedDir}/${newAssetId}${originalExt}`;

    await copyFile(originalAsset.storagePath, newStoragePath);

    // Find or create "Signed Documents" folder
    let folderId: string | null = null;
    const [existingFolder] = await store
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.ownerDid, signerDid),
          eq(folders.name, 'Signed Documents'),
          eq(folders.isSystem, true)
        )
      )
      .limit(1);

    if (existingFolder) {
      folderId = existingFolder.id;
    } else {
      const newFolderId = `folder_${nanoid(16)}`;
      const [inserted] = await store
        .insert(folders)
        .values({
          id: newFolderId,
          ownerDid: signerDid,
          name: 'Signed Documents',
          icon: '📝',
          isSystem: true,
        })
        .returning();
      folderId = inserted.id;
    }

    // Insert asset record
    await store
      .insert(assets)
      .values({
        id: newAssetId,
        ownerDid: signerDid,
        filename: originalAsset.filename,
        mimeType: originalAsset.mimeType,
        size: originalAsset.size,
        storagePath: newStoragePath,
        hash: originalAsset.hash,
        immutable: true,
        fairManifest: { access: 'private' },
        folderId,
        metadata: {
          signed: true,
          originalAssetId: originalAsset.id,
          documentId,
          signedAt: new Date().toISOString(),
        },
        status: 'active',
      })
      .returning();

    // Link to folder
    if (folderId) {
      await store.insert(assetFolders).values({ assetId: newAssetId, folderId }).onConflictDoNothing();
    }

    return newAssetId;
  } catch (err) {
    log.error({ err: String(err), signerDid, documentId }, 'Copy document to signer failed');
    if (options.required) throw new Error('Signed document copy could not be stored');
    return null;
  }
}
