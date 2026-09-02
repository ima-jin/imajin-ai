import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeypair, crypto } from '@imajin/auth';
import { mintAppToken, RouteTokenProvider } from '../src/token-provider.js';

const APP_DID = 'did:imajin:openclaw-app';
const ATTESTATION_ID = 'att_test_infer_completions';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('mintAppToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('signs the raw challenge string with the app.authorized attestation flow (not the service-token flow)', async () => {
    const keypair = generateKeypair();
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | null = null;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init!.body as string);
      return jsonResponse({ token: 'signed.app.jwt', expiresIn: 600, scopes: ['infer:completions'] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mintAppToken('https://kernel.test', APP_DID, keypair.privateKey, ATTESTATION_ID);

    expect(capturedUrl).toBe('https://kernel.test/auth/api/apps/token');
    expect(result).toEqual({ token: 'signed.app.jwt', expiresIn: 600, scopes: ['infer:completions'] });

    const { appDid, attestationId, scope, nonce, timestamp, signature } = capturedBody as {
      appDid: string;
      attestationId: string;
      scope: string;
      nonce: string;
      timestamp: string;
      signature: string;
    };
    expect(appDid).toBe(APP_DID);
    expect(attestationId).toBe(ATTESTATION_ID);
    expect(scope).toBe('infer:completions');
    expect(nonce.length).toBeGreaterThanOrEqual(16);

    // Pin the exact challenge shape the kernel's POST /auth/api/apps/token verifies against.
    const challenge = `${appDid}:${attestationId}:${nonce}:${timestamp}`;
    const valid = await crypto.verify(signature, challenge, keypair.publicKey);
    expect(valid).toBe(true);
  });

  it('throws a descriptive error (without leaking the signature) when the kernel rejects the mint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'Authorization has been revoked' }, 403)),
    );
    const keypair = generateKeypair();

    await expect(mintAppToken('https://kernel.test', APP_DID, keypair.privateKey, ATTESTATION_ID)).rejects.toThrow(
      /403.*Authorization has been revoked/,
    );
  });
});

describe('RouteTokenProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mints once and caches the token for subsequent calls within the TTL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: 'tok-1', expiresIn: 600, scopes: ['infer:completions'] }));
    vi.stubGlobal('fetch', fetchMock);

    let now = 0;
    const provider = new RouteTokenProvider('https://kernel.test', APP_DID, generateKeypair().privateKey, ATTESTATION_ID, 60_000, () => now);

    const first = await provider.getToken();
    now += 60_000; // well within the 600s TTL minus the 60s skew
    const second = await provider.getToken();

    expect(first).toBe('tok-1');
    expect(second).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes once the cached token is within the skew window of expiring', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return jsonResponse({ token: `tok-${call}`, expiresIn: 600, scopes: ['infer:completions'] });
    });
    vi.stubGlobal('fetch', fetchMock);

    let now = 0;
    const provider = new RouteTokenProvider('https://kernel.test', APP_DID, generateKeypair().privateKey, ATTESTATION_ID, 60_000, () => now);

    const first = await provider.getToken();
    now += 600_000 - 60_000 + 1; // just past the refresh skew boundary
    const second = await provider.getToken();

    expect(first).toBe('tok-1');
    expect(second).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('mints a fresh token after invalidate() even if the cached one has not expired', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        return jsonResponse({ token: `tok-${call}`, expiresIn: 600, scopes: ['infer:completions'] });
      }),
    );

    const provider = new RouteTokenProvider('https://kernel.test', APP_DID, generateKeypair().privateKey, ATTESTATION_ID);
    const first = await provider.getToken();
    provider.invalidate();
    const second = await provider.getToken();

    expect(first).toBe('tok-1');
    expect(second).toBe('tok-2');
  });

  it('coalesces concurrent getToken() calls onto a single mint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ token: 'tok-concurrent', expiresIn: 600, scopes: ['infer:completions'] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new RouteTokenProvider('https://kernel.test', APP_DID, generateKeypair().privateKey, ATTESTATION_ID);
    const [a, b, c] = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);

    expect([a, b, c]).toEqual(['tok-concurrent', 'tok-concurrent', 'tok-concurrent']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
