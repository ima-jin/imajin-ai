import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestionAttestation } from '../engine/types';

const { getAttestationInternalApiKeyMock, markAttestationKeyUsedForForwardingMock } = vi.hoisted(() => ({
  getAttestationInternalApiKeyMock: vi.fn(),
  markAttestationKeyUsedForForwardingMock: vi.fn(),
}));

vi.mock('../lib/attestation-key', () => ({
  getAttestationInternalApiKey: getAttestationInternalApiKeyMock,
  markAttestationKeyUsedForForwarding: markAttestationKeyUsedForForwardingMock,
}));

const { forwardIngestionAttestation } = await import('../lib/attestation-forwarder');

const ORIGINAL_AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;

function attestation(overrides: Partial<IngestionAttestation> = {}): IngestionAttestation {
  return {
    id: 'ing_test',
    source: 'github:ima-jin/imajin-ai',
    corpusDid: 'did:example:alice',
    ingesterDid: 'did:example:alice',
    contentHash: 'abc123',
    threadCount: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    signature: 'deadbeef',
    ...overrides,
  };
}

describe('forwardIngestionAttestation (#1750, vault-sourced key via #2245)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SERVICE_URL = 'http://kernel.test';
    getAttestationInternalApiKeyMock.mockReturnValue('test-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_AUTH_SERVICE_URL === undefined) delete process.env.AUTH_SERVICE_URL;
    else process.env.AUTH_SERVICE_URL = ORIGINAL_AUTH_SERVICE_URL;
  });

  it('posts to the kernel internal attestations endpoint with the corpus.ingested type and bearer auth, then marks the key used', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ id: 'att_kernel123' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await forwardIngestionAttestation(attestation(), 'did:imajin:corpus-service');

    expect(result).toEqual({ ok: true, kernelAttestationId: 'att_kernel123' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://kernel.test/api/attestations/internal',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    expect(markAttestationKeyUsedForForwardingMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      issuer_did: 'did:imajin:corpus-service',
      subject_did: 'did:example:alice',
      type: 'corpus.ingested',
      context_id: 'github:ima-jin/imajin-ai',
    });
  });

  it('returns ok:false without throwing when the kernel responds with a non-2xx status, and never marks the key used', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));

    const result = await forwardIngestionAttestation(attestation(), 'did:imajin:corpus-service');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(markAttestationKeyUsedForForwardingMock).not.toHaveBeenCalled();
  });

  it('returns ok:false without throwing on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const result = await forwardIngestionAttestation(attestation(), 'did:imajin:corpus-service');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('returns ok:false when AUTH_SERVICE_URL or the vault-sourced key is unset, without calling fetch', async () => {
    getAttestationInternalApiKeyMock.mockReturnValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await forwardIngestionAttestation(attestation(), 'did:imajin:corpus-service');

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
