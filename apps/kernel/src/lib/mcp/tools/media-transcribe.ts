import type { McpTool } from '../types';
import { str, json } from './utils';
import { requireMcpGrant } from '../mcp-grant';
import { transcribeAsset } from '../../media/transcribe-asset';

/**
 * media_transcribe MCP tool (#2185).
 *
 * Thin mirror of the media service's existing per-asset transcribe pipeline
 * (GET /media/api/assets/[id]/transcribe, also used by the OpenClaw plugin's
 * `imajin_media` transcribe action) — no new route is invented. Calls the
 * shared transcribeAsset lib in-process with the caller's DID (owner-gated,
 * same convention as the other media MCP tools) and returns the transcript
 * asset ref: the asset id plus the pinned transcript (text + segments).
 */
const transcribeTool: McpTool = {
  name: 'media_transcribe',
  requiredScope: 'media:read',
  description:
    'Transcribe an audio/video asset you own via the media service Whisper pipeline. Returns the transcript ' +
    '(text + timed segments), pinning it to the asset so future calls return the cached result instantly. ' +
    'Owner-only; errors when the asset is not audio/video or was not found.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Asset id (asset_...) to transcribe' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    await requireMcpGrant(ctx.did, 'media:read', ctx.appDid);
    const id = str(args, 'id');
    if (!id) throw new Error('id is required');

    const result = await transcribeAsset(id, ctx.did);
    if (!result.ok) throw new Error(result.message);

    return json({
      id: result.assetId,
      transcript: result.transcript,
      cached: result.cached,
    });
  },
};

export const mediaTranscribeTools: McpTool[] = [transcribeTool];
