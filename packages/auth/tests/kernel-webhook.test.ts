import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { computeKeyKid } from '../src/key-rotation';
import {
  canonicalKernelWebhookPayload,
  createFileKernelWebhookPinStore,
  createMemoryKernelWebhookNonceStore,
  KernelWebhookError,
  verifyKernelWebhook,
  type KernelWebhookKey,
  type KernelWebhookNonceStore,
  type KernelWebhookPinStore,
  type VerifyKernelWebhookOptions,
} from '../src/kernel-webhook';

const NOW = Date.now();
const AUDIENCE = 'did:imajin:test-app';
const AUTH = 'https://kernel.example/auth';
const TARGET = 'https://app.example/api/webhook?a=1&b=%2F';

function keypair() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const entry: KernelWebhookKey = {
    kid: computeKeyKid(publicKey), publicKey, algorithm: 'Ed25519',
    validFrom: new Date(NOW - 60_000).toISOString(),
  };
  return { ...pair, entry };
}
const first = keypair();
const second = keypair();

function signedRequest(input: {
  audience?: string;
  pair?: ReturnType<typeof keypair>;
  body?: string;
  timestamp?: number;
  nonce?: string;
  method?: string;
  url?: string;
} = {}) {
  const pair = input.pair ?? first;
  const timestamp = String(input.timestamp ?? Math.floor(NOW / 1000));
  const nonce = input.nonce ?? randomUUID();
  const method = input.method ?? 'POST';
  const url = input.url ?? TARGET;
  const body = input.body ?? '{ "event": "test", "unicode": "雪" }';
  const audience = input.audience ?? AUDIENCE;
  const payload = canonicalKernelWebhookPayload({ audience, timestamp, nonce, method, url, rawBody: body });
  return new Request(url, {
    method, body,
    headers: {
      'x-kernel-audience': audience,
      'x-kernel-kid': pair.entry.kid,
      'x-kernel-timestamp': timestamp,
      'x-kernel-nonce': nonce,
      'x-kernel-signature': sign(null, Buffer.from(payload), pair.privateKey).toString('hex'),
    },
  });
}

function memoryPins(): KernelWebhookPinStore {
  const data = new Map<string, readonly KernelWebhookKey[]>();
  let tail = Promise.resolve();
  return {
    load: async (namespace) => data.get(namespace) ?? null,
    save: async (namespace, keys) => { data.set(namespace, structuredClone(keys)); },
    async withLock(_namespace, operation) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((done) => { release = done; });
      await previous;
      try { return await operation(); } finally { release(); }
    },
  };
}

function context() {
  let keys: KernelWebhookKey[] = [first.entry];
  const fetch = vi.fn(async () => new Response(JSON.stringify({ current: keys[0].kid, keys })));
  const options: VerifyKernelWebhookOptions = {
    audience: AUDIENCE, discoveryCacheTtlMs: 0,
    authServiceUrl: AUTH, fetch: fetch as typeof globalThis.fetch,
    clock: () => NOW, pinStore: memoryPins(),
    nonceStore: createMemoryKernelWebhookNonceStore({ clock: () => NOW }),
  };
  return { options, fetch, publish: (published: KernelWebhookKey[]) => { keys = published; } };
}

