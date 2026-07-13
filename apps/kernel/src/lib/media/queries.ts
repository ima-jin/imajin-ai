import { readFile } from 'node:fs/promises';
import { and, eq, inArray, asc, desc, ilike, like } from 'drizzle-orm';
import { db, assets, folders, assetFolders, type Asset } from '@/src/db';
import type { FairManifest } from '@imajin/fair';
import { authorizeAssetRead } from './authorize-read';

/**
 * In-process media READ queries (#1166).
 *
 * These are the data accessors the MCP media tools call directly with the
 * caller's DID — no HTTP self-calls. Per-asset authorization is delegated to
 * authorizeAssetRead (read-access decision + conversation membership); these
 * helpers only handle scoping/pagination and apply that decision when listing
 * across owners.
 */

export interface ListOptions {
  type?: string; // mime prefix, e.g. "image" matches image/*
  search?: string; // case-insensitive filename substring
  folderId?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function normLimit(n?: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(n)), MAX_LIMIT);
}

function normOffset(n?: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** The `.fair` access descriptor for an asset row (defaults to private). */
export function assetAccess(asset: Asset): FairManifest['access'] {
  return (asset.fairManifest as FairManifest | null)?.access ?? 'private';
}

/** Active assets owned by `ownerDid` (the caller's own library). */
export async function listOwnedAssets(ownerDid: string, opts: ListOptions = {}): Promise<Asset[]> {
  const limit = normLimit(opts.limit);
  const offset = normOffset(opts.offset);
  const order = opts.order === 'asc' ? asc(assets.createdAt) : desc(assets.createdAt);

  const conditions = [eq(assets.ownerDid, ownerDid), eq(assets.status, 'active')];
  if (opts.type) conditions.push(like(assets.mimeType, `${opts.type}/%`));
  if (opts.search) conditions.push(ilike(assets.filename, `%${opts.search}%`));

  if (opts.folderId) {
    const links = await db
      .select({ assetId: assetFolders.assetId })
      .from(assetFolders)
      .where(eq(assetFolders.folderId, opts.folderId));
    const ids = links.map((l) => l.assetId);
    if (ids.length === 0) return [];
    conditions.push(inArray(assets.id, ids));
  }

  return db.select().from(assets).where(and(...conditions)).orderBy(order).limit(limit).offset(offset);
}

/** A single active asset by id (no authorization applied — caller must gate). */
export async function getActiveAsset(id: string): Promise<Asset | undefined> {
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.status, 'active')))
    .limit(1);
  return asset;
}

/**
 * Assets owned by `targetDid` that `requesterDid` is allowed to read.
 * Own DID → all active assets; otherwise filtered through authorizeAssetRead.
 */
export async function listVisibleAssetsOfDid(
  targetDid: string,
  requesterDid: string,
  opts: ListOptions = {},
): Promise<Asset[]> {
  const rows = await listOwnedAssets(targetDid, opts);
  if (targetDid === requesterDid) return rows;
  const decisions = await Promise.all(
    rows.map((a) => authorizeAssetRead({ ownerDid: a.ownerDid, access: assetAccess(a), metadata: a.metadata }, requesterDid)),
  );
  return rows.filter((_, i) => decisions[i].allowed);
}

/** Active assets in a folder that `requesterDid` is allowed to read. */
export async function listAssetsInFolder(
  folderId: string,
  requesterDid: string,
  opts: ListOptions = {},
): Promise<Asset[]> {
  const [folder] = await db.select({ id: folders.id }).from(folders).where(eq(folders.id, folderId)).limit(1);
  if (!folder) return [];

  const links = await db
    .select({ assetId: assetFolders.assetId })
    .from(assetFolders)
    .where(eq(assetFolders.folderId, folderId));
  const ids = links.map((l) => l.assetId);
  if (ids.length === 0) return [];

  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.status, 'active'), inArray(assets.id, ids)))
    .orderBy(desc(assets.createdAt))
    .limit(normLimit(opts.limit))
    .offset(normOffset(opts.offset));

  const decisions = await Promise.all(
    rows.map((a) => authorizeAssetRead({ ownerDid: a.ownerDid, access: assetAccess(a), metadata: a.metadata }, requesterDid)),
  );
  return rows.filter((_, i) => decisions[i].allowed);
}

/** Whether an asset's bytes are safe to return as UTF-8 text. */
export function isTextReadable(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json';
}

/** Read an asset's UTF-8 text content from storage. */
export async function readAssetTextContent(asset: Asset): Promise<string> {
  return readFile(asset.storagePath, 'utf-8');
}
