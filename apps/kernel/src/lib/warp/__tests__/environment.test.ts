/**
 * Tests for the per-DID Warp environment default (#1632).
 *
 * The vault is mocked, so these pin the contract this module owes its callers:
 * the field name, what counts as a storable value, and — most importantly — that
 * reads degrade to "no default" instead of throwing, since a preference must
 * never be able to fail an otherwise-authorized dispatch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sealAndStoreMock, loadAndUnsealMock, deleteFromVaultMock, logMock } = vi.hoisted(() => ({
  sealAndStoreMock: vi.fn(),
  loadAndUnsealMock: vi.fn(),
  deleteFromVaultMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/src/lib/vault', () => ({
  sealAndStore: sealAndStoreMock,
  loadAndUnseal: loadAndUnsealMock,
  deleteFromVault: deleteFromVaultMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logMock,
}));

import {
  WARP_ENVIRONMENT_PREFIX,
  clearEnvironmentId,
  isValidEnvironmentId,
  readEnvironmentId,
  warpEnvironmentField,
  writeEnvironmentId,
} from '../environment';

const DID = 'did:imajin:veteze';
const FIELD = `${WARP_ENVIRONMENT_PREFIX}:${DID}`;
/** The first environment this wire was actually pointed at. */
const ENV_ID = 'L2DO7swtN7Ku3G7gVPwziI';

beforeEach(() => {
  sealAndStoreMock.mockReset().mockResolvedValue(undefined);
  loadAndUnsealMock.mockReset().mockResolvedValue(undefined);
  deleteFromVaultMock.mockReset().mockResolvedValue(undefined);
  logMock.info.mockReset();
  logMock.warn.mockReset();
});

// ── Field naming ──────────────────────────────────────────────────────────────

describe('the vault field is namespaced per DID', () => {
  it('encodes the DID so one DID can never read another default', () => {
    expect(warpEnvironmentField(DID)).toBe(FIELD);
    expect(warpEnvironmentField('did:imajin:someone-else')).not.toBe(FIELD);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe('environment id validation', () => {
  it.each([
    ['a real Warp environment uid', ENV_ID],
    ['hyphens', 'env-with-hyphens'],
    ['underscores', 'env_with_underscores'],
    ['a single character', 'a'],
    ['64 characters', 'a'.repeat(64)],
  ])('accepts %s', (_label, value) => {
    expect(isValidEnvironmentId(value)).toBe(true);
  });

  it.each([
    ['the empty string', ''],
    ['whitespace', ' '],
    ['an embedded space', 'two words'],
    ['a slash', 'env/with/slash'],
    ['a colon', 'env:with:colon'],
    ['65 characters', 'a'.repeat(65)],
  ])('rejects %s', (_label, value) => {
    expect(isValidEnvironmentId(value)).toBe(false);
  });
});

// ── Write ─────────────────────────────────────────────────────────────────────

describe('writeEnvironmentId', () => {
  it('seals the trimmed value into the per-DID field', async () => {
    await writeEnvironmentId(DID, `  ${ENV_ID}  `);

    expect(sealAndStoreMock).toHaveBeenCalledWith(FIELD, ENV_ID);
  });

  it('refuses an invalid value without touching the vault', async () => {
    await expect(writeEnvironmentId(DID, 'has a space')).rejects.toThrow(
      /warp_invalid_environment_id/,
    );
    expect(sealAndStoreMock).not.toHaveBeenCalled();
  });

  it('refuses an empty value rather than sealing a blank default', async () => {
    await expect(writeEnvironmentId(DID, '   ')).rejects.toThrow(
      /warp_invalid_environment_id/,
    );
    expect(sealAndStoreMock).not.toHaveBeenCalled();
  });

  it('never logs the value it stored', async () => {
    await writeEnvironmentId(DID, ENV_ID);

    expect(JSON.stringify(logMock.info.mock.calls)).not.toContain(ENV_ID);
  });
});

// ── Read ──────────────────────────────────────────────────────────────────────

describe('readEnvironmentId', () => {
  it('returns the stored value', async () => {
    loadAndUnsealMock.mockResolvedValue(ENV_ID);

    expect(await readEnvironmentId(DID)).toBe(ENV_ID);
    expect(loadAndUnsealMock).toHaveBeenCalledWith(FIELD);
  });

  it('returns undefined when nothing is stored', async () => {
    expect(await readEnvironmentId(DID)).toBeUndefined();
  });

  it('trims a stored value that picked up whitespace', async () => {
    loadAndUnsealMock.mockResolvedValue(`\n${ENV_ID}\n`);

    expect(await readEnvironmentId(DID)).toBe(ENV_ID);
  });

  it('ignores a stored value that is no longer valid', async () => {
    // Defence against a value written by an older or looser path: sending junk on
    // to Warp turns a bad preference into a failed dispatch.
    loadAndUnsealMock.mockResolvedValue('not a valid id');

    expect(await readEnvironmentId(DID)).toBeUndefined();
  });

  it('degrades to no-default when the vault read throws, and says so', async () => {
    loadAndUnsealMock.mockRejectedValue(new Error('vault exploded'));

    expect(await readEnvironmentId(DID)).toBeUndefined();
    expect(logMock.warn).toHaveBeenCalled();
  });
});

// ── Clear ─────────────────────────────────────────────────────────────────────

describe('clearEnvironmentId', () => {
  it('tombstones the field and reports that something was cleared', async () => {
    deleteFromVaultMock.mockResolvedValue({ field: FIELD });

    expect(await clearEnvironmentId(DID)).toBe(true);
    expect(deleteFromVaultMock).toHaveBeenCalledWith(FIELD);
  });

  it('is a no-op when no default was set', async () => {
    expect(await clearEnvironmentId(DID)).toBe(false);
  });
});
