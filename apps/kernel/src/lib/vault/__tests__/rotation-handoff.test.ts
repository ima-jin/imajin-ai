import { randomBytes } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crypto as authCrypto } from '@imajin/auth';
import { _resetSealingCache } from '../sealing';
import { _resetVaultPathCacheForTests } from '../vault-path';
import {
  exportRotationHandoff, isSweepField, openRotationHandoff, reimportRotationHandoff,
  rotationHandoffStatus, sealRotationHandoff, validateRotationRecipient,
} from '../rotation-handoff';

const log = vi.hoisted(() => vi.fn());
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: log, warn: log, error: log }) }));
const seed = () => randomBytes(32).toString('hex');
let oldKey: string;
let newKey: string;
let plaintext: string;
let filename: string;
let newPublicKey: string;
let oldPublicKey: string;
beforeEach(async () => {
  oldKey = seed();
  newKey = seed();
  plaintext = randomBytes(48).toString('base64');
  oldPublicKey = authCrypto.getPublicKey(oldKey);
  newPublicKey = authCrypto.getPublicKey(newKey);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rotation-handoff-'));
  vi.stubEnv('VAULT_PATH', path.join(directory, 'vault.json'));
  vi.stubEnv('AUTH_PRIVATE_KEY', oldKey);
  vi.stubEnv('AUTH_PREVIOUS_PUBLIC_KEY', oldPublicKey);
  filename = `${process.env.VAULT_PATH}.key-rotation.sealed`;
  _resetVaultPathCacheForTests();
  _resetSealingCache();
  log.mockClear();
});
afterEach(() => {
  // Test-generated keys are never put in assertion diagnostics.
  expect(JSON.stringify(log.mock.calls).includes(plaintext)).toBe(false);
  expect(JSON.stringify(log.mock.calls).includes(oldKey)).toBe(false);
  expect(JSON.stringify(log.mock.calls).includes(newKey)).toBe(false);
  vi.unstubAllEnvs();
  _resetVaultPathCacheForTests();
  _resetSealingCache();
});
const collect = () => Promise.resolve([{ field: 'API_KEY', plaintext }]);
function bootNewKey() {
  vi.stubEnv('AUTH_PRIVATE_KEY', newKey);
  _resetSealingCache();
  _resetVaultPathCacheForTests();
}

describe('rotation handoff cryptography', () => {
  it('encrypts only to the new key and binds old source and storage context', () => {
    const envelope = sealRotationHandoff([{ field: 'API_KEY', plaintext }], newPublicKey, oldKey, filename);
    expect(JSON.stringify(envelope).includes(plaintext)).toBe(false);
    expect(JSON.stringify(envelope).includes(oldKey)).toBe(false);
    expect(JSON.stringify(envelope).includes(newKey)).toBe(false);
    const fields = openRotationHandoff(envelope, newKey, oldPublicKey, filename);
    if (fields[0].plaintext !== plaintext) throw new Error('Decrypted value did not match');
    expect(() => openRotationHandoff(envelope, oldKey, oldPublicKey, filename)).toThrow();
    expect(() => openRotationHandoff(envelope, newKey, newPublicKey, filename)).toThrow();
    expect(() => openRotationHandoff(envelope, newKey, oldPublicKey, `${filename}.other`)).toThrow();
  });
  it.each(['newPublicKey', 'oldPublicKey', 'exported', 'nonce', 'tag', 'ciphertext', 'signature', 'ephemeralPublicKey'])(
    'rejects tampering with %s', (property) => {
      const envelope = sealRotationHandoff([{ field: 'API_KEY', plaintext }], newPublicKey, oldKey, filename);
      const modified = { ...envelope, [property]: property === 'exported' ? 2 : 'invalid' };
      expect(() => openRotationHandoff(modified, newKey, oldPublicKey, filename)).toThrow();
    },
  );
  it.each([null, {}, [], { version: 2 }])('rejects malformed envelopes', (envelope) => {
    expect(() => openRotationHandoff(envelope, newKey, oldPublicKey, filename)).toThrow();
  });
  it('rejects same-key rotations and invalid or small-order recipients', () => {
    expect(() => sealRotationHandoff([], oldPublicKey, oldKey, filename)).toThrow();
    for (const invalid of [undefined, '', 'xyz', '0'.repeat(64), `01${'00'.repeat(31)}`]) {
      expect(() => validateRotationRecipient(invalid)).toThrow();
    }
  });
  it.each(['vault-group-key:group', 'vault-imported-key:credential', 'internal-secret:app-self:app:key', 'a::b'])(
    'rejects protected or invalid decrypted field %s before writes', (field) => {
      expect(isSweepField(field)).toBe(false);
      const envelope = sealRotationHandoff([{ field, plaintext }], newPublicKey, oldKey, filename);
      expect(() => openRotationHandoff(envelope, newKey, oldPublicKey, filename)).toThrow();
    },
  );
  it('rejects duplicate fields in an otherwise authentic handoff', () => {
    const envelope = sealRotationHandoff([
      { field: 'API_KEY', plaintext }, { field: 'API_KEY', plaintext },
    ], newPublicKey, oldKey, filename);
    expect(() => openRotationHandoff(envelope, newKey, oldPublicKey, filename)).toThrow();
  });
});

