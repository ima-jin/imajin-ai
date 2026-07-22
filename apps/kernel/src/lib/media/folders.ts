/**
 * Shared folder helpers for media assets.
 *
 * Extracted from create-asset.ts so scope-manifest publishers can folder-assign
 * their assets (e.g. into `.grants`) without duplicating the get-or-create logic.
 */
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createLogger } from '@imajin/logger';
import { db, folders, assetFolders } from '@/src/db';

const log = createLogger('kernel');

/** Resolve (get-or-create, race-safe) a system folder id for the given name. */
export async function getOrCreateSystemFolder(
  ownerDid: string,
  name: string,
  icon: string,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerDid, ownerDid), eq(folders.name, name), eq(folders.isSystem, true)))
    .limit(1);
  if (existing) return existing.id;

  const folderId = `folder_${nanoid(16)}`;
  const [inserted] = await db
    .insert(folders)
    .values({ id: folderId, ownerDid, name, icon, isSystem: true })
    .onConflictDoNothing()
    .returning();
  if (inserted) return folderId;

  // Lost the insert race — re-read.
  const [retry] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerDid, ownerDid), eq(folders.name, name), eq(folders.isSystem, true)))
    .limit(1);
  return retry?.id ?? folderId;
}

/**
 * Add an asset to the `.grants` system folder (get-or-create, non-fatal).
 *
 * All scope-manifest assets (MCP, GitHub, …) are routed here so they live in a
 * dedicated folder rather than polluting the asset root (#1394).
 */
export async function addAssetToGrantsFolder(ownerDid: string, assetId: string): Promise<void> {
  try {
    const folderId = await getOrCreateSystemFolder(ownerDid, '.grants', '🔑');
    await db.insert(assetFolders).values({ assetId, folderId }).onConflictDoNothing();
  } catch (err) {
    // Non-fatal: folder assignment failure must never break the publish path.
    log.error({ err: String(err), assetId }, '.grants folder assignment failed (non-fatal)');
  }
}