describe('kernel webhook canonical protocol', () => {
  it('hashes exact UTF-8 body bytes, includes query and path, and uppercases method', () => {
    expect(canonicalKernelWebhookPayload({
      audience: AUDIENCE, timestamp: 123, nonce: 'test-nonce', method: 'post', url: TARGET, rawBody: '{}',
    })).toBe('imajin-webhook-v1\ndid:imajin:test-app\n123\ntest-nonce\nPOST\n/api/webhook?a=1&b=%2F\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });

  it('verifies before parsing and discovers the /auth-relative public endpoint', async () => {
    const { options, fetch } = context();
    await expect(verifyKernelWebhook(signedRequest(), options)).resolves.toEqual({ event: 'test', unicode: '雪' });
    expect(fetch).toHaveBeenCalledWith(`${AUTH}/.well-known/kernel-signing-key`, expect.objectContaining({
      redirect: 'error', cache: 'no-store', signal: expect.any(AbortSignal),
    }));
  });

  it.each(['unsigned', 'timestamp', 'nonce', 'signature', 'kid'])('rejects %s headers', async (kind) => {
    const { options, fetch } = context();
    const request = signedRequest();
    if (kind === 'unsigned') for (const name of [...request.headers.keys()]) request.headers.delete(name);
    else request.headers.set(`x-kernel-${kind}`, 'invalid');
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['body', 'method', 'path', 'query'])('rejects tampered %s', async (field) => {
    const { options } = context();
    const signed = signedRequest();
    const request = new Request(field === 'path' ? 'https://app.example/api/other?a=1&b=%2F' : field === 'query' ? `${TARGET}&c=3` : TARGET, {
      method: field === 'method' ? 'PUT' : 'POST',
      headers: signed.headers,
      body: field === 'body' ? '{"event":"tampered"}' : await signed.text(),
    });
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it.each([[-301, 'STALE'], [301, 'FUTURE']] as const)('rejects timestamp offset %s', async (offset, code) => {
    const { options, fetch } = context();
    await expect(verifyKernelWebhook(signedRequest({ timestamp: Math.floor(NOW / 1000) + offset }), options))
      .rejects.toMatchObject({ code });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows a bounded future clock skew', async () => {
    const { options } = context();
    await expect(verifyKernelWebhook(signedRequest({ timestamp: Math.floor(NOW / 1000) + 10 }), options)).resolves.toBeTruthy();
  });

  it('accepts exactly 300 seconds old once and retains replay evidence through that endpoint', async () => {
    const { options } = context();
    const now = Math.floor(NOW / 1000) * 1000;
    options.clock = () => now;
    options.nonceStore = createMemoryKernelWebhookNonceStore({ clock: () => now });
    const request = signedRequest({ timestamp: now / 1000 - 300 });
    await expect(verifyKernelWebhook(request.clone(), options)).resolves.toBeTruthy();
    await expect(verifyKernelWebhook(request.clone(), options)).rejects.toMatchObject({ code: 'REPLAY' });
  });

  it('rejects a delivery 300 seconds plus one millisecond old', async () => {
    const { options } = context();
    const now = Math.floor(NOW / 1000) * 1000;
    options.clock = () => now + 1;
    await expect(verifyKernelWebhook(signedRequest({ timestamp: now / 1000 - 300 }), options))
      .rejects.toMatchObject({ code: 'STALE' });
  });

  it('accepts exactly 300 seconds in the future', async () => {
    const { options } = context();
    const now = Math.floor(NOW / 1000) * 1000;
    options.clock = () => now;
    await expect(verifyKernelWebhook(signedRequest({ timestamp: now / 1000 + 300 }), options))
      .resolves.toBeTruthy();
  });

  it('rejects a delivery 300 seconds plus one millisecond in the future', async () => {
    const { options } = context();
    const now = Math.floor(NOW / 1000) * 1000;
    options.clock = () => now - 1;
    await expect(verifyKernelWebhook(signedRequest({ timestamp: now / 1000 + 300 }), options))
      .rejects.toMatchObject({ code: 'FUTURE' });
  });

  it('atomically rejects duplicate concurrent deliveries', async () => {
    const { options } = context();
    const request = signedRequest();
    const results = await Promise.allSettled([
      verifyKernelWebhook(request.clone(), options), verifyKernelWebhook(request.clone(), options),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'REPLAY' } });
  });

  it('normalizes UUID casing for replay protection', async () => {
    const { options } = context();
    const nonce = randomUUID();
    await verifyKernelWebhook(signedRequest({ nonce }), options);
    await expect(verifyKernelWebhook(signedRequest({ nonce: nonce.toUpperCase() }), options))
      .rejects.toMatchObject({ code: 'REPLAY' });
  });

  it('shares default replay evidence across separately loaded module copies', async () => {
    const { options } = context();
    options.nonceStore = undefined;
    options.clock = Date.now;
    const request = signedRequest({ timestamp: Math.floor(Date.now() / 1000) });
    await verifyKernelWebhook(request.clone(), options);
    vi.resetModules();
    const fresh = await import('../src/kernel-webhook');
    expect(fresh.verifyKernelWebhook).not.toBe(verifyKernelWebhook);
    await expect(fresh.verifyKernelWebhook(request.clone(), options)).rejects.toMatchObject({ code: 'REPLAY' });
    // The same process-wide store still isolates independent kernels.
    await expect(fresh.verifyKernelWebhook(request.clone(), {
      ...options, authServiceUrl: 'https://another-kernel.example/auth',
    })).resolves.toEqual({ event: 'test', unicode: '雪' });
  });

  it('returns typed invalid-JSON errors only after authentication', async () => {
    const { options } = context();
    await expect(verifyKernelWebhook(signedRequest({ body: 'not json' }), options))
      .rejects.toMatchObject({ code: 'INVALID_BODY', name: 'KernelWebhookError' });
  });
});

describe('kernel webhook TOFU and rotation', () => {
  it('extends pins on overlap, accepts new key, then removes withdrawn old key', async () => {
    const { options, publish } = context();
    await verifyKernelWebhook(signedRequest(), options);
    publish([second.entry, first.entry]);
    await verifyKernelWebhook(signedRequest({ pair: second }), options);
    publish([second.entry]);
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), options)).resolves.toBeTruthy();
  });

  it('rejects a wholly replaced key set instead of silently re-pinning', async () => {
    const { options, publish } = context();
    await verifyKernelWebhook(signedRequest(), options);
    publish([second.entry]);
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), options)).rejects.toMatchObject({ code: 'TRUST' });
  });

  it('requires BOTH kid and public key to match the pinned anchor', async () => {
    const { options, publish } = context();
    options.pinStore = {
      ...memoryPins(),
      load: async () => [{ ...first.entry, publicKey: second.entry.publicKey }],
    };
    publish([first.entry, second.entry]);
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), options)).rejects.toMatchObject({ code: 'TRUST' });
  });

  it('rejects a malicious discovery entry reusing a pinned kid for a different key', async () => {
    const { options, publish } = context();
    await verifyKernelWebhook(signedRequest(), options);
    publish([{ ...second.entry, kid: first.entry.kid }]);
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), options)).rejects.toMatchObject({ code: 'DISCOVERY' });
  });

  it('rejects expired grace keys even if still published and pinned', async () => {
    const { options, publish } = context();
    await verifyKernelWebhook(signedRequest(), options);
    publish([second.entry, { ...first.entry, validUntil: new Date(NOW + 1000).toISOString() }]);
    await verifyKernelWebhook(signedRequest({ pair: second }), options);
    options.clock = () => NOW + 1000;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
  });

  it('does not let an expired-only overlap authorize a new key', async () => {
    const { options, publish } = context();
    await verifyKernelWebhook(signedRequest(), options);
    publish([second.entry, { ...first.entry, validUntil: new Date(NOW).toISOString() }]);
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), options)).rejects.toMatchObject({ code: 'TRUST' });
  });

  it('rejects a future-valid key even if the set has a live trusted anchor', async () => {
    const { options, publish } = context();
    publish([first.entry, { ...second.entry, validFrom: new Date(NOW + 1000).toISOString() }]);
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), options)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
  });

  it('pins persist across store instances and contain only public metadata', async () => {
    const { options, publish } = context();
    const directory = await mkdtemp(join(tmpdir(), 'webhook-pins-'));
    options.pinStore = createFileKernelWebhookPinStore(directory);
    await verifyKernelWebhook(signedRequest(), options);
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, files[0]), 'utf8'))).toEqual([first.entry]);
    options.pinStore = createFileKernelWebhookPinStore(directory);
    publish([second.entry]);
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), options)).rejects.toMatchObject({ code: 'TRUST' });
  });

  it('serializes competing first-boot pins across independently constructed stores', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webhook-race-'));
    const a = context();
    const b = context();
    a.options.pinStore = createFileKernelWebhookPinStore(directory);
    b.options.pinStore = createFileKernelWebhookPinStore(directory);
    b.publish([second.entry]);
    const results = await Promise.allSettled([
      verifyKernelWebhook(signedRequest(), a.options),
      verifyKernelWebhook(signedRequest({ pair: second }), b.options),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'TRUST' } });
  });

  it('normalizes trailing slashes without changing the kernel replay namespace', async () => {
    const { options, fetch } = context();
    const request = signedRequest();
    options.authServiceUrl = `${AUTH}/////`;
    await verifyKernelWebhook(request.clone(), options);
    expect(fetch).toHaveBeenCalledWith(`${AUTH}/.well-known/kernel-signing-key`, expect.anything());
    options.authServiceUrl = AUTH;
    await expect(verifyKernelWebhook(request.clone(), options)).rejects.toMatchObject({ code: 'REPLAY' });
  });

  it('namespaces both public pins and nonces by kernel auth URL', async () => {
    const { options, publish } = context();
    const nonce = randomUUID();
    await verifyKernelWebhook(signedRequest({ nonce }), options);
    options.authServiceUrl = 'https://other.example/auth';
    publish([second.entry]);
    await expect(verifyKernelWebhook(signedRequest({ pair: second, nonce }), options)).resolves.toBeTruthy();
  });
});

