import { describe, it, expect, beforeAll, vi, beforeEach, afterEach } from 'vitest';
import { publishContentEvent, getContentEvent } from '@imajin/dfos';
import { generateKeypair } from '@imajin/auth';

// ─── Setup ─────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeAll(() => {
  process.env.DFOS_RELAY_URL = 'https://relay.test.dfos';
});

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.DFOS_PRIVATE_KEY_HEX;
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function mockFetchResponse(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

// ─── publishContentEvent ───────────────────────────────────────────────────

describe('publishContentEvent', () => {
  it('publishes a fair.manifest.published event and returns eventId + anchoredAt', async () => {
    const keypair = generateKeypair();
    process.env.DFOS_PRIVATE_KEY_HEX = keypair.privateKey;

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockReturnValueOnce(
      mockFetchResponse(200, {
        eventId: 'evt_test1234567890',
        anchoredAt: '2026-05-10T20:38:00.000Z',
      })
    );

    const result = await publishContentEvent({
      topic: 'fair.manifest.published',
      payload: {
        assetId: 'asset_abc123',
        ownerDid: 'did:imajin:test',
        manifestDigest: 'sha256:abc123',
        manifestUrl: 'https://dev-media.imajin.ai/media/api/assets/asset_abc123/fair',
        fairVersion: '1.1',
        signedAt: '2026-05-10T20:38:00.000Z',
      },
    });

    expect(result.eventId).toBe('evt_test1234567890');
    expect(result.anchoredAt).toBe('2026-05-10T20:38:00.000Z');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://relay.test.dfos/api/v1/events');
    expect(init?.method).toBe('POST');

    const body = JSON.parse(init?.body as string);
    expect(body.topic).toBe('fair.manifest.published');
    expect(body.payload.assetId).toBe('asset_abc123');
    expect(body.signature).toMatch(/^[0-9a-f]{128}$/); // 64-byte hex = 128 chars
    expect(body.timestamp).toBeTruthy();
  });

  it('throws if DFOS_RELAY_URL is missing', async () => {
    const originalRelay = process.env.DFOS_RELAY_URL;
    delete process.env.DFOS_RELAY_URL;

    await expect(
      publishContentEvent({ topic: 'test', payload: {} })
    ).rejects.toThrow('DFOS_RELAY_URL is not configured');

    process.env.DFOS_RELAY_URL = originalRelay;
  });

  it('throws if DFOS_PRIVATE_KEY_HEX is missing', async () => {
    await expect(
      publishContentEvent({ topic: 'test', payload: {} })
    ).rejects.toThrow('DFOS_PRIVATE_KEY_HEX (or AUTH_PRIVATE_KEY) is not configured');
  });

  it('throws on relay error response', async () => {
    const keypair = generateKeypair();
    process.env.DFOS_PRIVATE_KEY_HEX = keypair.privateKey;

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockReturnValueOnce(
      mockFetchResponse(500, { error: 'Internal error' })
    );

    await expect(
      publishContentEvent({ topic: 'test', payload: {} })
    ).rejects.toThrow('DFOS relay returned 500');
  });
});

// ─── getContentEvent ───────────────────────────────────────────────────────

describe('getContentEvent', () => {
  it('fetches an event by id', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockReturnValueOnce(
      mockFetchResponse(200, {
        topic: 'fair.manifest.published',
        payload: { assetId: 'asset_abc' },
        anchoredAt: '2026-05-10T20:38:00.000Z',
        signature: 'sig_123',
      })
    );

    const result = await getContentEvent('evt_test123');

    expect(result).not.toBeNull();
    expect(result?.topic).toBe('fair.manifest.published');
    expect(result?.payload.assetId).toBe('asset_abc');
    expect(result?.anchoredAt).toBe('2026-05-10T20:38:00.000Z');
    expect(result?.signature).toBe('sig_123');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://relay.test.dfos/api/v1/events/evt_test123');
  });

  it('returns null for 404', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockReturnValueOnce(
      mockFetchResponse(404, { error: 'Not found' })
    );

    const result = await getContentEvent('evt_missing');
    expect(result).toBeNull();
  });

  it('throws on relay error response', async () => {
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockReturnValueOnce(
      mockFetchResponse(503, { error: 'Unavailable' })
    );

    await expect(getContentEvent('evt_err')).rejects.toThrow('DFOS relay returned 503');
  });
});
