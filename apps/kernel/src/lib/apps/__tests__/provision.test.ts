/**
 * Unit tests for `runAppProvision` (#2375) — the apps.provision pipeline.
 * Covers: happy path, idempotent re-run, repo-exists path, fail-closed
 * mid-step (naming the failed step), and a no-raw-key-leak contract test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PRIVATE_KEY_PLAINTEXT = 'ed25519-secret-do-not-leak-1234567890abcdef';
const NODE_DID = 'did:imajin:node';

const {
  appProvisionsRef,
  registryAppsRef,
  appProvisionsStore,
  registryAppsStore,
  publishMock,
  emitAttestationMock,
  getNodeSigningIdentityMock,
  mintKeypairForDidMock,
  emitMintedEventsMock,
  getMintedKeyByDidMock,
  loadAndUnsealByGranteeMock,
  ensureRepoFromTemplateMock,
  sealActionsSecretMock,
  loadOrgCredentialMock,
  seedAttestationTypesMock,
  logMock,
} = vi.hoisted(() => {
  return {
    appProvisionsRef: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? prop : undefined) }) as Record<string, unknown>,
    registryAppsRef: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? prop : undefined) }) as Record<string, unknown>,
    appProvisionsStore: new Map<string, Record<string, unknown>>(),
    registryAppsStore: new Map<string, Record<string, unknown>>(),
    publishMock: vi.fn().mockResolvedValue(undefined),
    emitAttestationMock: vi.fn().mockResolvedValue({}),
    getNodeSigningIdentityMock: vi.fn(),
    mintKeypairForDidMock: vi.fn(),
    emitMintedEventsMock: vi.fn(),
    getMintedKeyByDidMock: vi.fn(),
    loadAndUnsealByGranteeMock: vi.fn(),
    ensureRepoFromTemplateMock: vi.fn(),
    sealActionsSecretMock: vi.fn().mockResolvedValue(undefined),
    loadOrgCredentialMock: vi.fn().mockResolvedValue('org-credential-token'),
    seedAttestationTypesMock: vi.fn().mockResolvedValue([]),
    logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@imajin/logger', () => ({ createLogger: () => logMock }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));
vi.mock('@imajin/auth', () => ({ emitAttestation: emitAttestationMock }));
vi.mock('nanoid', () => ({ nanoid: () => 'testnanoid1234567' }));

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: unknown) => ({ col, val }),
}));

function storeFor(table: unknown) {
  return table === appProvisionsRef ? appProvisionsStore : registryAppsStore;
}

function projectRow(row: Record<string, unknown>, projection: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(projection)) out[key] = row[key];
  return out;
}

interface FakeCond { col: string; val: unknown }

class FakeSelectChain {
  private table: unknown;
  private cond: FakeCond | undefined;
  constructor(private readonly projection?: Record<string, unknown>) {}
  from(table: unknown): this {
    this.table = table;
    return this;
  }
  where(cond: FakeCond): this {
    this.cond = cond;
    return this;
  }
  limit(n: number): Promise<Record<string, unknown>[]> {
    let rows = [...storeFor(this.table).values()];
    if (this.cond) rows = rows.filter((r) => r[this.cond!.col] === this.cond!.val);
    rows = rows.slice(0, n);
    if (this.projection) rows = rows.map((r) => projectRow(r, this.projection!));
    return Promise.resolve(rows);
  }
}

class FakeUpdateChain {
  private patch: Record<string, unknown> = {};
  constructor(private readonly table: unknown) {}
  set(patch: Record<string, unknown>): this {
    this.patch = patch;
    return this;
  }
  where(cond: FakeCond): Promise<void> {
    for (const row of storeFor(this.table).values()) {
      if (row[cond.col] === cond.val) Object.assign(row, this.patch);
    }
    return Promise.resolve();
  }
}

class FakeInsertChain {
  constructor(private readonly table: unknown) {}
  values(row: Record<string, unknown>): Promise<void> {
    if (this.table === appProvisionsRef) {
      appProvisionsStore.set(row.slug as string, { status: 'pending', secretsSet: [], attestationTypes: [], ...row });
    } else {
      registryAppsStore.set(row.id as string, row);
    }
    return Promise.resolve();
  }
}

vi.mock('@/src/db', () => ({
  appProvisions: appProvisionsRef,
  registryApps: registryAppsRef,
  db: {
    select: (projection?: Record<string, unknown>) => new FakeSelectChain(projection),
    update: (table: unknown) => new FakeUpdateChain(table),
    insert: (table: unknown) => new FakeInsertChain(table),
  },
}));

vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: getNodeSigningIdentityMock,
}));
vi.mock('@/src/lib/vault/mint', () => ({
  mintKeypairForDid: mintKeypairForDidMock,
  emitMintedEvents: emitMintedEventsMock,
}));
vi.mock('@/src/lib/vault/key-cards', () => ({
  getMintedKeyByDid: getMintedKeyByDidMock,
}));
vi.mock('@/src/lib/vault', () => ({
  loadAndUnsealByGrantee: loadAndUnsealByGranteeMock,
}));
vi.mock('@/src/lib/github/org-provisioning', () => ({
  ensureRepoFromTemplate: ensureRepoFromTemplateMock,
  sealActionsSecret: sealActionsSecretMock,
  loadOrgCredential: loadOrgCredentialMock,
  PROVISIONING_ORG: 'ima-jin',
  DEFAULT_APP_TEMPLATE: 'ima-jin/imajin-app-template',
}));
vi.mock('../attestation-types', () => ({
  seedAttestationTypes: seedAttestationTypesMock,
}));

import { runAppProvision, appDidForSlug } from '../provision';

function resetStores(): void {
  appProvisionsStore.clear();
  registryAppsStore.clear();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();
  getNodeSigningIdentityMock.mockReturnValue({ senderDid: NODE_DID, privateKeyHex: 'x', senderPubkey: 'y' });
  ensureRepoFromTemplateMock.mockResolvedValue({ repoUrl: 'https://github.com/ima-jin/dykil', created: true });
  getMintedKeyByDidMock.mockResolvedValue(undefined);
  mintKeypairForDidMock.mockResolvedValue({
    mintId: 'vmk_1',
    did: appDidForSlug('dykil'),
    publicKey: 'freshly-minted-public-key',
    field: 'vault-minted-key:did:imajin:app-dykil',
    grantId: 'vdg_1',
    requestId: null,
  });
  loadAndUnsealByGranteeMock.mockResolvedValue(PRIVATE_KEY_PLAINTEXT);
  loadOrgCredentialMock.mockResolvedValue('org-credential-token');
  seedAttestationTypesMock.mockResolvedValue([]);
});

describe('runAppProvision — happy path', () => {
  it('runs repo -> mint -> register -> seal and returns a succeeded outcome', async () => {
    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.repoUrl).toBe('https://github.com/ima-jin/dykil');
    expect(outcome.appDid).toBe('did:imajin:app-dykil');
    expect(outcome.secretsSet).toEqual(['IMAJIN_APP_PRIVATE_KEY', 'GITHUB_PACKAGES_TOKEN']);

    expect(ensureRepoFromTemplateMock).toHaveBeenCalledWith('dykil', 'ima-jin/imajin-app-template');
    expect(mintKeypairForDidMock).toHaveBeenCalledWith('did:imajin:app-dykil', expect.objectContaining({
      requesterDid: NODE_DID,
      mintedBy: NODE_DID,
      oneTime: false,
    }));
    expect(sealActionsSecretMock).toHaveBeenCalledWith('ima-jin/dykil', 'IMAJIN_APP_PRIVATE_KEY', PRIVATE_KEY_PLAINTEXT);
    expect(sealActionsSecretMock).toHaveBeenCalledWith('ima-jin/dykil', 'GITHUB_PACKAGES_TOKEN', 'org-credential-token');

    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('succeeded');
    expect(row?.repoUrl).toBe('https://github.com/ima-jin/dykil');
    expect(row?.repoCreated).toBe(true);

    const registryRow = [...registryAppsStore.values()][0];
    expect(registryRow?.appDid).toBe('did:imajin:app-dykil');
    expect(registryRow?.publicKey).toBe('freshly-minted-public-key');
    expect(registryRow?.tier).toBe('first_party');
    expect(registryRow?.status).toBe('active');

    expect(publishMock).toHaveBeenCalledWith('apps.provisioned', expect.objectContaining({
      payload: expect.objectContaining({ slug: 'dykil', appDid: 'did:imajin:app-dykil' }),
    }));
  });

  it('seeds attestation types when requested', async () => {
    seedAttestationTypesMock.mockResolvedValue([
      { type: 'dykil/survey-response', ok: true },
      { type: 'dykil/survey-response-legacy-import', ok: true },
    ]);

    const outcome = await runAppProvision({
      slug: 'dykil',
      displayName: 'dykil',
      attestationTypes: ['dykil/survey-response', 'dykil/survey-response-legacy-import'],
    });

    expect(outcome.status).toBe('succeeded');
    expect(seedAttestationTypesMock).toHaveBeenCalledWith(
      'did:imajin:app-dykil',
      'dykil',
      ['dykil/survey-response', 'dykil/survey-response-legacy-import'],
    );
    const row = appProvisionsStore.get('dykil');
    expect(row?.attestationTypes).toEqual(['dykil/survey-response', 'dykil/survey-response-legacy-import']);
  });
});

describe('runAppProvision — repo-exists path (dykil-style)', () => {
  it('skips repo creation when the repo already exists, and still registers + seals', async () => {
    ensureRepoFromTemplateMock.mockResolvedValue({ repoUrl: 'https://github.com/ima-jin/dykil', created: false });
    // A placeholder registry row already exists for this slug (0139 seed).
    registryAppsStore.set('app_first_party_dykil', {
      id: 'app_first_party_dykil',
      slug: 'dykil',
      appDid: 'did:imajin:app-dykil',
      publicKey: 'firstparty_placeholder_dykil_0000',
      tier: 'first_party',
      status: 'active',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.repoUrl).toBe('https://github.com/ima-jin/dykil');

    const row = appProvisionsStore.get('dykil');
    expect(row?.repoCreated).toBe(false);

    // Register step UPDATES the existing placeholder row rather than inserting a second one.
    expect(registryAppsStore.size).toBe(1);
    const registryRow = registryAppsStore.get('app_first_party_dykil');
    expect(registryRow?.publicKey).toBe('freshly-minted-public-key');
    expect(registryRow?.appDid).toBe('did:imajin:app-dykil');
  });
});

describe('runAppProvision — idempotent re-run', () => {
  it('returns the cached result without re-creating anything for an already-succeeded slug', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: 'did:imajin:app-dykil',
      repoUrl: 'https://github.com/ima-jin/dykil',
      repoCreated: false,
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY', 'GITHUB_PACKAGES_TOKEN'],
      attestationTypes: [],
      status: 'succeeded',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome).toEqual({
      status: 'succeeded',
      repoUrl: 'https://github.com/ima-jin/dykil',
      appDid: 'did:imajin:app-dykil',
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY', 'GITHUB_PACKAGES_TOKEN'],
      attestationTypeResults: [],
    });
    expect(ensureRepoFromTemplateMock).not.toHaveBeenCalled();
    expect(mintKeypairForDidMock).not.toHaveBeenCalled();
    expect(sealActionsSecretMock).not.toHaveBeenCalled();
  });

  it('still additively seeds newly requested attestation types on an already-succeeded slug', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: 'did:imajin:app-dykil',
      repoUrl: 'https://github.com/ima-jin/dykil',
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY', 'GITHUB_PACKAGES_TOKEN'],
      attestationTypes: ['dykil/survey-response'],
      status: 'succeeded',
    });
    seedAttestationTypesMock.mockResolvedValue([{ type: 'dykil/survey-response-legacy-import', ok: true }]);

    const outcome = await runAppProvision({
      slug: 'dykil',
      displayName: 'dykil',
      attestationTypes: ['dykil/survey-response-legacy-import'],
    });

    expect(outcome.status).toBe('succeeded');
    expect(ensureRepoFromTemplateMock).not.toHaveBeenCalled();
    expect(sealActionsSecretMock).not.toHaveBeenCalled();
    const row = appProvisionsStore.get('dykil');
    expect(row?.attestationTypes).toEqual(expect.arrayContaining(['dykil/survey-response', 'dykil/survey-response-legacy-import']));
  });
});

describe('runAppProvision — fail-closed mid-step', () => {
  it('names the failed step and leaves the run failed when repo creation fails', async () => {
    ensureRepoFromTemplateMock.mockRejectedValue(new Error('GitHub rate limited'));

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome).toEqual({ status: 'failed', failedStep: 'repo', error: 'GitHub rate limited' });
    expect(mintKeypairForDidMock).not.toHaveBeenCalled();
    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('failed');
    expect(row?.failedStep).toBe('repo');
    expect(publishMock).toHaveBeenCalledWith('apps.provision.failed', expect.objectContaining({
      payload: expect.objectContaining({ slug: 'dykil', failedStep: 'repo' }),
    }));
  });

  it('names the failed step when sealing the Actions secret fails, after repo/mint/register already succeeded', async () => {
    sealActionsSecretMock.mockRejectedValueOnce(new Error('GitHub 403'));

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome).toEqual({ status: 'failed', failedStep: 'seal', error: 'GitHub 403' });
    // No half-registered app: the registry row WAS written (real keypair, vault-sealed)
    // before the external seal step failed — this is intentional, see provision.ts's docblock.
    expect(registryAppsStore.size).toBe(1);
    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('failed');
    expect(row?.failedStep).toBe('seal');
    expect(row?.registeredAt).toBeInstanceOf(Date);
  });

  it('retrying after a seal failure skips repo/mint/register and only retries sealing', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: 'did:imajin:app-dykil',
      repoUrl: 'https://github.com/ima-jin/dykil',
      repoCreated: true,
      registeredAt: new Date(),
      secretsSet: [],
      attestationTypes: [],
      status: 'failed',
      failedStep: 'seal',
      errorMessage: 'GitHub 403',
    });
    getMintedKeyByDidMock.mockResolvedValue({
      did: 'did:imajin:app-dykil',
      publicKey: 'already-minted-public-key',
      field: 'vault-minted-key:did:imajin:app-dykil',
      status: 'active',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    expect(ensureRepoFromTemplateMock).toHaveBeenCalledTimes(1); // idempotent GET-before-create, not a duplicate create
    expect(mintKeypairForDidMock).not.toHaveBeenCalled(); // reused the existing minted key
    expect(sealActionsSecretMock).toHaveBeenCalledTimes(2);
  });
});

describe('runAppProvision — no raw key leak', () => {
  it('never returns, logs, or persists the plaintext private key', async () => {
    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(JSON.stringify(outcome)).not.toContain(PRIVATE_KEY_PLAINTEXT);

    const allLogCalls = [...logMock.info.mock.calls, ...logMock.warn.mock.calls, ...logMock.error.mock.calls];
    for (const call of allLogCalls) {
      expect(JSON.stringify(call)).not.toContain(PRIVATE_KEY_PLAINTEXT);
    }

    for (const call of publishMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(PRIVATE_KEY_PLAINTEXT);
    }
    for (const call of emitAttestationMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(PRIVATE_KEY_PLAINTEXT);
    }

    for (const row of appProvisionsStore.values()) {
      expect(JSON.stringify(row)).not.toContain(PRIVATE_KEY_PLAINTEXT);
    }
    for (const row of registryAppsStore.values()) {
      expect(JSON.stringify(row)).not.toContain(PRIVATE_KEY_PLAINTEXT);
    }

    // The private key is only ever handed directly to sealActionsSecret's own
    // argument (asserted separately in the happy-path test) — never anywhere else.
    expect(sealActionsSecretMock).toHaveBeenCalledWith(expect.any(String), 'IMAJIN_APP_PRIVATE_KEY', PRIVATE_KEY_PLAINTEXT);
  });
});
