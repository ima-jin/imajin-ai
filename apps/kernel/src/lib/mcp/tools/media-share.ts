import type { McpTool } from '../types';
import { str, json } from './utils';
import { applyGrants } from '../../media/apply-grants';

/**
 * Media SHARE tool for the MCP connector (#1195).
 *
 * media_grant_access adds (or removes) a DID from an asset's allowedDids list,
 * auto-flipping access to trust-graph on grant and back to private when the last
 * DID is removed. Owner-only — verified inside applyGrants.
 *
 * Gated by media:share (distinct from media:write — sharing crosses a sovereignty
 * boundary: it discloses content to a DID that could not read it before).
 *
 * Typical Claude flow:
 *   1. connections_list → find Eric's DID
 *   2. media_list / media_get → find the asset id
 *   3. media_grant_access(id, eric_did) → done
 *
 * The optional `revoke` flag removes the DID instead of adding it (same scope,
 * symmetric operation, minimal surface area).
 */


const grantAccessTool: McpTool = {
  name: 'media_grant_access',
  requiredScope: 'media:share',
  description:
    'Grant (or revoke) access to one of your assets for another person identified by DID. ' +
    'Pass revoke: true to remove access instead of adding it. ' +
    'Owner-only: you can only share assets you own. ' +
    'Granting auto-switches the asset to trust-graph access; revoking the last DID reverts to private.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Asset id (asset_...) to share' },
      did: { type: 'string', description: 'DID of the person to grant or revoke access for' },
      revoke: { type: 'boolean', description: 'Set true to remove access instead of granting it' },
    },
    required: ['id', 'did'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const assetId = str(args, 'id');
    if (!assetId) throw new Error('id is required');
    const targetDid = str(args, 'did');
    if (!targetDid) throw new Error('did is required');
    const revoke = args.revoke === true;

    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL ??
      process.env.MEDIA_PUBLIC_URL ??
      '';

    const add = revoke ? [] : [targetDid];
    const remove = revoke ? [targetDid] : [];

    const result = await applyGrants(assetId, ctx.did, add, remove, baseUrl);
    if (!result.ok) throw new Error(result.message);

    const a = result.asset;
    return json({
      id: a.id,
      filename: a.filename,
      access: (a.fairManifest as { access?: { type?: string } } | null)?.access?.type ?? 'trust-graph',
      ownerDid: a.ownerDid,
      [revoke ? 'revokedDid' : 'grantedDid']: targetDid,
    });
  },
};

export const mediaShareTools: McpTool[] = [grantAccessTool];
