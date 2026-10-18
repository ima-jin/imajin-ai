import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptPrivateKey, encryptPrivateKey } from '../crypto';

const log = vi.hoisted(() => vi.fn());
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: log, info: log, warn: log, debug: log }) }));

let seed: string;
let stored: { encryptedKey: string; salt: string; keyDerivation: string };
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('GROUP_KEY_ENCRYPTION_SECRET', randomBytes(32).toString('hex'));
  seed = randomBytes(32).toString('hex');
  stored = { ...await encryptPrivateKey(seed), keyDerivation: 'pbkdf2' };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function unavailable(input = stored) {
  const error = await decryptPrivateKey(input).then(() => null, value => value as Error);
  expect(error).toBeInstanceOf(Error);
  expect(error?.message).toBe('Stored group key unavailable');
  expect(JSON.stringify([error?.message, error?.stack, error?.cause, log.mock.calls]).includes(seed)).toBe(false);
}

describe('decryptPrivateKey server-held AES-GCM format', () => {
  it('roundtrips generated Ed25519 seeds without plaintext in ciphertext or logs', async () => {
    expect(await decryptPrivateKey(stored) === seed).toBe(true);
    expect(JSON.stringify([stored, log.mock.calls]).includes(seed)).toBe(false);
  });
  it.each(['iv', 'ciphertext', 'tag', 'salt'])('authenticates %s against tampering', async part => {
    const bytes = Buffer.from(part === 'salt' ? stored.salt : stored.encryptedKey, 'base64');
    bytes[part === 'tag' ? bytes.length - 1 : part === 'ciphertext' ? 20 : 0] ^= 1;
    if (part === 'salt') stored.salt = bytes.toString('base64');
    else stored.encryptedKey = bytes.toString('base64');
    await unavailable();
  });
  it.each(['missing', 'wrong'])('rejects a %s encryption secret with a value-free error', async mode => {
    vi.stubEnv('GROUP_KEY_ENCRYPTION_SECRET', mode === 'missing' ? '' : randomBytes(32).toString('hex'));
    await unavailable();
  });
  it.each([
    { keyDerivation: 'scrypt' }, { encryptedKey: '' }, { salt: '' },
    { encryptedKey: 'not base64' }, { salt: 'not base64' },
    { encryptedKey: Buffer.alloc(91).toString('base64') }, { salt: Buffer.alloc(15).toString('base64') },
  ])('rejects malformed or unsupported stored format %#', async patch => {
    await unavailable({ ...stored, ...patch });
  });
  it('rejects noncanonical base64 rather than accepting ignored suffix bytes', async () => {
    await unavailable({ ...stored, encryptedKey: stored.encryptedKey + '\n' });
    await unavailable({ ...stored, salt: stored.salt + '\n' });
  });
  it.each(['not-a-seed', 'z'.repeat(64), 'a'.repeat(63)])('rejects authenticated plaintext that is not a 32-byte hex seed (%#)', async value => {
    await unavailable({ ...await encryptPrivateKey(value), keyDerivation: 'pbkdf2' });
  });
  it('contains provider exceptions even when the provider includes plaintext in diagnostics', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockRejectedValueOnce(new Error(`provider decrypted ${seed}`));
    await unavailable();
  });
});
