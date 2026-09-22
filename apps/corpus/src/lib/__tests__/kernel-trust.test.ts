import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { KernelTrustStore } from '../kernel-trust-store';
import {
  _resetKernelTrustStateForTests,
  bootstrapKernelTrust,
  resolveTrustedKernelPublicKey,
} from '../kernel-trust';

const ORIGINAL_ENV = {
  CORPUS_KERNEL_PUBLIC_KEY: process.env.CORPUS_KERNEL_PUBLIC_KEY,
  CORPUS_KERNEL_PUBLIC_KEY_REPIN: process.env.CORPUS_KERNEL_PUBLIC_KEY_REPIN,
  AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('kernel-trust (#2244)', () => {
  let dataDir: string;
  let store: KernelTrustStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kernel-trust-test-'));
    store = new KernelTrustStore({ dataDir });
    _resetKernelTrustStateForTests();
    delete process.env.CORPUS_KERNEL_PUBLIC_KEY;
    delete process.env.CORPUS_KERNEL_PUBLIC_KEY_REPIN;
    process.env.AUTH_SERVICE_URL = 'http://kernel.test/auth';
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    _resetKernelTrustStateForTests();
    restoreEnv();
  });

  it('first boot: fetches from the well-known endpoint and pins it', async () => {
    const { publicKey } = authCrypto.generateKeypair();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://kernel.test/auth/.well-known/kernel-signing-key');
      return jsonResponse({ kid: 'auth-abc', alg: 'Ed25519', publicKey, issuedAt: '2026-01-01T00:00:00.000Z' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKey()).toBe(publicKey);
    expect(store.get()?.publicKey).toBe(publicKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('first boot with an unreachable kernel: resolves to null without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    await expect(bootstrapKernelTrust({ store })).resolves.toBeUndefined();

    expect(resolveTrustedKernelPublicKey()).toBeNull();
    expect(store.get()).toBeNull();
  });

  it('subsequent boot with an existing pin and no mismatch: keeps the pin without overwriting it', async () => {
    const { publicKey } = authCrypto.generateKeypair();
    store.pin(publicKey, 'auth-abc', '2026-01-01T00:00:00.000Z');
    const fetchMock = vi.fn(async () => jsonResponse({ alg: 'Ed25519', publicKey }));
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKey()).toBe(publicKey);
    expect(fetchMock).toHaveBeenCalledTimes(1); // best-effort mismatch check
  });

  it('subsequent boot where the kernel now serves a different key: keeps the OLD pin (never silently re-pins)', async () => {
    const pinned = authCrypto.generateKeypair();
    const rotated = authCrypto.generateKeypair();
    store.pin(pinned.publicKey, 'auth-old', '2026-01-01T00:00:00.000Z');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ alg: 'Ed25519', publicKey: rotated.publicKey })));

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKey()).toBe(pinned.publicKey);
    expect(store.get()?.publicKey).toBe(pinned.publicKey);
  });

  it('CORPUS_KERNEL_PUBLIC_KEY_REPIN=1 explicitly re-pins to whatever the kernel serves now', async () => {
    const pinned = authCrypto.generateKeypair();
    const rotated = authCrypto.generateKeypair();
    store.pin(pinned.publicKey, 'auth-old', '2026-01-01T00:00:00.000Z');
    process.env.CORPUS_KERNEL_PUBLIC_KEY_REPIN = '1';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ alg: 'Ed25519', publicKey: rotated.publicKey })));

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKey()).toBe(rotated.publicKey);
    expect(store.get()?.publicKey).toBe(rotated.publicKey);
  });

  it('CORPUS_KERNEL_PUBLIC_KEY set: takes precedence over any pin, and never calls fetch', async () => {
    const envKey = authCrypto.generateKeypair().publicKey;
    const pinned = authCrypto.generateKeypair().publicKey;
    store.pin(pinned, 'auth-old', '2026-01-01T00:00:00.000Z');
    process.env.CORPUS_KERNEL_PUBLIC_KEY = envKey;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKey()).toBe(envKey);
    expect(fetchMock).not.toHaveBeenCalled();
    // The pin store is untouched — env var precedence doesn't clobber TOFU state.
    expect(store.get()?.publicKey).toBe(pinned);
  });

  it('no AUTH_SERVICE_URL and no existing pin: resolves to null without throwing', async () => {
    delete process.env.AUTH_SERVICE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKey()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed/invalid publicKey in the well-known response on first boot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ alg: 'Ed25519', publicKey: 'not-hex!!' })));

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKey()).toBeNull();
    expect(store.get()).toBeNull();
  });
});
