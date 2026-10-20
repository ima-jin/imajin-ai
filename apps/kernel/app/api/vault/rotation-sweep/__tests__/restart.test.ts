import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  admin: vi.fn(), load: vi.fn(), store: vi.fn(), log: vi.fn(),
}));
vi.mock('@imajin/auth', async (original) => ({
  ...await original<typeof import('@imajin/auth')>(), requireAdmin: h.admin,
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: h.log, error: h.log, warn: h.log }) }));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: h.load, sealAndStoreV2: h.store }));
vi.mock('@/src/db', () => ({
  db: { selectDistinct: () => ({ from: () => ({ where: async () => [{ field: 'API_KEY' }] }) }) },
  vaultDelegationGrants: { field: 'field', status: 'status' },
}));
import { crypto as authCrypto } from '@imajin/auth';
import { _resetSealingCache } from '@/src/lib/vault/sealing';
import { _resetVaultPathCacheForTests } from '@/src/lib/vault/vault-path';
import { GET, POST } from '../route';

const request = (body: unknown) => new Request('https://kernel.test/api/vault/rotation-sweep', {
  method: 'POST', body: JSON.stringify(body),
}) as never;
afterEach(() => {
  vi.unstubAllEnvs();
  _resetSealingCache();
  _resetVaultPathCacheForTests();
  vi.clearAllMocks();
});

it('carries only authenticated ciphertext across the restart boundary and never returns or logs plaintext', async () => {
  const oldKey = randomBytes(32).toString('hex');
  const newKey = randomBytes(32).toString('hex');
  const plaintext = randomBytes(48).toString('base64');
  const newPublicKey = authCrypto.getPublicKey(newKey);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rotation-http-'));
  const vaultPath = path.join(directory, 'vault.json');
  vi.stubEnv('VAULT_PATH', vaultPath);
  vi.stubEnv('AUTH_PRIVATE_KEY', oldKey);
  vi.stubEnv('AUTH_PREVIOUS_PUBLIC_KEY', authCrypto.getPublicKey(oldKey));
  _resetSealingCache();
  _resetVaultPathCacheForTests();
  h.admin.mockResolvedValue(true);
  let resealed = false;
  h.load.mockImplementation(async () => {
    if (process.env.AUTH_PRIVATE_KEY !== oldKey && !resealed) throw new Error('Old grant is unreadable');
    return plaintext;
  });
  h.store.mockImplementation(async (_field, value) => {
    if (value !== plaintext || process.env.AUTH_PRIVATE_KEY !== newKey) throw new Error('Incorrect restore');
    resealed = true;
  });
  const exported = await POST(request({ phase: 'export', newPublicKey }));
  expect(exported.status).toBe(200);
  expect(await exported.json()).toEqual({ exported: 1, newPublicKey });
  const ciphertext = await readFile(`${vaultPath}.key-rotation.sealed`, 'utf8');
  for (const value of [oldKey, newKey, plaintext]) {
    if (ciphertext.includes(value)) throw new Error('Private material persisted outside encryption');
  }

  // Clear all process-lifetime caches, keeping only filesystem state.
  vi.stubEnv('AUTH_PRIVATE_KEY', newKey);
  _resetSealingCache();
  _resetVaultPathCacheForTests();
  expect(await (await GET()).json()).toEqual({ pending: true, exported: 1, newPublicKey });
  const response = await POST(request({ phase: 'reimport' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ resealed: 1 });
  expect(await (await GET()).json()).toEqual({ pending: false });
  expect(h.store).toHaveBeenCalledTimes(1);
  const replay = await POST(request({ phase: 'reimport' }));
  expect(replay.status).toBe(409);
  const replayText = await replay.text();
  for (const value of [oldKey, newKey, plaintext]) {
    if (replayText.includes(value)) throw new Error('Private material disclosed in response');
    expect(JSON.stringify(h.log.mock.calls).includes(value)).toBe(false);
  }
});