describe('persistent sealed rotation state', () => {
  it('survives a kernel cache reset, keeps ciphertext only and removes it after reimport', async () => {
    expect(await rotationHandoffStatus()).toEqual({ pending: false });
    expect(await exportRotationHandoff(newPublicKey, collect)).toEqual({ exported: 1, newPublicKey });
    const bytes = await readFile(filename, 'utf8');
    expect(bytes.includes(plaintext)).toBe(false);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    bootNewKey();
    expect(await rotationHandoffStatus()).toEqual({ pending: true, exported: 1, newPublicKey });
    let matched = false;
    const store = vi.fn(async (field: string, value: string) => { matched = field === 'API_KEY' && value === plaintext; });
    expect(await reimportRotationHandoff(store)).toEqual({ resealed: 1 });
    expect(matched).toBe(true);
    expect(await rotationHandoffStatus()).toEqual({ pending: false });
    await expect(reimportRotationHandoff(store)).rejects.toThrow();
    expect(store).toHaveBeenCalledTimes(1);
  });
  it('refuses overwrite before collecting plaintext', async () => {
    await exportRotationHandoff(newPublicKey, collect);
    const collector = vi.fn(collect);
    await expect(exportRotationHandoff(newPublicKey, collector)).rejects.toThrow();
    expect(collector).not.toHaveBeenCalled();
  });
  it('retains a full handoff after partial failure for roll-forward retry', async () => {
    await exportRotationHandoff(newPublicKey, async () => [
      { field: 'FIRST', plaintext }, { field: 'SECOND', plaintext },
    ]);
    const before = await readFile(filename, 'utf8');
    bootNewKey();
    let calls = 0;
    await expect(reimportRotationHandoff(async () => { if (++calls === 2) throw new Error('storage failure'); })).rejects.toThrow();
    expect(await readFile(filename, 'utf8')).toBe(before);
    expect(await reimportRotationHandoff(async () => {})).toEqual({ resealed: 2 });
  });
  it('refuses the wrong loaded key and missing previous-key pin without writes', async () => {
    await exportRotationHandoff(newPublicKey, collect);
    const store = vi.fn();
    await expect(reimportRotationHandoff(store)).rejects.toThrow();
    bootNewKey();
    vi.stubEnv('AUTH_PREVIOUS_PUBLIC_KEY', '');
    await expect(reimportRotationHandoff(store)).rejects.toThrow();
    expect(store).not.toHaveBeenCalled();
    expect((await rotationHandoffStatus()).pending).toBe(true);
  });
  it('serializes stores so concurrent vault-file writes cannot overwrite each other', async () => {
    await exportRotationHandoff(newPublicKey, async () => [
      { field: 'FIRST', plaintext }, { field: 'SECOND', plaintext },
    ]);
    bootNewKey();
    let active = false;
    const order: string[] = [];
    await reimportRotationHandoff(async (field) => {
      if (active) throw new Error('Concurrent vault write');
      active = true;
      order.push(field);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active = false;
    });
    expect(order).toEqual(['FIRST', 'SECOND']);
  });
  it('requires an explicit old node key, never the development fallback', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(exportRotationHandoff(newPublicKey, collect)).rejects.toThrow();
    expect(await rotationHandoffStatus()).toEqual({ pending: false });
  });
  it('allows an empty sweep across restart', async () => {
    await exportRotationHandoff(newPublicKey, async () => []);
    bootNewKey();
    expect(await reimportRotationHandoff(vi.fn())).toEqual({ resealed: 0 });
  });
  it('fails closed on an abandoned lock and allows explicit stopped-worker recovery', async () => {
    await writeFile(`${filename}.lock`, '', { mode: 0o600 });
    const collector = vi.fn(collect);
    await expect(exportRotationHandoff(newPublicKey, collector)).rejects.toThrow();
    expect(collector).not.toHaveBeenCalled();
    await unlink(`${filename}.lock`);
    await exportRotationHandoff(newPublicKey, collect);
  });
  it('leaves no handoff after collection failure and permits a retry', async () => {
    await expect(exportRotationHandoff(newPublicKey, async () => { throw new Error('unreadable'); })).rejects.toThrow();
    expect(await rotationHandoffStatus()).toEqual({ pending: false });
    await exportRotationHandoff(newPublicKey, collect);
  });
  it('rejects malformed storage and never overwrites it', async () => {
    await writeFile(filename, '{', { mode: 0o600 });
    await expect(rotationHandoffStatus()).rejects.toThrow();
    await expect(exportRotationHandoff(newPublicKey, collect)).rejects.toThrow();
    expect(await readFile(filename, 'utf8')).toBe('{');
  });
  it.each(['symlink', 'hardlink', 'permissions'])('rejects unsafe %s storage', async (kind) => {
    await exportRotationHandoff(newPublicKey, collect);
    if (kind === 'permissions') await chmod(filename, 0o644);
    else {
      const other = `${filename}.other`;
      if (kind === 'hardlink') await link(filename, other);
      else {
        await unlink(filename);
        await writeFile(other, '{}', { mode: 0o600 });
        await symlink(other, filename);
      }
    }
    await expect(rotationHandoffStatus()).rejects.toThrow();
    const store = vi.fn();
    await expect(reimportRotationHandoff(store)).rejects.toThrow();
    expect(store).not.toHaveBeenCalled();
  });
});
