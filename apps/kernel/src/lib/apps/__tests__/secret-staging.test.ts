import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sealSecret, unsealSecret } from '@imajin/vault-core';

const state = vi.hoisted(() => ({
  seal: vi.fn(), read: vi.fn(), erase: vi.fn(), insert: vi.fn(), claim: vi.fn(), tier1: false,
}));
vi.mock('@/src/lib/vault', () => ({
  sealAndStore: state.seal, loadAndUnseal: state.read, deleteFromVault: state.erase,
}));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:fake-node' }), isVaultTier1: () => state.tier1,
}));
vi.mock('@/src/db', () => ({
  internalSecretProvisions: {},
  db: {
    insert: () => ({ values: state.insert }),
    delete: () => ({ where: () => ({ returning: state.claim }) }),
  },
}));
import { consumeAppSecret, isAppSecretValue, stageAppSecret, type AppSecretStagingBinding } from '../secret-staging';
import { isAppSecretStagingField, isAppSelfSecretField } from '../../vault/field-grammar';

const binding: AppSecretStagingBinding = {
  proposalId: 'fake-proposal', operatorDid: 'did:imajin:fake-owner',
  appDid: 'did:imajin:fake-app', name: 'DATABASE_URL', action: 'set',
};
const VALUE = 'OBVIOUSLY_FAKE_OPERATOR_INPUT';
const key = randomBytes(32);
let stored: ReturnType<typeof sealSecret> | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  stored = undefined;
  state.tier1 = false;
  state.seal.mockImplementation(async (_field: string, plaintext: string) => { stored = sealSecret(plaintext, key); });
  state.read.mockImplementation(async () => stored && unsealSecret(stored, key));
  let available = true;
  state.claim.mockImplementation(async () => {
    if (!available) return [];
    available = false;
    return [{ id: 'fake-marker' }];
  });
});
afterEach(() => vi.useRealTimers());

describe('sealed operator input staging', () => {
  it('persists only sealed input plus a value-free claim, with no grant or value hash', async () => {
    const ref = await stageAppSecret(binding, VALUE);
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(stored)).not.toContain(VALUE);
    expect(state.insert).toHaveBeenCalledWith({
      id: ref, ownerDid: 'did:imajin:fake-node',
      purpose: `app-self:staging:${ref}`, field: `internal-secret:app-self:staging:${ref}`,
    });
    const field = state.insert.mock.calls[0][0].field;
    expect(isAppSelfSecretField(field)).toBe(true);
    expect(isAppSecretStagingField(field)).toBe(true);
    expect(JSON.stringify(state.insert.mock.calls)).not.toContain(VALUE);
    expect(await consumeAppSecret(ref, binding)).toBe(VALUE);
    expect(state.erase).toHaveBeenCalledWith(field);
  });
  it.each(['proposalId', 'operatorDid', 'appDid', 'name', 'action'] as const)('rejects a mismatched %s before claiming or importing', async (field) => {
    const ref = await stageAppSecret(binding, VALUE);
    await expect(consumeAppSecret(ref, { ...binding, [field]: 'fake-other-binding' })).rejects.toThrow('App-secret staging unavailable');
    expect(state.claim).not.toHaveBeenCalled();
    expect(state.erase).not.toHaveBeenCalled();
    expect(await consumeAppSecret(ref, binding)).toBe(VALUE);
  });
  it('has exactly one winner across concurrent consumption and refuses replay', async () => {
    const ref = await stageAppSecret(binding, VALUE);
    const results = await Promise.allSettled([consumeAppSecret(ref, binding), consumeAppSecret(ref, binding)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: VALUE }]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(consumeAppSecret(ref, binding)).rejects.toThrow('App-secret staging unavailable');
    expect(state.erase).toHaveBeenCalledTimes(1);
  });
  it('expires after 24 hours and cannot release a value', async () => {
    vi.useFakeTimers();
    const ref = await stageAppSecret(binding, VALUE);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await expect(consumeAppSecret(ref, binding)).rejects.toThrow('App-secret staging unavailable');
    expect(state.claim).not.toHaveBeenCalled();
  });
  it('burns the reference and releases nothing if tombstoning fails', async () => {
    const ref = await stageAppSecret(binding, VALUE);
    state.erase.mockRejectedValueOnce(new Error(VALUE));
    await expect(consumeAppSecret(ref, binding)).rejects.toThrow('App-secret staging unavailable');
    await expect(consumeAppSecret(ref, binding)).rejects.toThrow('App-secret staging unavailable');
  });
  it('refuses invalid references before reading custody and redacts provider errors', async () => {
    await expect(consumeAppSecret('fake-invalid-reference', binding)).rejects.toThrow('App-secret staging unavailable');
    expect(state.read).not.toHaveBeenCalled();
    state.seal.mockRejectedValueOnce(new Error(VALUE));
    await expect(stageAppSecret(binding, VALUE)).rejects.toThrow('App-secret staging unavailable');
    expect(state.insert).not.toHaveBeenCalled();
  });
  it('refuses unsupported Tier 1 custody and invalid input without sealing', async () => {
    state.tier1 = true;
    await expect(stageAppSecret(binding, VALUE)).rejects.toThrow('App-secret staging unavailable');
    state.tier1 = false;
    await expect(stageAppSecret(binding, '')).rejects.toThrow('App-secret staging unavailable');
    expect(state.seal).not.toHaveBeenCalled();
    expect(isAppSecretValue('😀'.repeat(16_384))).toBe(true);
    expect(isAppSecretValue('😀'.repeat(16_385))).toBe(false);
  });
  it.each([undefined, 'fake-invalid-json', JSON.stringify({ ...binding, value: '', expiresAt: Number.MAX_SAFE_INTEGER })])('redacts missing or malformed staged state', async (data) => {
    const ref = await stageAppSecret(binding, VALUE);
    state.read.mockResolvedValueOnce(data);
    await expect(consumeAppSecret(ref, binding)).rejects.toThrow('App-secret staging unavailable');
    expect(state.claim).not.toHaveBeenCalled();
  });
});
