/**
 * Tests for `loadAppSigningKey` (#2411, restart-authentication ruling):
 * first boot mints a bootstrap keypair and exchanges a claim code; every
 * later boot signs a challenge with the persisted bootstrap key instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { loadAppSigningKey } from '../src/load-app-signing-key';
import { writeKeystore } from '../src/keystore';
import { generateBootstrapKeypair } from '../src/ed25519';
vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomInt: vi.fn(),
}));

const KERNEL_URL = 'https://kernel.test';
let dir: string;
let keystorePath: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'imajin-load-key-test-'));
  keystorePath = join(dir, 'keystore.json');
  delete process.env.IMAJIN_KERNEL_URL;
  delete process.env.IMAJIN_APP_CLAIM_CODE;
  delete process.env.IMAJIN_APP_DID;
  delete process.env.IMAJIN_APP_KEYSTORE;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.IMAJIN_KERNEL_URL;
  delete process.env.IMAJIN_APP_CLAIM_CODE;
  delete process.env.IMAJIN_APP_DID;
  delete process.env.IMAJIN_APP_KEYSTORE;
});

describe('loadAppSigningKey — first boot (no keystore)', () => {
  it('mints a bootstrap keypair, exchanges the claim code, and persists the keystore only after success', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath });

    expect(result).toEqual({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' });
    expect(fetchMock).toHaveBeenCalledWith(`${KERNEL_URL}/api/apps/claim`, expect.objectContaining({ method: 'POST' }));
    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.claimCode).toBe('claim_test');
    expect(body.bootstrapPublicKey).toMatch(/^[0-9a-f]{64}$/);

    // Keystore was written with a keypair (never the fetched signing key).
    const { readKeystore } = await import('../src/keystore');
    const keystore = readKeystore(keystorePath);
    expect(keystore?.publicKey).toBe(body.bootstrapPublicKey);
    expect(keystore?.privateKey).not.toBe('private-hex');
  });

  it('does NOT persist a keystore when the claim exchange fails', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 410 })) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath })).rejects.toThrow();

    const { readKeystore } = await import('../src/keystore');
    expect(readKeystore(keystorePath)).toBeNull();
  });

  it('throws a clear, fail-loud message when no keystore exists and no claim code is provided', async () => {
    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, keystorePath }))
      .rejects.toThrow(/no keystore found.*no claim code provided/);
  });

  it('does not reflect the kernel message on a claim-code-reused (410) response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'FAKE_TEST_SECRET_DO_NOT_ECHO' }), { status: 410 }),
    ) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath }))
      .rejects.toThrow(/^loadAppSigningKey: claim exchange failed \(status 410\)$/);
  });
});

describe('loadAppSigningKey — every later boot (keystore present)', () => {
  it('second boot succeeds using the keystore, with NO claim code needed', async () => {
    const bootstrapKeypair = generateBootstrapKeypair();
    writeKeystore(keystorePath, bootstrapKeypair);

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid: 'did:imajin:abc123', keystorePath });

    expect(result).toEqual({ appDid: 'did:imajin:abc123', privateKey: 'private-hex', publicKey: 'public-hex' });
    expect(fetchMock).toHaveBeenCalledWith(`${KERNEL_URL}/api/apps/signing-key/fetch`, expect.objectContaining({ method: 'POST' }));
    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.appDid).toBe('did:imajin:abc123');
    expect(typeof body.timestamp).toBe('number');
    expect(typeof body.nonce).toBe('string');
    expect(typeof body.signature).toBe('string');
  });

  it('signs a DIFFERENT nonce on every call', async () => {
    writeKeystore(keystorePath, generateBootstrapKeypair());
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'k', publicKey: null }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid: 'did:imajin:abc123', keystorePath });
    await loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid: 'did:imajin:abc123', keystorePath });

    const nonces = fetchMock.mock.calls.map(([, options]) => JSON.parse((options as RequestInit).body as string).nonce);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  // #2411 required test: second boot with no keystore and no code fails loud.
  it('fails loud with a clear message when the keystore is missing and appDid has no code to fall back on', async () => {
    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, keystorePath }))
      .rejects.toThrow(/no keystore found/);
  });

  it('throws when appDid is missing even though a keystore exists', async () => {
    writeKeystore(keystorePath, generateBootstrapKeypair());

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, keystorePath }))
      .rejects.toThrow(/appDid is required/);
  });

  it('throws on a wrong-bootstrap-key (401) response from the kernel', async () => {
    writeKeystore(keystorePath, generateBootstrapKeypair());
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Invalid bootstrap key signature' }), { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid: 'did:imajin:abc123', keystorePath }))
      .rejects.toThrow(/^loadAppSigningKey: bootstrap-key fetch failed \(status 401\) for app did:imajin:abc123$/);
  });
});

describe('loadAppSigningKey — bootstrap startup retries', () => {
  const appDid = 'did:imajin:abc123';
  const healthyKey = { appDid, privateKey: 'test-only-key', publicKey: null };
  const exit = vi.fn();
  const start = (options: Parameters<typeof loadAppSigningKey>[0] = {}) =>
    loadAppSigningKey({ kernelUrl: KERNEL_URL, appDid, keystorePath, exit, ...options });
  const healthyResponse = () => new Response(JSON.stringify(healthyKey));

  beforeEach(() => {
    writeKeystore(keystorePath, generateBootstrapKeypair());
    vi.useFakeTimers();
    vi.mocked(randomInt).mockImplementation(((min: number) => min) as typeof randomInt);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it.each([500, 502, 503, 504, 599])('recovers from %i then 200 using a fresh signed challenge', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockImplementation(healthyResponse);
    vi.stubGlobal('fetch', fetchMock);
    const result = start();
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(healthyKey);
    const bodies = fetchMock.mock.calls.map(([, request]) => JSON.parse(request.body));
    expect(bodies[1].nonce).not.toBe(bodies[0].nonce);
    expect(bodies[1].timestamp).toBeGreaterThan(bodies[0].timestamp);
    expect(bodies[1].signature).not.toBe(bodies[0].signature);
    expect(exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'TypeError'])('retries a fetch rejection (%s)', async (code) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code } }))
      .mockImplementation(healthyResponse));
    const result = start();
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual(healthyKey);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits once at the default two-minute deadline after persistent 502s, without caching failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('untrusted-provider-body', { status: 502 }))));
    const failure = expect(start()).rejects.toThrow(/status 502.*did:imajin:abc123.*exhausted/);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('untrusted-provider-body'));
    vi.stubGlobal('fetch', vi.fn(healthyResponse));
    await expect(start()).resolves.toEqual(healthyKey);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses process.exit(1) by default even if instrumentation could swallow a rejection', async () => {
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 502 }))));
    const failure = expect(start({ exit: undefined, retry: { maxElapsedMs: 10 } })).rejects.toThrow(/exhausted/);
    await vi.runAllTimersAsync();
    await failure;
    expect(processExit).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(1);
  });

  it('applies exponential equal jitter, caps delay, and bounds the final wait', async () => {
    const attempts: number[] = [];
    vi.mocked(randomInt).mockImplementation(((min: number, max: number) =>
      Math.floor((min + max) / 2)) as typeof randomInt);
    vi.stubGlobal('fetch', vi.fn(() => {
      attempts.push(Date.now());
      return Promise.resolve(new Response(null, { status: 503 }));
    }));
    const startTime = Date.now();
    const failure = expect(start({
      retry: { maxElapsedMs: 4500, initialDelayMs: 1000, maxDelayMs: 2000 },
    })).rejects.toThrow(/exhausted/);
    await vi.runAllTimersAsync();
    await failure;
    expect(attempts.map((time) => time - startTime)).toEqual([0, 750, 2250, 3750]);
    expect(Date.now() - startTime).toBe(4500);
  });

  it.each(['fetch', 'body'])('aborts a stalled %s and exits within the total budget', async (stage) => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url, request) => {
      signals.push(request.signal);
      const stalled = new Promise(() => undefined);
      return stage === 'fetch' ? stalled : Promise.resolve({ ok: true, json: () => stalled });
    }));
    const failure = expect(start({
      retry: { maxElapsedMs: 2500, requestTimeoutMs: 1000, initialDelayMs: 100 },
    })).rejects.toThrow(/timed out.*exhausted/);
    await vi.runAllTimersAsync();
    await failure;
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 401, 403, 404, 410, 429])('fails fast on %i without retry, exit, or provider message leakage', async (status) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('untrusted-provider-body', { status }))));
    await expect(start()).rejects.toThrow(
      `loadAppSigningKey: bootstrap-key fetch failed (status ${status}) for app ${appDid}`,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails fast on malformed success rather than retrying or exiting', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))));
    await expect(start()).rejects.toThrow(/malformed/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('preserves a caller abort signal and does not retry cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn((_url, request) => {
      expect(request.signal.aborted).toBe(true);
      throw new TypeError('aborted');
    }));
    await expect(start({ fetchOptions: { signal: controller.signal } })).rejects.toThrow(/could not reach/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it.each(['maxElapsedMs', 'initialDelayMs', 'maxDelayMs', 'requestTimeoutMs'])(
    'rejects invalid %s before fetching',
    async (field) => {
      vi.stubGlobal('fetch', vi.fn());
      for (const value of [0, -1, 0.5, Number.NaN, Infinity, 2_147_483_648, undefined]) {
        await expect(start({ retry: { [field]: value } })).rejects.toThrow(/retry durations/);
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it('never retries a one-time claim exchange even on 502', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 502 }))));
    await expect(start({ keystorePath: join(dir, 'unclaimed.json'), claimCode: 'claim_test' }))
      .rejects.toThrow(/claim exchange failed \(status 502\)/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('loadAppSigningKey — env var fallbacks', () => {
  it('falls back to IMAJIN_KERNEL_URL / IMAJIN_APP_CLAIM_CODE / IMAJIN_APP_KEYSTORE when options are omitted', async () => {
    process.env.IMAJIN_KERNEL_URL = KERNEL_URL;
    process.env.IMAJIN_APP_CLAIM_CODE = 'claim_from_env';
    process.env.IMAJIN_APP_KEYSTORE = keystorePath;
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ appDid: 'did:imajin:abc123', privateKey: 'k', publicKey: null }), { status: 200 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadAppSigningKey();

    expect(fetchMock).toHaveBeenCalledWith(`${KERNEL_URL}/api/apps/claim`, expect.anything());
  });
});

describe('loadAppSigningKey — general failure modes', () => {
  it('throws when kernelUrl is missing', async () => {
    await expect(loadAppSigningKey({ claimCode: 'x', keystorePath })).rejects.toThrow(/kernelUrl is required/);
  });

  it('throws when the kernel is unreachable', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('FAKE_TEST_SECRET_DO_NOT_ECHO');
    }) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath }))
      .rejects.toThrow(/^loadAppSigningKey: could not reach the kernel$/);
  });

  it('throws when the response is malformed', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

    await expect(loadAppSigningKey({ kernelUrl: KERNEL_URL, claimCode: 'claim_test', keystorePath }))
      .rejects.toThrow(/malformed/);
  });
});
