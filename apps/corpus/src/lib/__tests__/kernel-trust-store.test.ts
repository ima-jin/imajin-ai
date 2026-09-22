import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KernelTrustStore } from '../kernel-trust-store';

describe('KernelTrustStore (#2244)', () => {
  let dataDir: string;
  let store: KernelTrustStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kernel-trust-store-test-'));
    store = new KernelTrustStore({ dataDir });
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns null before anything has ever been pinned', () => {
    expect(store.get()).toBeNull();
  });

  it('persists a pin and returns it', () => {
    store.pin('deadbeef'.repeat(8), 'auth-abc123', '2026-01-01T00:00:00.000Z');

    expect(store.get()).toEqual({
      publicKey: 'deadbeef'.repeat(8),
      kid: 'auth-abc123',
      pinnedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('overwrites a previous pin on a second call', () => {
    store.pin('a'.repeat(64), 'kid-1', '2026-01-01T00:00:00.000Z');
    store.pin('b'.repeat(64), 'kid-2', '2026-02-01T00:00:00.000Z');

    expect(store.get()).toEqual({
      publicKey: 'b'.repeat(64),
      kid: 'kid-2',
      pinnedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('survives being re-opened against the same data directory', () => {
    store.pin('c'.repeat(64), null, '2026-03-01T00:00:00.000Z');
    store.close();

    const reopened = new KernelTrustStore({ dataDir });
    expect(reopened.get()).toEqual({ publicKey: 'c'.repeat(64), kid: null, pinnedAt: '2026-03-01T00:00:00.000Z' });
    reopened.close();
    // Prevent the outer afterEach from double-closing the already-closed handle.
    store = new KernelTrustStore({ dataDir });
  });
});
