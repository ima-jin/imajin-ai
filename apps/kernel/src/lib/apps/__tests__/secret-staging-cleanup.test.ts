import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileVaultRepository, VaultEntryService, sealSecret, unsealSecret } from '@imajin/vault-core';

const state = vi.hoisted(() => ({
  seal: vi.fn(), read: vi.fn(), erase: vi.fn(), insert: vi.fn(),
  rows: vi.fn(), remove: vi.fn(), error: vi.fn(), vault: vi.fn(), claim: vi.fn(),
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: state.error }) }));
vi.mock('@/src/lib/vault', () => ({
  sealAndStore: state.seal, loadAndUnseal: state.read, deleteFromVault: state.erase,
  vaultService: { purge: state.erase, loadVault: state.vault },
}));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:fake-node' }), isVaultTier1: () => false,
}));
vi.mock('@/src/db', () => ({
  internalSecretProvisions: {},
  db: {
    insert: () => ({ values: state.insert }),
    select: () => ({ from: () => ({ where: state.rows }) }),
    delete: () => ({ where: () => ({
      returning: state.claim,
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => state.remove().then(resolve, reject),
    }) }),
  },
}));
import { consumeAppSecret, discardAppSecretForProposal, sweepExpiredAppSecretStaging, stageAppSecret } from '../secret-staging';

const binding = {
  proposalId: 'fake-proposal', operatorDid: 'did:imajin:fake-owner',
  appDid: 'did:imajin:fake-app', name: 'DATABASE_URL', action: 'set' as const,
};
const VALUE = 'OBVIOUSLY_FAKE_OPERATOR_INPUT';
const stored = new Map<string, string>();
beforeEach(() => {
  vi.resetAllMocks();
  stored.clear();
  state.rows.mockResolvedValue([]);
  state.vault.mockResolvedValue({ entries: [] });
  state.remove.mockResolvedValue([]);
  state.seal.mockImplementation(async (field: string, data: string) => { stored.set(field, data); });
  state.read.mockImplementation(async (field: string) => stored.get(field));
  state.erase.mockImplementation(async (field: string) => { stored.delete(field); });
});
afterEach(() => vi.useRealTimers());

function terminalCard(ref: string, overrides = {}) {
  return {
    ...binding, source: 'apps', kind: 'apps:secrets-set', status: 'denied',
    detail: { appDid: binding.appDid, name: binding.name, stagingRef: ref }, ...overrides,
  };
}

async function stagedRow() {
  const ref = await stageAppSecret(binding, VALUE);
  return { id: ref, purpose: `app-self:staging:${ref}`, field: `internal-secret:app-self:staging:${ref}` };
}

