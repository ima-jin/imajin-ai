import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../mcp-grant', () => ({ requireMcpGrant: vi.fn().mockResolvedValue(undefined) }));

const mockTranscribeAsset = vi.fn();
vi.mock('../../media/transcribe-asset', () => ({
  transcribeAsset: (...args: unknown[]) => mockTranscribeAsset(...args),
}));

import { mediaTranscribeTools } from '../tools/media-transcribe';
import { requireMcpGrant } from '../mcp-grant';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ctx: McpToolContext = {
  did: 'did:imajin:user',
  appDid: 'did:imajin:app',
  scopes: new Set(['media:read']),
};

const tool = mediaTranscribeTools.find((t) => t.name === 'media_transcribe')!;

function parseResult(content: McpContent[]) {
  return JSON.parse(content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('media_transcribe', () => {
  it('requires media:read grant and an id', async () => {
    expect(tool.requiredScope).toBe('media:read');
    expect(tool.inputSchema.required).toEqual(['id']);
    await expect(tool.handler({}, ctx)).rejects.toThrow('id is required');
    expect(mockTranscribeAsset).not.toHaveBeenCalled();
  });

  it('checks the MCP scope-manifest grant before transcribing', async () => {
    mockTranscribeAsset.mockResolvedValueOnce({
      ok: true,
      assetId: 'asset_audio',
      transcript: { text: 'hi', segments: [], transcribedAt: '2026-01-01T00:00:00.000Z' },
      cached: false,
    });
    await tool.handler({ id: 'asset_audio' }, ctx);
    expect(requireMcpGrant).toHaveBeenCalledWith(ctx.did, 'media:read', ctx.appDid);
  });

  it('returns the transcript asset ref on success', async () => {
    const transcript = { text: 'hello world', segments: [{ start: 0, end: 1, text: 'hello' }], transcribedAt: '2026-01-01T00:00:00.000Z' };
    mockTranscribeAsset.mockResolvedValueOnce({ ok: true, assetId: 'asset_audio', transcript, cached: false });

    const res = await tool.handler({ id: 'asset_audio' }, ctx);
    const out = parseResult(res as McpContent[]);

    expect(mockTranscribeAsset).toHaveBeenCalledWith('asset_audio', ctx.did);
    expect(out).toEqual({ id: 'asset_audio', transcript, cached: false });
  });

  it('surfaces a cached transcript', async () => {
    const transcript = { text: 'cached text', segments: [], transcribedAt: '2026-01-01T00:00:00.000Z' };
    mockTranscribeAsset.mockResolvedValueOnce({ ok: true, assetId: 'asset_audio', transcript, cached: true });

    const res = await tool.handler({ id: 'asset_audio' }, ctx);
    const out = parseResult(res as McpContent[]);

    expect(out.cached).toBe(true);
  });

  it('throws "Asset not found" for a missing asset', async () => {
    mockTranscribeAsset.mockResolvedValueOnce({ ok: false, status: 404, message: 'Asset not found' });
    await expect(tool.handler({ id: 'asset_missing' }, ctx)).rejects.toThrow('Asset not found');
  });

  it('throws "Not your asset" when the caller does not own the asset', async () => {
    mockTranscribeAsset.mockResolvedValueOnce({ ok: false, status: 403, message: 'Not your asset' });
    await expect(tool.handler({ id: 'asset_other' }, ctx)).rejects.toThrow('Not your asset');
  });

  it('throws for a non audio/video asset', async () => {
    mockTranscribeAsset.mockResolvedValueOnce({ ok: false, status: 400, message: 'Not an audio/video asset (text/plain)' });
    await expect(tool.handler({ id: 'asset_text' }, ctx)).rejects.toThrow('Not an audio/video asset');
  });
});
