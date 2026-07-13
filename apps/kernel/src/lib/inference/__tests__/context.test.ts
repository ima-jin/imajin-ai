import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const {
  mockUpdateSetWhere,
  mockUpdateSet,
  mockSelectWhereLimit,
  mockSelectWhere,
  mockSelectFrom,
  mockDbSelect,
  mockDbUpdate,
} = vi.hoisted(() => {
  const mockUpdateSetWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateSetWhere }));
  const mockSelectWhereLimit = vi.fn();
  const mockSelectWhere = vi.fn(() => ({ limit: mockSelectWhereLimit }));
  const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
  const mockDbSelect = vi.fn(() => ({ from: mockSelectFrom }));
  const mockDbUpdate = vi.fn(() => ({ set: mockUpdateSet }));
  return { mockUpdateSetWhere, mockUpdateSet, mockSelectWhereLimit, mockSelectWhere, mockSelectFrom, mockDbSelect, mockDbUpdate };
});

vi.mock('@/src/db', () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
  },
  assets: {},
  inferenceSessions: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => ({ type: 'eq' })),
}));

const mockListConnections = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/connections/list', () => ({
  listConnections: mockListConnections,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

// Node fs mock for reading the audio file in transcribeAsset
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('audio bytes')),
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { gatherContext } from '../context';

// ─── Helpers ────────────────────────────────────────────────────────────────

const AUDIO_ASSET = {
  id: 'asset_abc',
  mimeType: 'audio/webm',
  storagePath: '/mnt/media/farmer/assets/asset_abc.webm',
  filename: 'voice.webm',
  metadata: {},
};

const TEXT_ASSET = {
  id: 'asset_txt',
  mimeType: 'text/plain',
  storagePath: '/mnt/media/farmer/assets/asset_txt.txt',
  filename: 'note.txt',
  metadata: {},
};

function mockAsset(asset: typeof AUDIO_ASSET | typeof TEXT_ASSET) {
  mockSelectWhereLimit.mockResolvedValueOnce([asset]);
}

function mockConnections(dids: string[]) {
  mockListConnections.mockResolvedValueOnce(
    dids.map((did, i) => ({
      did,
      connectedAt: new Date(Date.now() - i * 1000),
      handle: null,
      name: null,
      nickname: null,
    })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSet.mockImplementation(() => ({ where: mockUpdateSetWhere }));
  mockUpdateSetWhere.mockResolvedValue(undefined);
  mockSelectFrom.mockImplementation(() => ({ where: mockSelectWhere }));
  mockSelectWhere.mockImplementation(() => ({ limit: mockSelectWhereLimit }));
  mockListConnections.mockResolvedValue([]);
  mockDbUpdate.mockImplementation(() => ({ set: mockUpdateSet }));
  mockDbSelect.mockImplementation(() => ({ from: mockSelectFrom }));
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('gatherContext', () => {
  describe('transcription', () => {
    it('uses filename as transcript for non-audio assets (text capture)', async () => {
      mockAsset(TEXT_ASSET);
      mockConnections([]);

      const ctx = await gatherContext('session_1', 'asset_txt', 'did:imajin:owner');

      expect(ctx.transcript).toBe('note.txt');
    });

    it('returns empty string transcript when GPU_NODE_URL is not configured', async () => {
      const savedUrl = process.env['GPU_NODE_URL'];
      delete process.env['GPU_NODE_URL'];

      mockAsset(AUDIO_ASSET);
      mockConnections([]);

      const ctx = await gatherContext('session_1', 'asset_abc', 'did:imajin:owner');

      expect(ctx.transcript).toBe('voice.webm'); // falls back to filename stub
      process.env['GPU_NODE_URL'] = savedUrl;
    });

    it('calls the GPU Whisper endpoint when GPU_NODE_URL is set', async () => {
      process.env['GPU_NODE_URL'] = 'http://gpu.local';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ text: 'received 50kg maize seed' }), { status: 200 }),
      );

      mockAsset(AUDIO_ASSET);
      mockConnections([]);

      const ctx = await gatherContext('session_1', 'asset_abc', 'did:imajin:owner');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toContain('/api/whisper/transcribe');
      expect(ctx.transcript).toBe('received 50kg maize seed');

      fetchSpy.mockRestore();
      delete process.env['GPU_NODE_URL'];
    });

    it('falls back to empty string if Whisper endpoint returns an error', async () => {
      process.env['GPU_NODE_URL'] = 'http://gpu.local';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Service unavailable', { status: 503 }),
      );

      mockAsset(AUDIO_ASSET);
      mockConnections([]);

      const ctx = await gatherContext('session_1', 'asset_abc', 'did:imajin:owner');

      expect(ctx.transcript).toBe('');
      delete process.env['GPU_NODE_URL'];
    });
  });

  describe('telemetry priors', () => {
    it('includes up to 5 recent connection DIDs sorted by recency', async () => {
      mockAsset(TEXT_ASSET);
      const dids = ['did:1', 'did:2', 'did:3', 'did:4', 'did:5', 'did:6'];
      mockConnections(dids);

      const ctx = await gatherContext('session_1', 'asset_txt', 'did:imajin:owner');

      // MAX_PRIOR_CONNECTIONS = 5
      expect(ctx.priors.recentConnectionDids).toHaveLength(5);
      // Most recent first: did:1 was connectedAt largest timestamp
      expect(ctx.priors.recentConnectionDids[0]).toBe('did:1');
    });

    it('returns empty recentConnectionDids when listConnections fails (non-fatal)', async () => {
      mockAsset(TEXT_ASSET);
      mockListConnections.mockRejectedValueOnce(new Error('DB error'));

      const ctx = await gatherContext('session_1', 'asset_txt', 'did:imajin:owner');

      expect(ctx.priors.recentConnectionDids).toEqual([]);
    });

    it('sets a valid timeOfDay bucket', async () => {
      mockAsset(TEXT_ASSET);
      mockConnections([]);

      const ctx = await gatherContext('session_1', 'asset_txt', 'did:imajin:owner');

      expect(['morning', 'afternoon', 'evening', 'night']).toContain(ctx.priors.timeOfDay);
    });
  });

  describe('session update', () => {
    it('advances session status to inferring with transcript and priors', async () => {
      mockAsset(TEXT_ASSET);
      mockConnections([]);

      await gatherContext('session_1', 'asset_txt', 'did:imajin:owner');

      // db.update is called twice: once for asset metadata pin (fire-and-forget)
      // and once for the session status advance (awaited).
      const sessionCall = mockUpdateSet.mock.calls.find(
        (c) => (c[0] as Record<string, unknown>)['status'] === 'inferring',
      );
      expect(sessionCall).toBeDefined();
      const setArg = sessionCall![0] as Record<string, unknown>;
      expect(setArg['transcript']).toBe('note.txt');
      expect(setArg['priors']).toBeDefined();
    });
  });

  describe('return value', () => {
    it('returns an InferenceContext with all required fields', async () => {
      mockAsset(TEXT_ASSET);
      mockConnections(['did:imajin:alice']);

      const ctx = await gatherContext('session_x', 'asset_txt', 'did:imajin:owner');

      expect(ctx.sessionId).toBe('session_x');
      expect(ctx.assetId).toBe('asset_txt');
      expect(ctx.transcript).toBeDefined();
      expect(ctx.priors.recentConnectionDids).toContain('did:imajin:alice');
    });
  });
});
