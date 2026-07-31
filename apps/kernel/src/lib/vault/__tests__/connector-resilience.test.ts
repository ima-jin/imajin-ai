/**
 * Vault resilience tests for the connector lifecycle (#1518, #1519, #1522).
 *
 * These exercise the exact prod failure: a GitHub connector that was
 * disconnected and then reconnected produced a vault entry that failed
 * SIGNATURE_INVALID on the very next read, which 500'd the connector's status
 * endpoint and hid the Disconnect button behind the same error.
 *
 * VAULT_PATH is redirected to a temp file via vi.hoisted() so the module-level
 * VaultEntryService singleton in vault/index.ts operates on isolated state.
 * The DB is stubbed because none of the v1 paths under test touch it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import type { VaultEntry } from '@imajin/vault-core';

const { tmpVaultPath } = vi.hoisted(() => {
  // vi.hoisted() runs before ESM imports are initialized, so use require().

  const { join } = require('node:path') as typeof import('node:path');

  const { tmpdir } = require('node:os') as typeof import('node:os');

  const tmpVaultPath = join(tmpdir(), `vault-connector-resilience-${Date.now()}.json`);
  process.env.VAULT_PATH = tmpVaultPath;
  return { tmpVaultPath };
});

vi.mock('@/src/db', () => ({
  db: {},
  vaultDelegationGrants: {},
  vaultGrantRequests: {},
  channelLinks: {},
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
}));

vi.mock('@imajin/bus', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

import {
  sealAndStore,
  deleteFromVault,
  loadAndUnseal,
  vaultFieldExists,
} from '../index.js';
import { _resetSealingCache } from '../sealing.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const OWNER_DID = 'did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU';
const OAUTH_FIELD = `github-oauth:${OWNER_DID}`;
const CONFIG_FIELD = `github-config:${OWNER_DID}`;

/**
 * The GitHub OAuth token bundle for a non-expiring OAuth-App token: no
 * refreshToken, no expiresAt. #1522 suspected these absent optional fields were
 * the cause, so the shape is pinned here to prove the round-trip is stable.
 */
