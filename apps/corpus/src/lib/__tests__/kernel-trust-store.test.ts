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

  it('returns an empty array before anything has ever been pinned', () => {
    expect(store.getAll()).toEqual([]);
  });

  it('persists a single-key pin set and returns it', () => {
    store.pinSet([{ kid: 'auth-abc123', publicKey: 'deadbeef'.repeat(8) }], '2026-01-01T00:00:00.000Z');

    expect(store.getAll()).toEqual([
      { kid: 'auth-abc123', publicKey: 'deadbeef'.repeat(8), pinnedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('persists a multi-key pin set (rotation grace window)', () => {
    store.pinSet(
      [
        { kid: 'auth-current', publicKey: 'a'.repeat(64) },
        { kid: 'auth-previous', publicKey: 'b'.repeat(64) },
      ],
      '2026-01-01T00:00:00.000Z',
    );

    const all = store.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((k) => k.kid).sort()).toEqual(['auth-current', 'auth-previous']);
  });

  it('replaces the entire set on a second call, dropping keys not in the new set', () => {
    store.pinSet([{ kid: 'kid-1', publicKey: 'a'.repeat(64) }], '2026-01-01T00:00:00.000Z');
    store.pinSet([{ kid: 'kid-2', publicKey: 'b'.repeat(64) }], '2026-02-01T00:00:00.000Z');

    expect(store.getAll()).toEqual([{ kid: 'kid-2', publicKey: 'b'.repeat(64), pinnedAt: '2026-02-01T00:00:00.000Z' }]);
  });

  it('survives being re-opened against the same data directory', () => {
    store.pinSet([{ kid: 'kid-1', publicKey: 'c'.repeat(64) }], '2026-03-01T00:00:00.000Z');
    store.close();

    const reopened = new KernelTrustStore({ dataDir });
    expect(reopened.getAll()).toEqual([{ kid: 'kid-1', publicKey: 'c'.repeat(64), pinnedAt: '2026-03-01T00:00:00.000Z' }]);
    reopened.close();
    // Prevent the outer afterEach from double-closing the already-closed handle.
    store = new KernelTrustStore({ dataDir });
  });
});
