/**
 * Tests for `requestAppServiceToken` / `createAppServiceTokenProvider` (#2739) —
 * the server-side helper a registered app uses to mint its own app-service
 * token by proving possession of its signing key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { generateBootstrapKeypair } from '../src/ed25519';
import { createAppServiceTokenProvider, requestAppServiceToken } from '../src/app-service-token';

ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

const KERNEL_URL = 'https://kernel.test';
const APP_DID = 'did:imajin:app-events';
const keypair = generateBootstrapKeypair();

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)));
}

function tokenResponse(token = 'svc-token', expiresIn = 600, scopes: unknown = ['pay:settle']): Response {
  return new Response(JSON.stringify({ token, expiresIn, scopes }), { status: 200 });
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('requestAppServiceToken', () => {
  it('posts a proof-of-possession signature over `${appDid}:${nonce}:${timestamp}` and returns the minted token', async () => {
    const fetchMock = stubFetch(async () => tokenResponse());

    const result = await requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey });

    expect(result).toEqual({ token: 'svc-token', expiresIn: 600, scopes: ['pay:settle'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${KERNEL_URL}/auth/api/apps/token/service`);
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as { appDid: string; nonce: string; timestamp: string; signature: string };
    expect(body.appDid).toBe(APP_DID);
    expect(body.nonce.length).toBeGreaterThanOrEqual(16);
    expect(Math.abs(Date.now() - Date.parse(body.timestamp))).toBeLessThan(5_000);
    // The signature verifies against the app's PUBLIC key over exactly the challenge the kernel rebuilds.
    const challenge = new TextEncoder().encode(`${body.appDid}:${body.nonce}:${body.timestamp}`);
    expect(ed25519.verify(hexToBytes(body.signature), challenge, hexToBytes(keypair.publicKey))).toBe(true);
    // The private key itself never goes over the wire.
    expect(init.body as string).not.toContain(keypair.privateKey);
  });

  it('mints a fresh nonce on every call', async () => {
    const fetchMock = stubFetch(async () => tokenResponse());
    const options = { kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey };

    await requestAppServiceToken(options);
    await requestAppServiceToken(options);

    const nonces = fetchMock.mock.calls.map(([, init]) => (JSON.parse(init.body as string) as { nonce: string }).nonce);
    expect(new Set(nonces).size).toBe(2);
  });

  it('tolerates a trailing slash on kernelUrl and merges extra fetch options/headers', async () => {
    const fetchMock = stubFetch(async () => tokenResponse());

    await requestAppServiceToken({
      kernelUrl: `${KERNEL_URL}/`,
      appDid: APP_DID,
      privateKey: keypair.privateKey,
      fetchOptions: { headers: { 'x-trace': 'abc' }, cache: 'no-store' },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${KERNEL_URL}/auth/api/apps/token/service`);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'x-trace': 'abc' });
    expect(init.cache).toBe('no-store');
  });

  it('drops non-string scopes and defaults to none when the kernel omits them', async () => {
    stubFetch(async () => tokenResponse('t', 600, ['pay:settle', 7, null]));
    const mixed = await requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey });
    expect(mixed.scopes).toEqual(['pay:settle']);

    stubFetch(async () => tokenResponse('t', 600, null));
    const none = await requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey });
    expect(none.scopes).toEqual([]);
  });

  it('throws with only the kernel error string on a non-2xx response', async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: 'App is not active', secret: 'do-not-leak' }), { status: 403 }));

    const attempt = requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey });

    await expect(attempt).rejects.toThrow('requestAppServiceToken: token mint failed (App is not active)');
    await expect(attempt).rejects.not.toThrow(/do-not-leak/);
  });

  it('falls back to the status code when the error body is not JSON', async () => {
    stubFetch(async () => new Response('gateway down', { status: 502 }));

    await expect(
      requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey }),
    ).rejects.toThrow('token mint failed (status 502)');
  });

  it('throws when the kernel is unreachable, without leaking the key', async () => {
    stubFetch(async () => {
      throw new Error('network down');
    });

    const attempt = requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey });

    await expect(attempt).rejects.toThrow('could not reach the kernel (network down)');
    await expect(attempt).rejects.not.toThrow(keypair.privateKey);
  });

  it('throws on a malformed success response', async () => {
    stubFetch(async () => new Response(JSON.stringify({ token: 'only-a-token' }), { status: 200 }));
    await expect(
      requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey }),
    ).rejects.toThrow('response was malformed');

    stubFetch(async () => new Response('not json', { status: 200 }));
    await expect(
      requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey }),
    ).rejects.toThrow('response was malformed');
  });

  it('stringifies a non-Error network failure', async () => {
    stubFetch(async () => {
      throw 'boom'; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    await expect(
      requestAppServiceToken({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey }),
    ).rejects.toThrow('could not reach the kernel (boom)');
  });
});

describe('createAppServiceTokenProvider', () => {
  function provider(now: () => number, refreshRatio?: number) {
    return createAppServiceTokenProvider({ kernelUrl: KERNEL_URL, appDid: APP_DID, privateKey: keypair.privateKey, now, refreshRatio });
  }

  it('caches the token until 80% of its TTL has elapsed, then refreshes', async () => {
    let clock = 1_000_000;
    let n = 0;
    const fetchMock = stubFetch(async () => tokenResponse(`tok-${++n}`, 600));
    const tokens = provider(() => clock);

    expect(await tokens.getToken()).toBe('tok-1');
    clock += 479_000; // < 480s (80% of 600s)
    expect(await tokens.getToken()).toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 2_000; // past 480s
    expect(await tokens.getToken()).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours a custom refreshRatio', async () => {
    let clock = 0;
    let n = 0;
    stubFetch(async () => tokenResponse(`tok-${++n}`, 100));
    const tokens = provider(() => clock, 0.5);

    await tokens.getToken();
    clock = 49_000;
    expect(await tokens.getToken()).toBe('tok-1');
    clock = 51_000;
    expect(await tokens.getToken()).toBe('tok-2');
  });

  it('coalesces concurrent callers onto one mint', async () => {
    const fetchMock = stubFetch(async () => tokenResponse('shared'));
    const tokens = provider(() => 0);

    const results = await Promise.all([tokens.getToken(), tokens.getToken(), tokens.getToken()]);

    expect(results).toEqual(['shared', 'shared', 'shared']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next getToken() to mint a fresh token', async () => {
    let n = 0;
    const fetchMock = stubFetch(async () => tokenResponse(`tok-${++n}`));
    const tokens = provider(() => 0);

    expect(await tokens.getToken()).toBe('tok-1');
    tokens.invalidate();
    expect(await tokens.getToken()).toBe('tok-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed mint — the next call retries', async () => {
    let call = 0;
    const fetchMock = stubFetch(async () =>
      ++call === 1 ? new Response(JSON.stringify({ error: 'Unknown app DID' }), { status: 404 }) : tokenResponse('recovered'),
    );
    const tokens = provider(() => 0);

    await expect(tokens.getToken()).rejects.toThrow('Unknown app DID');
    expect(await tokens.getToken()).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