describe('staging retirement', () => {
  it.each(['denied', 'expired', 'withdrawn'])('retires the claim then erases the vault field on %s', async (status) => {
    const row = await stagedRow();
    await discardAppSecretForProposal(terminalCard(row.id, { status }));
    expect(stored.has(row.field)).toBe(false);
    expect(state.remove).toHaveBeenCalledOnce();
    expect(state.remove.mock.invocationCallOrder[0]).toBeLessThan(state.erase.mock.invocationCallOrder[0]);
    await discardAppSecretForProposal(terminalCard(row.id, { status }));
    expect(stored.has(row.field)).toBe(false);
  });

  it('also disposes operator-supplied rotate input', async () => {
    const ref = await stageAppSecret({ ...binding, action: 'rotate' }, VALUE);
    await discardAppSecretForProposal(terminalCard(ref, { kind: 'apps:secrets-rotate' }));
    expect(state.erase).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 'pending' }, { status: 'approved' }, { status: 'applied' },
    { source: 'vault' }, { kind: 'apps:secrets-revoke' }, { detail: null },
    { detail: { stagingRef: 'invalid' } }, { proposalId: 'another-proposal' },
    { operatorDid: 'another-operator' }, { kind: 'apps:secrets-rotate' },
  ])('does not discard unrelated or mismatched input: %j', async (overrides) => {
    const row = await stagedRow();
    await discardAppSecretForProposal(terminalCard(row.id, overrides));
    expect(state.erase).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it('retries failed erasure and never logs a provider exception containing input', async () => {
    const row = await stagedRow();
    state.erase.mockRejectedValueOnce(new Error(VALUE));
    await discardAppSecretForProposal(terminalCard(row.id));
    expect(state.remove).toHaveBeenCalledOnce();
    expect(JSON.stringify(state.error.mock.calls)).not.toContain(VALUE);
    await discardAppSecretForProposal(terminalCard(row.id));
    expect(state.remove).toHaveBeenCalledTimes(2);
  });

  it('sweeps at expiresAt, preserves unexpired input, and removes stale markers idempotently', async () => {
    vi.useFakeTimers();
    const row = await stagedRow();
    state.rows.mockResolvedValue([row]);
    expect(await sweepExpiredAppSecretStaging()).toBe(0);
    expect(state.erase).not.toHaveBeenCalled();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(await sweepExpiredAppSecretStaging()).toBe(1);
    expect(stored.has(row.field)).toBe(false);
    expect(state.remove).toHaveBeenCalledOnce();
    expect(await sweepExpiredAppSecretStaging()).toBe(1);
    state.rows.mockResolvedValue([]);
    expect(await sweepExpiredAppSecretStaging()).toBe(0);
  });

  it('never reads or erases non-staging fields or inconsistent staging tuples', async () => {
    const row = await stagedRow();
    state.rows.mockResolvedValue([
      { ...row, field: 'internal-secret:kernel.cron-secret' },
      { ...row, field: 'internal-secret:app-self:did:imajin:app:DATABASE_URL' },
      { ...row, field: 'GH_TOKEN' }, { ...row, id: 'invalid' },
      { ...row, purpose: 'app-self:other' },
      { ...row, field: `${row.field}:extra` },
    ]);
    expect(await sweepExpiredAppSecretStaging(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(state.read).not.toHaveBeenCalled();
    expect(state.erase).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it.each([{}, { expiresAt: 'yesterday' }, { expiresAt: null }])('does not guess expiry for malformed data: %j', async (data) => {
    state.rows.mockResolvedValue([await stagedRow()]);
    state.read.mockResolvedValue(JSON.stringify(data));
    expect(await sweepExpiredAppSecretStaging()).toBe(0);
    expect(state.erase).not.toHaveBeenCalled();
  });

  it('continues after a failure, redacts errors, and retries retained work on the next sweep', async () => {
    const row = await stagedRow();
    const second = await stagedRow();
    state.rows.mockResolvedValue([row, second]);
    state.erase.mockRejectedValueOnce(new Error(VALUE));
    await expect(sweepExpiredAppSecretStaging(Number.MAX_SAFE_INTEGER)).rejects.toThrow('App-secret staging sweep incomplete');
    expect(state.erase).toHaveBeenCalledTimes(2);
    expect(state.remove).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.error.mock.calls)).not.toContain(VALUE);
    state.rows.mockResolvedValue([row]);
    expect(await sweepExpiredAppSecretStaging(Number.MAX_SAFE_INTEGER)).toBe(1);
  });

  it('discovers orphan input without a provisions row and ignores unrelated vault names', async () => {
    const row = await stagedRow();
    state.vault.mockResolvedValue({ entries: [
      { field: row.field }, { field: row.field },
      { field: 'GH_TOKEN' }, { field: 'internal-secret:app-self:staging:invalid' },
    ] });
    expect(await sweepExpiredAppSecretStaging(Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(state.erase).toHaveBeenCalledOnce();
    expect(state.erase).toHaveBeenCalledWith(row.field);
  });

  it('sweeps orphan input after erasure fails and its claim has already been removed', async () => {
    const row = await stagedRow();
    state.erase.mockRejectedValueOnce(new Error(VALUE));
    await discardAppSecretForProposal(terminalCard(row.id));
    state.vault.mockResolvedValue({ entries: [{ field: row.field }] });
    expect(await sweepExpiredAppSecretStaging(Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(stored.has(row.field)).toBe(false);
  });

  it('a reader paused after unsealing cannot claim input retired by rejection', async () => {
    const row = await stagedRow();
    let available = true;
    state.claim.mockImplementation(async () => available ? [{ id: row.id }] : []);
    state.remove.mockImplementation(async () => { available = false; return []; });
    let resume!: (value: string | undefined) => void;
    const data = stored.get(row.field);
    state.read.mockImplementationOnce(() => new Promise<string | undefined>(resolve => { resume = resolve; }));
    const consumption = consumeAppSecret(row.id, binding);
    const refused = expect(consumption).rejects.toThrow('App-secret staging unavailable');
    await discardAppSecretForProposal(terminalCard(row.id));
    resume(data);
    await refused;
    expect(stored.has(row.field)).toBe(false);
  });

  it.each(['reject', 'expiry'])('%s leaves no staging ciphertext in the real persisted vault', async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-erasure-'));
    const vaultPath = path.join(directory, 'vault.json');
    try {
      const service = new VaultEntryService(new FileVaultRepository({ vaultPath, allowBootstrap: true }));
      const key = Buffer.alloc(32, 1); // Deliberately public test-only key.
      let sequence = 0;
      state.seal.mockImplementation(async (field: string, data: string) => {
        const blob = sealSecret(data, key);
        await service.set({
          version: 1, field, cid: `fake-cid-${sequence++}`, ...blob,
          senderDid: 'did:imajin:fake-node', senderPubkey: 'fake-pubkey',
          keyId: 'fake-key', signature: 'fake-signature', timestamp: new Date().toISOString(),
        });
      });
      state.read.mockImplementation(async (field: string) => {
        const entry = await service.get(field);
        return entry && unsealSecret(entry, key);
      });
      state.erase.mockImplementation((field: string) => service.purge(field));
      state.vault.mockImplementation(() => service.loadVault());
      await state.seal('ACTIVE_SECRET', 'OBVIOUSLY_FAKE_ACTIVE_INPUT');
      const before = (await service.loadVault()).entries;
      const row = await stagedRow();
      if (mode === 'reject') {
        await discardAppSecretForProposal(terminalCard(row.id));
      } else {
        expect(await sweepExpiredAppSecretStaging(Date.now() + 24 * 60 * 60 * 1000)).toBe(1);
      }
      const reloaded = new VaultEntryService(new FileVaultRepository({ vaultPath }));
      expect((await reloaded.loadVault()).entries).toEqual(before);
      expect(await reloaded.getHistory(row.field)).toEqual([]);
      expect(await reloaded.get(row.field)).toBeUndefined();
      expect(state.remove).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
