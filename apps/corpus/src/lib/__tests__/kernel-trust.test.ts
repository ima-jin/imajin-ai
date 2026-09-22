import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { KernelTrustStore } from '../kernel-trust-store';
import {
  _resetKernelTrustStateForTests,
  bootstrapKernelTrust,
  resolveTrustedKernelPublicKeys,
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

function keyEntry(kid: string, publicKey: string): { kid: string; publicKey: string; algorithm: string } {
  return { kid, publicKey, algorithm: 'Ed25519' };
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

  it('first boot: fetches from the well-known endpoint and pins the served key set', async () => {
    const { publicKey } = authCrypto.generateKeypair();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://kernel.test/auth/.well-known/kernel-signing-key');
      return jsonResponse({ keys: [keyEntry('kid-a', publicKey)], current: 'kid-a' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKeys()).toEqual([publicKey]);
    expect(store.getAll()).toEqual([{ kid: 'kid-a', publicKey, pinnedAt: expect.any(String) }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('first boot with an unreachable kernel: resolves to an empty key set without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    await expect(bootstrapKernelTrust({ store })).resolves.toBeUndefined();

    expect(resolveTrustedKernelPublicKeys()).toEqual([]);
    expect(store.getAll()).toEqual([]);
  });

  describe('grace-window rotation (two keys served)', () => {
    it('pins both keys served on first boot, and verification succeeds against either', async () => {
      const current = authCrypto.generateKeypair();
      const previous = authCrypto.generateKeypair();
      vi.stubGlobal('fetch', vi.fn(async () =>
        jsonResponse({ keys: [keyEntry('kid-current', current.publicKey), keyEntry('kid-previous', previous.publicKey)], current: 'kid-current' }),
      ));

      await bootstrapKernelTrust({ store });

      const trusted = resolveTrustedKernelPublicKeys();
      expect(trusted).toHaveLength(2);
      expect(trusted).toEqual(expect.arrayContaining([current.publicKey, previous.publicKey]));

      const message = 'hello';
      const sigFromCurrent = authCrypto.signSync(message, current.privateKey);
      const sigFromPrevious = authCrypto.signSync(message, previous.privateKey);
      expect(trusted.some((key) => authCrypto.verifySync(sigFromCurrent, message, key))).toBe(true);
      expect(trusted.some((key) => authCrypto.verifySync(sigFromPrevious, message, key))).toBe(true);
    });

    it('extends the pin set on a subsequent boot when the served set still contains the pinned kid — no mismatch warning', async () => {
      const pinned = authCrypto.generateKeypair();
      const rotatedIn = authCrypto.generateKeypair();
      store.pinSet([{ kid: 'kid-pinned', publicKey: pinned.publicKey }], '2026-01-01T00:00:00.000Z');
      vi.stubGlobal('fetch', vi.fn(async () =>
        jsonResponse({ keys: [keyEntry('kid-pinned', pinned.publicKey), keyEntry('kid-new', rotatedIn.publicKey)], current: 'kid-new' }),
      ));

      await bootstrapKernelTrust({ store });

      const trusted = resolveTrustedKernelPublicKeys();
      expect(trusted).toHaveLength(2);
      expect(trusted).toEqual(expect.arrayContaining([pinned.publicKey, rotatedIn.publicKey]));

      const all = store.getAll();
      expect(all.map((k) => k.kid).sort()).toEqual(['kid-new', 'kid-pinned']);
    });

    it('a served key set sharing NO kid with the pin is still a mismatch: WARN, never silently re-pin', async () => {
      const pinned = authCrypto.generateKeypair();
      const unrelated = authCrypto.generateKeypair();
      store.pinSet([{ kid: 'kid-pinned', publicKey: pinned.publicKey }], '2026-01-01T00:00:00.000Z');
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ keys: [keyEntry('kid-unrelated', unrelated.publicKey)], current: 'kid-unrelated' })));

      await bootstrapKernelTrust({ store });

      expect(resolveTrustedKernelPublicKeys()).toEqual([pinned.publicKey]);
      expect(store.getAll()).toEqual([{ kid: 'kid-pinned', publicKey: pinned.publicKey, pinnedAt: '2026-01-01T00:00:00.000Z' }]);
    });
  });

  it('subsequent boot with an existing pin and an identical served set: keeps the pin without rewriting it', async () => {
    const { publicKey } = authCrypto.generateKeypair();
    store.pinSet([{ kid: 'kid-a', publicKey }], '2026-01-01T00:00:00.000Z');
    const fetchMock = vi.fn(async () => jsonResponse({ keys: [keyEntry('kid-a', publicKey)], current: 'kid-a' }));
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKeys()).toEqual([publicKey]);
    expect(store.getAll()).toEqual([{ kid: 'kid-a', publicKey, pinnedAt: '2026-01-01T00:00:00.000Z' }]); // unchanged pinnedAt — no rewrite
    expect(fetchMock).toHaveBeenCalledTimes(1); // best-effort reconciliation check
  });

  describe('CORPUS_KERNEL_PUBLIC_KEY_REPIN=1', () => {
    it('explicitly re-pins to whatever the kernel serves now, and warns to unset the flag afterward', async () => {
      const pinned = authCrypto.generateKeypair();
      const rotated = authCrypto.generateKeypair();
      store.pinSet([{ kid: 'kid-old', publicKey: pinned.publicKey }], '2026-01-01T00:00:00.000Z');
      process.env.CORPUS_KERNEL_PUBLIC_KEY_REPIN = '1';
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ keys: [keyEntry('kid-new', rotated.publicKey)], current: 'kid-new' })));

      await bootstrapKernelTrust({ store });

      expect(resolveTrustedKernelPublicKeys()).toEqual([rotated.publicKey]);
      expect(store.getAll()).toEqual([{ kid: 'kid-new', publicKey: rotated.publicKey, pinnedAt: expect.any(String) }]);
    });

    it('is a one-shot no-op when the served set already equals the pin — does not rewrite the store', async () => {
      const { publicKey } = authCrypto.generateKeypair();
      store.pinSet([{ kid: 'kid-a', publicKey }], '2026-01-01T00:00:00.000Z');
      process.env.CORPUS_KERNEL_PUBLIC_KEY_REPIN = '1';
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ keys: [keyEntry('kid-a', publicKey)], current: 'kid-a' })));

      await bootstrapKernelTrust({ store });

      expect(resolveTrustedKernelPublicKeys()).toEqual([publicKey]);
      // pinnedAt is untouched — proves no pinSet() write occurred.
      expect(store.getAll()).toEqual([{ kid: 'kid-a', publicKey, pinnedAt: '2026-01-01T00:00:00.000Z' }]);
    });

    it('still performs a normal first pin (not a no-op) when there is no existing pin yet', async () => {
      const { publicKey } = authCrypto.generateKeypair();
      process.env.CORPUS_KERNEL_PUBLIC_KEY_REPIN = '1';
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ keys: [keyEntry('kid-a', publicKey)], current: 'kid-a' })));

      await bootstrapKernelTrust({ store });

      expect(resolveTrustedKernelPublicKeys()).toEqual([publicKey]);
    });
  });

  it('CORPUS_KERNEL_PUBLIC_KEY set: takes precedence over any pin, and never calls fetch', async () => {
    const envKey = authCrypto.generateKeypair().publicKey;
    const pinned = authCrypto.generateKeypair().publicKey;
    store.pinSet([{ kid: 'kid-a', publicKey: pinned }], '2026-01-01T00:00:00.000Z');
    process.env.CORPUS_KERNEL_PUBLIC_KEY = envKey;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKeys()).toEqual([envKey]);
    expect(fetchMock).not.toHaveBeenCalled();
    // The pin store is untouched — env var precedence doesn't clobber TOFU state.
    expect(store.getAll()).toEqual([{ kid: 'kid-a', publicKey: pinned, pinnedAt: '2026-01-01T00:00:00.000Z' }]);
  });

  it('no AUTH_SERVICE_URL and no existing pin: resolves to an empty key set without throwing', async () => {
    delete process.env.AUTH_SERVICE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKeys()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed/invalid publicKey in the well-known response on first boot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ keys: [{ kid: 'kid-a', publicKey: 'not-hex!!', algorithm: 'Ed25519' }], current: 'kid-a' })));

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKeys()).toEqual([]);
    expect(store.getAll()).toEqual([]);
  });

  it('rejects a response with duplicate kids', async () => {
    const a = authCrypto.generateKeypair().publicKey;
    const b = authCrypto.generateKeypair().publicKey;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ keys: [keyEntry('kid-dup', a), keyEntry('kid-dup', b)], current: 'kid-dup' })));

    await bootstrapKernelTrust({ store });

    expect(resolveTrustedKernelPublicKeys()).toEqual([]);
  });
});