const NON_EXPIRING_BUNDLE = JSON.stringify({
  accessToken: 'gho_nonexpiring_token',
  scope: 'repo,read:org',
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readVaultEntries(): Promise<VaultEntry[]> {
  const raw = await readFile(tmpVaultPath, 'utf8');
  return (JSON.parse(raw) as { entries: VaultEntry[] }).entries;
}

/** Corrupt the signature of the latest persisted entry for a field. */
async function corruptLatestEntry(field: string): Promise<void> {
  const raw = await readFile(tmpVaultPath, 'utf8');
  const vault = JSON.parse(raw) as { version: number; entries: VaultEntry[] };
  for (let index = vault.entries.length - 1; index >= 0; index -= 1) {
    if (vault.entries[index]!.field === field) {
      vault.entries[index]!.signature = 'a'.repeat(128);
      break;
    }
  }
  await writeFile(tmpVaultPath, JSON.stringify(vault), 'utf8');
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(async () => {
  _resetSealingCache();
  delete process.env.AUTH_PRIVATE_KEY;
  await unlink(tmpVaultPath).catch(() => undefined);
});

afterEach(async () => {
  _resetSealingCache();
  await unlink(tmpVaultPath).catch(() => undefined);
});

// ── Reconnect after disconnect (#1522) ────────────────────────────────────────

describe('connector reconnect after disconnect', () => {
  it('re-sealed token bundle is readable (was SIGNATURE_INVALID)', async () => {
    await sealAndStore(OAUTH_FIELD, NON_EXPIRING_BUNDLE);
    expect(await loadAndUnseal(OAUTH_FIELD)).toBe(NON_EXPIRING_BUNDLE);

    // Disconnect tombstones the field.
    await deleteFromVault(OAUTH_FIELD);
    expect(await vaultFieldExists(OAUTH_FIELD)).toBe(false);

    // Reconnect writes a fresh bundle over the tombstone.
    const reconnected = JSON.stringify({ accessToken: 'gho_second_connect' });
    await sealAndStore(OAUTH_FIELD, reconnected);

    expect(await vaultFieldExists(OAUTH_FIELD)).toBe(true);
    expect(await loadAndUnseal(OAUTH_FIELD)).toBe(reconnected);
  });

  it('chains the re-sealed entry onto the tombstone it replaced', async () => {
    await sealAndStore(OAUTH_FIELD, NON_EXPIRING_BUNDLE);
    const tombstone = await deleteFromVault(OAUTH_FIELD);
    await sealAndStore(OAUTH_FIELD, JSON.stringify({ accessToken: 'gho_second' }));

    const entries = await readVaultEntries();
    const latest = entries.at(-1)!;
    // The audit chain must not silently restart at the reconnect.
    expect(latest.previousCid).toBe(tombstone!.cid);
  });

  it('survives repeated disconnect/reconnect cycles', async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await sealAndStore(OAUTH_FIELD, JSON.stringify({ accessToken: `gho_${cycle}` }));
      expect(await loadAndUnseal(OAUTH_FIELD)).toContain(`gho_${cycle}`);
      await deleteFromVault(OAUTH_FIELD);
      expect(await vaultFieldExists(OAUTH_FIELD)).toBe(false);
    }
  });

  it('keeps sibling fields readable across a disconnect of one field', async () => {
    const config = JSON.stringify({ clientId: 'iv1', clientSecret: 's', redirectUri: 'https://x' });
    await sealAndStore(CONFIG_FIELD, config);
    await sealAndStore(OAUTH_FIELD, NON_EXPIRING_BUNDLE);

    await deleteFromVault(OAUTH_FIELD);
    await sealAndStore(OAUTH_FIELD, NON_EXPIRING_BUNDLE);

    expect(await loadAndUnseal(CONFIG_FIELD)).toBe(config);
    expect(await loadAndUnseal(OAUTH_FIELD)).toBe(NON_EXPIRING_BUNDLE);
  });
});

// ── Status reads are fail-closed (#1518) ──────────────────────────────────────

describe('vaultFieldExists', () => {
  it('returns false for an absent field', async () => {
    expect(await vaultFieldExists(`github-pat:${OWNER_DID}`)).toBe(false);
  });

  it('returns true for a sealed, verifiable field', async () => {
    await sealAndStore(CONFIG_FIELD, '{"clientId":"iv1"}');
    expect(await vaultFieldExists(CONFIG_FIELD)).toBe(true);
  });

  it('returns false instead of throwing when the entry is unverifiable', async () => {
    await sealAndStore(CONFIG_FIELD, '{"clientId":"iv1"}');
    await corruptLatestEntry(CONFIG_FIELD);

    // The whole point of #1518: a corrupt entry must not 500 the status
    // endpoint, because the Disconnect button lives behind that same response.
    expect(await vaultFieldExists(CONFIG_FIELD)).toBe(false);
  });
});

// ── Disconnect is a working recovery path (#1519) ─────────────────────────────

describe('deleteFromVault recovery', () => {
  it('tombstones an unverifiable entry so the connector can be reset', async () => {
    await sealAndStore(CONFIG_FIELD, '{"clientId":"iv1"}');
    await corruptLatestEntry(CONFIG_FIELD);

    const tombstone = await deleteFromVault(CONFIG_FIELD);
    expect(tombstone).toBeDefined();
    expect(tombstone!.deleted).toBe(true);
    expect(await vaultFieldExists(CONFIG_FIELD)).toBe(false);
  });

  it('allows re-sealing a field that was previously corrupt', async () => {
    await sealAndStore(CONFIG_FIELD, '{"clientId":"iv1"}');
    await corruptLatestEntry(CONFIG_FIELD);
    await deleteFromVault(CONFIG_FIELD);

    const reconfigured = '{"clientId":"iv2"}';
    await sealAndStore(CONFIG_FIELD, reconfigured);
    expect(await loadAndUnseal(CONFIG_FIELD)).toBe(reconfigured);
  });

  it('is a no-op for a field that never existed', async () => {
    await expect(deleteFromVault(`never-sealed:${OWNER_DID}`)).resolves.toBeUndefined();
  });

  it('is idempotent when called twice', async () => {
    await sealAndStore(OAUTH_FIELD, NON_EXPIRING_BUNDLE);
    await deleteFromVault(OAUTH_FIELD);
    await expect(deleteFromVault(OAUTH_FIELD)).resolves.toBeDefined();
    expect(await vaultFieldExists(OAUTH_FIELD)).toBe(false);
  });
});
