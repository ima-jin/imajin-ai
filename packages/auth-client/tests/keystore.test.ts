/**
 * Tests for `@ima-jin/auth-client`'s local bootstrap-keystore file (#2411).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKeystore, writeKeystore, resolveKeystorePath } from '../src/keystore';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imajin-keystore-test-'));
  delete process.env.IMAJIN_APP_KEYSTORE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.IMAJIN_APP_KEYSTORE;
});

describe('resolveKeystorePath', () => {
  it('prefers an explicit path over the env var and default', () => {
    process.env.IMAJIN_APP_KEYSTORE = '/env/path.json';
    expect(resolveKeystorePath('/explicit/path.json')).toBe('/explicit/path.json');
  });

  it('falls back to IMAJIN_APP_KEYSTORE when no explicit path is given', () => {
    process.env.IMAJIN_APP_KEYSTORE = '/env/path.json';
    expect(resolveKeystorePath()).toBe('/env/path.json');
  });

  it('falls back to the default path when neither is set', () => {
    expect(resolveKeystorePath()).toBe('./.imajin/keystore.json');
  });
});

describe('readKeystore', () => {
  it('returns null when the file does not exist', () => {
    expect(readKeystore(join(dir, 'missing.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const path = join(dir, 'bad.json');
    writeKeystore(path, { publicKey: 'irrelevant', privateKey: 'irrelevant' });
    // Overwrite with garbage after the fact.
    writeFileSync(path, 'not json');
    expect(readKeystore(path)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const path = join(dir, 'partial.json');
    writeFileSync(path, JSON.stringify({ bootstrapPublicKey: 'only-one-field' }));
    expect(readKeystore(path)).toBeNull();
  });
});

describe('writeKeystore / readKeystore round-trip', () => {
  it('round-trips a keypair', () => {
    const path = join(dir, 'keystore.json');
    const keypair = { publicKey: 'pub-hex', privateKey: 'priv-hex' };

    writeKeystore(path, keypair);
    const read = readKeystore(path);

    expect(read).toEqual(keypair);
  });

  it('creates parent directories as needed', () => {
    const path = join(dir, 'nested', 'deep', 'keystore.json');

    writeKeystore(path, { publicKey: 'pub', privateKey: 'priv' });

    expect(readKeystore(path)).toEqual({ publicKey: 'pub', privateKey: 'priv' });
  });

  it('writes the file with mode 0600 (owner read/write only)', () => {
    const path = join(dir, 'keystore.json');
    writeKeystore(path, { publicKey: 'pub', privateKey: 'priv' });

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('re-chmods to 0600 even when overwriting an existing, more-permissive file', () => {
    const path = join(dir, 'keystore.json');
    writeKeystore(path, { publicKey: 'pub1', privateKey: 'priv1' });
    chmodSync(path, 0o644);

    writeKeystore(path, { publicKey: 'pub2', privateKey: 'priv2' });

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readKeystore(path)).toEqual({ publicKey: 'pub2', privateKey: 'priv2' });
  });
});
