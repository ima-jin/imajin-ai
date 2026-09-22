import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockLimit = vi.fn();
const mockSelectWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockSelectWhere }));
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockFrom })),
    update: vi.fn(() => ({ set: mockSet })),
  },
  assets: {},
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

const mockReadFile = vi.fn();
vi.mock('node:fs/promises', () => ({ readFile: (...args: unknown[]) => mockReadFile(...args) }));

import { transcribeAsset } from '../transcribe-asset';

// ─── Helpers ───────────────────────────────────────────────────────────────

const OWNER = 'did:imajin:owner';

function setupAsset(overrides: Record<string, unknown> = {}) {
  const asset = {
    id: 'asset_audio',
    ownerDid: OWNER,
    mimeType: 'audio/mpeg',
    filename: 'memo.mp3',
    storagePath: '/mnt/media/did_imajin_owner/assets/asset_audio.mp3',
    metadata: {},
    ...overrides,
  };
  mockLimit.mockResolvedValueOnce([asset]);
  return asset;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHISPER_URL = 'http://gpu-node.local';
  delete process.env.WHISPER_AUTH_TOKEN;
  mockReadFile.mockResolvedValue(Buffer.from('fake audio bytes'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WHISPER_URL;
  delete process.env.WHISPER_AUTH_TOKEN;
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('transcribeAsset — config + not-found', () => {
  it('returns 503 when WHISPER_URL is not configured', async () => {
    delete process.env.WHISPER_URL;
    const result = await transcribeAsset('asset_audio', OWNER);
    expect(result).toEqual({ ok: false, status: 503, message: 'Transcription service unavailable' });
  });

  it('returns 404 when the asset does not exist', async () => {
    mockLimit.mockResolvedValueOnce([]);
    const result = await transcribeAsset('asset_missing', OWNER);
    expect(result).toEqual({ ok: false, status: 404, message: 'Asset not found' });
  });
});

describe('transcribeAsset — ownership + mime gating', () => {
  it('returns 403 when the caller does not own the asset', async () => {
    setupAsset({ ownerDid: 'did:imajin:someone-else' });
    const result = await transcribeAsset('asset_audio', OWNER);
    expect(result).toEqual({ ok: false, status: 403, message: 'Not your asset' });
  });

  it('returns 400 for a non audio/video asset', async () => {
    setupAsset({ mimeType: 'text/markdown' });
    const result = await transcribeAsset('asset_audio', OWNER);
    expect(result).toEqual({ ok: false, status: 400, message: 'Not an audio/video asset (text/markdown)' });
  });
});

describe('transcribeAsset — cached transcript', () => {
  it('returns the pinned transcript without calling Whisper', async () => {
    const cached = { text: 'hello world', segments: [], transcribedAt: '2026-01-01T00:00:00.000Z' };
    setupAsset({ metadata: { transcript: cached } });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await transcribeAsset('asset_audio', OWNER);

    expect(result).toEqual({ ok: true, assetId: 'asset_audio', transcript: cached, cached: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('transcribeAsset — file lookup', () => {
  it('returns 404 when the asset bytes are missing from disk', async () => {
    setupAsset();
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const result = await transcribeAsset('asset_audio', OWNER);
    expect(result).toEqual({ ok: false, status: 404, message: 'Asset file not found on disk' });
  });
});

describe('transcribeAsset — Whisper relay', () => {
  it('relays bytes to Whisper, pins the transcript, and returns cached: false', async () => {
    setupAsset();
    const whisperJson = {
      text: 'hello world',
      language: 'en',
      language_probability: 0.98,
      duration_seconds: 12.3,
      processing_time_ms: 456,
      model: 'whisper-large',
      segments: [{ start: 0, end: 1.2, text: 'hello' }],
    };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => whisperJson });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await transcribeAsset('asset_audio', OWNER);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://gpu-node.local/api/whisper/transcribe',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Caller-DID': OWNER }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cached).toBe(false);
    expect(result.transcript.text).toBe('hello world');
    expect(result.transcript.segments).toEqual([{ start: 0, end: 1.2, text: 'hello' }]);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ transcript: expect.objectContaining({ text: 'hello world' }) }) }),
    );
  });

  it('includes a Bearer header when WHISPER_AUTH_TOKEN is set', async () => {
    process.env.WHISPER_AUTH_TOKEN = 'secret-token';
    setupAsset();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hi', segments: [] }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    await transcribeAsset('asset_audio', OWNER);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }) }),
    );
  });

  it('returns 502 when Whisper responds with an error', async () => {
    setupAsset();
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await transcribeAsset('asset_audio', OWNER);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(result.message).toContain('boom');
  });

  it('returns 502 when Whisper is unreachable', async () => {
    setupAsset();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await transcribeAsset('asset_audio', OWNER);

    expect(result).toEqual({ ok: false, status: 502, message: 'ECONNREFUSED' });
  });
});
