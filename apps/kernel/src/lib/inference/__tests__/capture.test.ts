import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.mock factories are hoisted, so all referenced variables must be hoisted too.
const { mockInsert, mockInsertValues } = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));
  return { mockInsert, mockInsertValues };
});

vi.mock('@/src/db', () => ({
  db: { insert: mockInsert },
  inferenceSessions: {},
}));

const mockCreateAsset = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/media/create-asset', () => ({
  createAsset: mockCreateAsset,
}));

const mockPublishContentEvent = vi.hoisted(() => vi.fn());
vi.mock('@imajin/dfos', () => ({
  publishContentEvent: mockPublishContentEvent,
}));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'mockednanoid16') }));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { captureGesture } from '../capture';

// ─── Helpers ────────────────────────────────────────────────────────────────

const BASE_INPUT = {
  buffer: Buffer.from('audio data'),
  filename: 'voice.webm',
  mimeType: 'audio/webm',
  ownerDid: 'did:imajin:farmer',
  vocabularyName: 'agrifortress',
};

const MOCK_ASSET = {
  id: 'asset_abc123',
  ownerDid: 'did:imajin:farmer',
  filename: 'voice.webm',
  mimeType: 'audio/webm',
  cid: 'bafytest',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateAsset.mockResolvedValue({ asset: MOCK_ASSET, deduplicated: false });
  mockPublishContentEvent.mockResolvedValue({ eventId: 'dfos_evt_1' });
  mockInsert.mockImplementation(() => ({ values: mockInsertValues }));
  mockInsertValues.mockResolvedValue(undefined);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('captureGesture', () => {
  it('calls createAsset with private access and voice context for audio', async () => {
    const result = await captureGesture(BASE_INPUT);

    expect(mockCreateAsset).toHaveBeenCalledOnce();
    const callArgs = mockCreateAsset.mock.calls[0][0];
    expect(callArgs.ownerDid).toBe('did:imajin:farmer');
    expect(callArgs.mimeType).toBe('audio/webm');
    expect(callArgs.context?.feature).toBe('voice');
    expect(callArgs.access).toBe('private');
    expect(callArgs.dedup).toBe(false);

    expect(result.assetId).toBe('asset_abc123');
    expect(result.ownerDid).toBe('did:imajin:farmer');
  });

  it('returns kind=voice for audio/* MIME type', async () => {
    const result = await captureGesture({ ...BASE_INPUT, mimeType: 'audio/mp4' });
    expect(result.kind).toBe('voice');
  });

  it('returns kind=photo for image/* MIME type', async () => {
    const result = await captureGesture({ ...BASE_INPUT, mimeType: 'image/jpeg', filename: 'photo.jpg' });
    expect(result.kind).toBe('photo');
  });

  it('returns kind=text for text/* MIME type', async () => {
    const result = await captureGesture({ ...BASE_INPUT, mimeType: 'text/plain', filename: 'note.txt' });
    expect(result.kind).toBe('text');
  });

  it('returns kind=file for other MIME types', async () => {
    const result = await captureGesture({ ...BASE_INPUT, mimeType: 'application/pdf', filename: 'doc.pdf' });
    expect(result.kind).toBe('file');
  });

  it('inserts an inference_sessions row with status=capturing', async () => {
    await captureGesture(BASE_INPUT);

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsertValues).toHaveBeenCalledOnce();
    const rowArg = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(rowArg.ownerDid).toBe('did:imajin:farmer');
    expect(rowArg.vocabularyName).toBe('agrifortress');
    expect(rowArg.assetId).toBe('asset_abc123');
    expect(rowArg.status).toBe('capturing');
    expect(rowArg.id).toMatch(/^session_/);
  });

  it('publishes inference.capture DFOS event with correct payload', async () => {
    await captureGesture(BASE_INPUT);

    expect(mockPublishContentEvent).toHaveBeenCalledOnce();
    const { topic, payload } = mockPublishContentEvent.mock.calls[0][0] as { topic: string; payload: Record<string, unknown> };
    expect(topic).toBe('inference.capture');
    expect(payload['assetId']).toBe('asset_abc123');
    expect(payload['ownerDid']).toBe('did:imajin:farmer');
    expect(payload['kind']).toBe('voice');
    expect(payload['vocabularyName']).toBe('agrifortress');
  });

  it('returns a CaptureEvent with sessionId, assetId, kind, ownerDid', async () => {
    const result = await captureGesture(BASE_INPUT);

    expect(result).toMatchObject({
      assetId: 'asset_abc123',
      kind: 'voice',
      ownerDid: 'did:imajin:farmer',
    });
    expect(result.sessionId).toMatch(/^session_/);
  });

  it('does not throw if DFOS publish rejects (non-fatal)', async () => {
    mockPublishContentEvent.mockRejectedValue(new Error('DFOS down'));
    // Should not throw — DFOS is fire-and-forget.
    await expect(captureGesture(BASE_INPUT)).resolves.toBeDefined();
  });
});
