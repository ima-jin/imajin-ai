/**
 * Unit tests for the `local` connector's credential/grant logic (#1957).
 *
 * Mocks the vault primitives, the `channel_links` query, and
 * `checkEgressTarget` directly rather than exercising the real vault/crypto
 * stack — those are already covered by the vault package's own tests; this
 * suite is about `local/connector.ts`'s OWN branching: no-key-ok,
 * no-baseUrl-means-unresolved, bad-baseUrl-rejected, and disconnect
 * clearing everything it should.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const vaultStore = new Map<string, string>();
const grantRevokeMock = vi.fn(async () => 0);
let activeGrant = false;

vi.mock('drizzle-orm', () => ({
  and: (...parts: unknown[]) => ({ kind: 'and', parts }),
  eq: (col: unknown, value: unknown) => ({ kind: 'eq', col, value }),
}));

function selectActiveGrantRows(): Promise<{ scopes: string[] }[]> {
  return Promise.resolve(activeGrant ? [{ scopes: ['local:infer'] }] : []);
}

function returningRevokedLinks(): Promise<{ id: string }[]> {
  return Promise.resolve(activeGrant ? [{ id: 'link_1' }] : []);
}

function updateWhere() {
  return { returning: returningRevokedLinks };
}

function updateSet() {
  return { where: updateWhere };
}

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: selectActiveGrantRows }) }),
    update: () => ({ set: updateSet }),
  },
  channelLinks: {},
}));

vi.mock('@/src/lib/vault', () => ({
  sealAndStore: vi.fn(async (field: string, value: string) => {
    vaultStore.set(field, value);
  }),
  sealAndStoreV2: vi.fn(async (field: string, value: string) => {
    vaultStore.set(field, value);
    return { entry: {}, grantId: 'grant_1', requestId: null };
  }),
  loadAndUnseal: vi.fn(async (field: string) => vaultStore.get(field)),
  deleteFromVault: vi.fn(async (field: string) => {
    const had = vaultStore.has(field);
    vaultStore.delete(field);
    return had ? ({} as never) : undefined;
  }),
  vaultFieldStatus: vi.fn(async (field: string) => (vaultStore.has(field) ? 'ready' : 'absent')),
  revokeVaultDelegationGrantsForConnector: grantRevokeMock,
}));

vi.mock('@/src/lib/vault/errors', () => ({
  VaultDelegationError: class VaultDelegationError extends Error {},
}));

vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  recordConnectorRegistration: vi.fn(async () => {}),
  revokeConnectorRegistration: vi.fn(async () => {}),
}));

const checkEgressTargetMock = vi.fn();
vi.mock('@/src/lib/kernel/egress-guard', () => ({
  checkEgressTarget: (...args: unknown[]) => checkEgressTargetMock(...args),
}));

const {
  saveBaseUrl,
  readBaseUrl,
  baseUrlConfigured,
  clearBaseUrl,
  setModelId,
  sealBearerToken,
  bearerTokenSealed,
  loadLocalCredentials,
  loadLocalSealedCredentials,
  disconnect,
  LocalBaseUrlRejectedError,
} = await import('../connector');

const DID = 'did:imajin:owner';

describe('local connector', () => {
  beforeEach(() => {
    vaultStore.clear();
    activeGrant = false;
    checkEgressTargetMock.mockReset();
    grantRevokeMock.mockClear();
  });

  it('rejects an unsafe baseUrl and seals nothing', async () => {
    checkEgressTargetMock.mockResolvedValueOnce({ ok: false, reason: 'loopback', message: "'localhost' resolves to 127.0.0.1, which is denied (loopback)" });

    await expect(saveBaseUrl(DID, 'http://localhost:11434')).rejects.toBeInstanceOf(LocalBaseUrlRejectedError);
    expect(await readBaseUrl(DID)).toBeUndefined();
  });

  it('saves and pins a valid baseUrl', async () => {
    checkEgressTargetMock.mockResolvedValueOnce({ ok: true, url: new URL('http://ollama.lan:11434'), ip: '192.168.1.50', family: 4 });

    await saveBaseUrl(DID, 'http://ollama.lan:11434');

    expect(await readBaseUrl(DID)).toEqual({ baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' });
    expect(await baseUrlConfigured(DID)).toBe(true);
  });

  it('loadLocalCredentials resolves with an empty apiKey when no bearer token is sealed ("no key ok")', async () => {
    checkEgressTargetMock.mockResolvedValueOnce({ ok: true, url: new URL('http://ollama.lan:11434'), ip: '192.168.1.50', family: 4 });
    await saveBaseUrl(DID, 'http://ollama.lan:11434');
    activeGrant = true;

    const creds = await loadLocalCredentials(DID);

    expect(creds).toEqual({ apiKey: '', baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' });
  });

  it('loadLocalCredentials returns undefined when no baseUrl is configured, even with an active grant', async () => {
    activeGrant = true;
    expect(await loadLocalCredentials(DID)).toBeUndefined();
  });

  it('loadLocalCredentials returns undefined when there is no active grant, even with a baseUrl configured', async () => {
    checkEgressTargetMock.mockResolvedValueOnce({ ok: true, url: new URL('http://ollama.lan:11434'), ip: '192.168.1.50', family: 4 });
    await saveBaseUrl(DID, 'http://ollama.lan:11434');
    activeGrant = false;

    expect(await loadLocalCredentials(DID)).toBeUndefined();
  });

  it('loadLocalSealedCredentials skips the grant check (#1773 precedent) for the model picker', async () => {
    checkEgressTargetMock.mockResolvedValueOnce({ ok: true, url: new URL('http://ollama.lan:11434'), ip: '192.168.1.50', family: 4 });
    await saveBaseUrl(DID, 'http://ollama.lan:11434');
    activeGrant = false;

    const creds = await loadLocalSealedCredentials(DID);
    expect(creds).toEqual({ apiKey: '', baseUrl: 'http://ollama.lan:11434', pinnedIp: '192.168.1.50' });
  });

  it('includes a sealed bearer token and model id once both are set', async () => {
    checkEgressTargetMock.mockResolvedValueOnce({ ok: true, url: new URL('http://ollama.lan:11434'), ip: '192.168.1.50', family: 4 });
    await saveBaseUrl(DID, 'http://ollama.lan:11434');
    await sealBearerToken(DID, 'secret-token');
    await setModelId(DID, 'llama3');
    activeGrant = true;

    expect(await bearerTokenSealed(DID)).toBe(true);
    const creds = await loadLocalCredentials(DID);
    expect(creds).toEqual({
      apiKey: 'secret-token',
      baseUrl: 'http://ollama.lan:11434',
      pinnedIp: '192.168.1.50',
      modelId: 'llama3',
    });
  });

  it('clearBaseUrl removes baseUrl and the pinned IP', async () => {
    checkEgressTargetMock.mockResolvedValueOnce({ ok: true, url: new URL('http://ollama.lan:11434'), ip: '192.168.1.50', family: 4 });
    await saveBaseUrl(DID, 'http://ollama.lan:11434');

    expect(await clearBaseUrl(DID)).toBe(true);
    expect(await readBaseUrl(DID)).toBeUndefined();
  });

  it('disconnect revokes grants, channel_links, and clears settings', async () => {
    checkEgressTargetMock.mockResolvedValueOnce({ ok: true, url: new URL('http://ollama.lan:11434'), ip: '192.168.1.50', family: 4 });
    await saveBaseUrl(DID, 'http://ollama.lan:11434');
    await sealBearerToken(DID, 'secret-token');
    activeGrant = true;

    const revoked = await disconnect(DID);

    expect(revoked).toBe(true);
    expect(grantRevokeMock).toHaveBeenCalledWith('local', DID);
    expect(await readBaseUrl(DID)).toBeUndefined();
  });

  it('disconnect is a safe no-op (returns false) when nothing was ever configured', async () => {
    expect(await disconnect(DID)).toBe(false);
  });
});