describe('kernel webhook audience and default discovery cache', () => {
  function cachedContext() {
    const ctx = context();
    delete ctx.options.discoveryCacheTtlMs;
    let now = NOW;
    ctx.options.clock = () => now;
    return { ...ctx, advance: (ms: number) => { now += ms; } };
  }

  it.each([null, '', 'app', 'did:imajin:', 'did:imajin:app space'])(
    'rejects missing/malformed inbound audience %j before stores or network', async (audience) => {
      const { options, fetch } = cachedContext();
      const consume = vi.fn();
      options.nonceStore = { consume };
      const request = signedRequest();
      if (audience === null) request.headers.delete('x-kernel-audience');
      else request.headers.set('x-kernel-audience', audience);
      await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetch).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', 'not-a-did'])('requires trusted own audience %j', async (audience) => {
    const { options, fetch } = cachedContext();
    await expect(verifyKernelWebhook(signedRequest(), { ...options, audience } as VerifyKernelWebhookOptions))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects cross-app replay even with independent nonce stores and matching route paths', async () => {
    const a = cachedContext();
    const b = cachedContext();
    b.options.audience = 'did:imajin:other-app';
    const request = signedRequest({ audience: b.options.audience });
    await verifyKernelWebhook(request.clone(), b.options);
    await expect(verifyKernelWebhook(request.clone(), a.options)).rejects.toMatchObject({ code: 'AUDIENCE_MISMATCH' });
    expect(a.fetch).not.toHaveBeenCalled();
    request.headers.set('x-kernel-audience', AUDIENCE);
    await expect(verifyKernelWebhook(request, a.options)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });

  it('namespaces a shared/default nonce store by kernel, audience and normalized nonce', async () => {
    const { options } = cachedContext();
    options.nonceStore = undefined;
    const nonce = randomUUID();
    await verifyKernelWebhook(signedRequest({ nonce }), options);
    const audience = 'did:imajin:other-app';
    await verifyKernelWebhook(signedRequest({ nonce, audience }), { ...options, audience });
    await expect(verifyKernelWebhook(signedRequest({ nonce, audience }), { ...options, audience }))
      .rejects.toMatchObject({ code: 'REPLAY' });
  });

  it('single-flights concurrent cold requests and caches repeated valid and forged requests', async () => {
    const { options, fetch } = cachedContext();
    await Promise.all(Array.from({ length: 12 }, () => verifyKernelWebhook(signedRequest(), options)));
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = signedRequest();
    request.headers.set('x-kernel-signature', '0'.repeat(128));
    await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
    await verifyKernelWebhook(signedRequest(), options);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fails closed between a short configured TTL and the minimum refresh interval', async () => {
    const { options, fetch, advance } = cachedContext();
    options.discoveryCacheTtlMs = 1_000;
    await verifyKernelWebhook(signedRequest(), options);
    advance(1_000);
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'DISCOVERY' });
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(4_000);
    await verifyKernelWebhook(signedRequest(), options);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares trusted cache across duplicate modules but not independent pin stores', async () => {
    const { options, fetch } = cachedContext();
    await verifyKernelWebhook(signedRequest(), options);
    vi.resetModules();
    const copy = await import('../src/kernel-webhook');
    await copy.verifyKernelWebhook(signedRequest(), options);
    expect(fetch).toHaveBeenCalledTimes(1);
    const pinStore = { ...memoryPins(), load: async () => [{ ...second.entry }] };
    await expect(copy.verifyKernelWebhook(signedRequest(), { ...options, pinStore }))
      .rejects.toMatchObject({ code: 'TRUST' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rate-limits unknown-kid pressure, refreshes rotation on overlap and rejects withdrawn keys after TTL', async () => {
    const { options, fetch, publish, advance } = cachedContext();
    await verifyKernelWebhook(signedRequest(), options);
    await Promise.all(Array.from({ length: 20 }, async () => {
      const request = signedRequest({ pair: second });
      request.headers.set('x-kernel-kid', `auth-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
      await expect(verifyKernelWebhook(request, options)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(5_000);
    publish([second.entry, first.entry]);
    await Promise.all(Array.from({ length: 10 }, () => verifyKernelWebhook(signedRequest({ pair: second }), options)));
    expect(fetch).toHaveBeenCalledTimes(2);
    publish([second.entry]);
    advance(60_000);
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    await verifyKernelWebhook(signedRequest({ pair: second }), options);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('checks cached key expiry on every request without allowing an expired overlap to re-pin', async () => {
    const { options, publish, advance, fetch } = cachedContext();
    publish([{ ...first.entry, validUntil: new Date(NOW + 1_000).toISOString() }]);
    await verifyKernelWebhook(signedRequest(), options);
    advance(1_000);
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    expect(fetch).toHaveBeenCalledTimes(1);
    publish([second.entry, { ...first.entry, validUntil: new Date(NOW + 1_000).toISOString() }]);
    advance(4_000);
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), options)).rejects.toMatchObject({ code: 'TRUST' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never falls back to expired cache and throttles failed refreshes including initial discovery', async () => {
    const { options, fetch, advance } = cachedContext();
    await verifyKernelWebhook(signedRequest(), options);
    advance(60_000);
    const offline = vi.fn(async () => { throw new Error('offline'); });
    options.fetch = offline as typeof globalThis.fetch;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'DISCOVERY' });
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'DISCOVERY' });
    expect(offline).toHaveBeenCalledTimes(1);
    advance(5_000);
    options.fetch = fetch as typeof globalThis.fetch;
    await verifyKernelWebhook(signedRequest(), options);
    expect(fetch).toHaveBeenCalledTimes(2);
    const cold = { ...options, pinStore: memoryPins(), fetch: offline as typeof globalThis.fetch };
    await expect(verifyKernelWebhook(signedRequest(), cold)).rejects.toMatchObject({ code: 'DISCOVERY' });
    await expect(verifyKernelWebhook(signedRequest({ pair: second }), cold)).rejects.toMatchObject({ code: 'DISCOVERY' });
    expect(offline).toHaveBeenCalledTimes(2);
  });

  it('bounds namespace state without evicting live rate-limit evidence', async () => {
    const { options, fetch } = cachedContext();
    await Promise.all(Array.from({ length: 64 }, (_, i) => verifyKernelWebhook(signedRequest(), {
      ...options, authServiceUrl: `https://kernel-${i}.example/auth`,
    })));
    await expect(verifyKernelWebhook(signedRequest(), { ...options, authServiceUrl: 'https://overflow.example/auth' }))
      .rejects.toMatchObject({ code: 'DISCOVERY' });
    expect(fetch).toHaveBeenCalledTimes(64);
  });

  it.each([-1, 0.1, 60_001, Number.NaN])('rejects invalid cache TTL %s', async (discoveryCacheTtlMs) => {
    const { options, fetch } = cachedContext();
    await expect(verifyKernelWebhook(signedRequest(), { ...options, discoveryCacheTtlMs }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe('kernel webhook fail-closed infrastructure', () => {
  it.each([
    { maxAgeSeconds: 0 }, { maxAgeSeconds: 1.5 }, { futureToleranceSeconds: -1 },
    { futureToleranceSeconds: 0.5 }, { fetchTimeoutMs: 0 }, { fetchTimeoutMs: 1.5 },
    { clock: () => Number.NaN },
  ])('rejects invalid verifier configuration %j', async (overrides) => {
    const { options, fetch } = context();
    await expect(verifyKernelWebhook(signedRequest(), { ...options, ...overrides }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['', 'not-a-url', 'ftp://kernel.example/auth', 'https://user:pass@kernel.example/auth',
    'https://kernel.example/auth?query=true', 'https://kernel.example/auth#fragment',
    'http://kernel.example/auth'])('rejects invalid or insecure auth URL %s', async (authServiceUrl) => {
    const { options, fetch } = context();
    options.authServiceUrl = authServiceUrl;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['http://localhost:7000/auth', 'http://127.0.0.1:7000/auth', 'http://[::1]:7000/auth'])(
    'supports loopback HTTP %s', async (authServiceUrl) => {
      const { options } = context();
      options.authServiceUrl = authServiceUrl;
      await expect(verifyKernelWebhook(signedRequest(), options)).resolves.toBeTruthy();
    },
  );

  it('allows an explicit insecure internal-network opt-in', async () => {
    const { options } = context();
    options.authServiceUrl = 'http://kernel.internal:7000/auth';
    options.allowInsecureHttp = true;
    await expect(verifyKernelWebhook(signedRequest(), options)).resolves.toBeTruthy();
  });

  it('does not silently bootstrap from a malformed persisted pin', async () => {
    const { options, fetch } = context();
    options.pinStore = { ...memoryPins(), load: async () => [] };
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'TRUST' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    null, [], {}, { keys: [] }, { keys: [first.entry] },
    { keys: [null], current: first.entry.kid },
    { keys: [{ ...first.entry, kid: 1 }], current: first.entry.kid },
    { keys: [{ ...first.entry, publicKey: 'not-a-key' }], current: first.entry.kid },
    { keys: [{ ...first.entry, publicKey: 1 }], current: first.entry.kid },
    { keys: [{ ...first.entry, validUntil: first.entry.validFrom }], current: first.entry.kid },
    { keys: [first.entry], current: second.entry.kid },
    { keys: [first.entry, first.entry], current: first.entry.kid },
    { keys: [{ ...first.entry, algorithm: 'RSA' }], current: first.entry.kid },
    { keys: [{ ...first.entry, validUntil: 'never' }], current: first.entry.kid },
    { keys: [{ ...first.entry, validFrom: null }], current: first.entry.kid },
    { keys: [{ ...first.entry, validFrom: '0' }], current: first.entry.kid },
    { keys: [{ ...first.entry, validFrom: '2026-02-30T00:00:00.000Z' }], current: first.entry.kid },
  ])('rejects malformed discovery %j', async (document) => {
    const { options } = context();
    options.fetch = vi.fn(async () => new Response(JSON.stringify(document))) as typeof fetch;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'DISCOVERY' });
  });

  it('does not fall back to stale pins when the kernel is unavailable', async () => {
    const { options } = context();
    await verifyKernelWebhook(signedRequest(), options);
    options.fetch = vi.fn(async () => { throw new Error('offline'); }) as typeof fetch;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'DISCOVERY' });
  });

  it('rejects non-success discovery', async () => {
    const { options } = context();
    options.fetch = vi.fn(async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'DISCOVERY' });
  });

  it('bounds fetch timeout even for an injected fetch ignoring AbortSignal', async () => {
    const { options } = context();
    options.fetchTimeoutMs = 5;
    options.fetch = vi.fn(() => new Promise(() => {})) as typeof fetch;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'DISCOVERY' });
  });

  it.each(['load', 'save', 'withLock'] as const)('fails closed on pin store %s failure', async (method) => {
    const { options } = context();
    options.pinStore = { ...memoryPins(), [method]: async () => { throw new Error('database down'); } };
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toBeInstanceOf(KernelWebhookError);
  });

  it('fails closed if the atomic nonce store fails', async () => {
    const { options } = context();
    options.nonceStore = { consume: async () => { throw new Error('database down'); } };
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'STORE' });
  });

  it('never evicts live replay evidence to make room', () => {
    let now = 1000;
    const store = createMemoryKernelWebhookNonceStore({ maxEntries: 1, clock: () => now });
    expect(store.consume('a', 2000)).toBe(true);
    expect(store.consume('a', 2000)).toBe(false);
    expect(() => store.consume('b', 3000)).toThrow();
    now = 2000;
    expect(store.consume('b', 3000)).toBe(true);
  });

  it('fails closed if a broken nonce adapter returns a truthy non-boolean', async () => {
    const { options } = context();
    options.nonceStore = { consume: async () => 'yes' } as unknown as KernelWebhookNonceStore;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'STORE' });
  });

  it.each([0, -1, 1.5])('rejects invalid in-memory nonce capacity %s', (maxEntries) => {
    expect(() => createMemoryKernelWebhookNonceStore({ maxEntries })).toThrow(TypeError);
  });

  it('rechecks timestamp after slow discovery', async () => {
    const { options, fetch } = context();
    let now = NOW;
    options.clock = () => now;
    options.fetch = (async () => {
      now += 301_000;
      return fetch();
    }) as typeof globalThis.fetch;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'STALE' });
  });

  it('rejects a publication whose only key expires during fetch', async () => {
    const { options, publish, fetch } = context();
    publish([{ ...first.entry, validUntil: new Date(NOW + 1000).toISOString() }]);
    let now = NOW;
    options.clock = () => now;
    options.fetch = (async () => {
      now += 1000;
      return fetch();
    }) as typeof globalThis.fetch;
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'TRUST' });
  });

  it('rechecks key expiry after publication validation and before nonce consumption', async () => {
    const { options, publish } = context();
    publish([{ ...first.entry, validUntil: new Date(NOW + 1000).toISOString() }]);
    options.clock = vi.fn().mockReturnValueOnce(NOW).mockReturnValueOnce(NOW).mockReturnValueOnce(NOW).mockReturnValue(NOW + 1000);
    const consume = vi.fn().mockReturnValue(true);
    options.nonceStore = { consume };
    await expect(verifyKernelWebhook(signedRequest(), options)).rejects.toMatchObject({ code: 'UNKNOWN_KEY' });
    expect(consume).not.toHaveBeenCalled();
  });
});
