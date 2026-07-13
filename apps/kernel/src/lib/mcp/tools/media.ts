import type { McpTool } from '../types';
import { str, num, json } from './utils';
import type { Asset } from '@/src/db';
import { getAccessType } from '@/src/lib/media/read-access';
import { authorizeAssetRead } from '@/src/lib/media/authorize-read';
import {
  listOwnedAssets,
  getActiveAsset,
  listVisibleAssetsOfDid,
  listAssetsInFolder,
  isTextReadable,
  readAssetTextContent,
  assetAccess,
  type ListOptions,
} from '@/src/lib/media/queries';

/**
 * Media READ tools for the MCP connector (#1166).
 *
 * Each tool resolves data with the caller's DID (ctx.did) and gates per-asset
 * reads through canReadAsset — the same decision the HTTP routes use. The
 * `media:read` scope is already enforced at the /mcp route before dispatch.
 *
 * Errors (not found / access denied) are thrown so the dispatcher returns an
 * MCP `isError: true` result the model can see.
 */


/** Safe, non-sensitive metadata view of an asset (no storagePath/fairPath). */
function summarize(asset: Asset) {
  return {
    id: asset.id,
    filename: asset.filename,
    mimeType: asset.mimeType,
    size: asset.size,
    access: getAccessType(assetAccess(asset)),
    ownerDid: asset.ownerDid,
    versionCount: asset.versionCount,
    classification: asset.classification,
    tags: asset.tags,
    cid: asset.cid,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

/** Load an active asset and authorize the caller, or throw a tool error. */
async function loadReadable(id: string, requesterDid: string): Promise<Asset> {
  const asset = await getActiveAsset(id);
  if (!asset) throw new Error('Asset not found');
  const decision = await authorizeAssetRead(
    { ownerDid: asset.ownerDid, access: assetAccess(asset), metadata: asset.metadata },
    requesterDid,
  );
  if (!decision.allowed) throw new Error(`Access denied: ${decision.reason}`);
  return asset;
}

const listTool: McpTool = {
  name: 'media_list',
  requiredScope: 'media:read',
  description:
    'List the media assets owned by your DID. Optional filters: type (mime prefix, e.g. "image"), search (filename substring), folderId, limit (max 200), offset.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      search: { type: 'string' },
      folderId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const opts: ListOptions = {
      type: str(args, 'type'),
      search: str(args, 'search'),
      folderId: str(args, 'folderId'),
      limit: num(args, 'limit'),
      offset: num(args, 'offset'),
    };
    const rows = await listOwnedAssets(ctx.did, opts);
    return json({ count: rows.length, assets: rows.map(summarize) });
  },
};

const getTool: McpTool = {
  name: 'media_get',
  requiredScope: 'media:read',
  description: 'Get metadata for a single asset by id. Respects access grants (owner, public, or trust-graph grant).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = str(args, 'id');
    if (!id) throw new Error('id is required');
    const asset = await loadReadable(id, ctx.did);
    return json(summarize(asset));
  },
};

const getContentTool: McpTool = {
  name: 'media_get_content',
  requiredScope: 'media:read',
  description:
    'Read the UTF-8 text content of a text/markdown/JSON asset by id. Respects access grants (owner or trust-graph grant).',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = str(args, 'id');
    if (!id) throw new Error('id is required');
    const asset = await loadReadable(id, ctx.did);
    if (!isTextReadable(asset.mimeType)) {
      throw new Error(`Not a text asset (${asset.mimeType})`);
    }
    const content = await readAssetTextContent(asset);
    return json({ id: asset.id, filename: asset.filename, mimeType: asset.mimeType, content });
  },
};

const resolveTool: McpTool = {
  name: 'media_resolve',
  requiredScope: 'media:read',
  description:
    'Resolve assets by folder or by owner DID. Provide folderId (assets in that folder you may read) OR did (assets owned by that DID you may read). Optional limit (max 200), offset.',
  inputSchema: {
    type: 'object',
    properties: {
      folderId: { type: 'string' },
      did: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const folderId = str(args, 'folderId');
    const did = str(args, 'did');
    const opts: ListOptions = { limit: num(args, 'limit'), offset: num(args, 'offset') };

    if (folderId) {
      const rows = await listAssetsInFolder(folderId, ctx.did, opts);
      return json({ folderId, count: rows.length, assets: rows.map(summarize) });
    }
    if (did) {
      const rows = await listVisibleAssetsOfDid(did, ctx.did, opts);
      return json({ did, count: rows.length, assets: rows.map(summarize) });
    }
    throw new Error('Provide either folderId or did');
  },
};

export const mediaTools: McpTool[] = [listTool, getTool, getContentTool, resolveTool];
