/**
 * Unit tests for `runAppProvision` (#2375) — the apps.provision pipeline.
 * Covers: happy path, idempotent re-run, repo-exists path, the
 * legacy-first-party-row coexistence scenario (dykil), fail-closed
 * mid-step (naming the failed step, for every step), retry-resumes, and a
 * no-raw-key-leak contract test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const PRIVATE_KEY_PLAINTEXT = 'ed25519-secret-do-not-leak-1234567890abcdef';
const NODE_DID = 'did:imajin:node';
const MINTED_DID = 'did:imajin:9f2c8a1b7e6d5c4b';
const LEGACY_DYKIL_DID = 'did:imajin:app-dykil';

const {
  appProvisionsRef,
  registryAppsRef,
  appProvisionsStore,
  registryAppsStore,
  publishMock,
  emitAttestationMock,
  getNodeSigningIdentityMock,
  mintKeypairMock,
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
    mintKeypairMock: vi.fn(),
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
  mintKeypair: mintKeypairMock,
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

import { runAppProvision, getAppProvisionStatus } from '../provision';

function resetStores(): void {
  appProvisionsStore.clear();
  registryAppsStore.clear();
}

/** The pre-existing legacy first-party row 0139_registry_apps_seed_first_party.sql seeds for dykil. */
function legacyDykilRow(): Record<string, unknown> {
  return {
    id: 'app_first_party_dykil',
    slug: null,
    appDid: LEGACY_DYKIL_DID,
    publicKey: 'firstparty_placeholder_dykil_0000000000000000000000000000000000000000',
    tier: 'first_party',
    status: 'active',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();
  getNodeSigningIdentityMock.mockReturnValue({ senderDid: NODE_DID, privateKeyHex: 'x', senderPubkey: 'y' });
  ensureRepoFromTemplateMock.mockResolvedValue({ repoUrl: 'https://github.com/ima-jin/dykil', created: true });
  getMintedKeyByDidMock.mockResolvedValue(undefined);
  mintKeypairMock.mockResolvedValue({
    mintId: 'vmk_1',
    did: MINTED_DID,
    publicKey: 'freshly-minted-public-key',
    field: `vault-minted-key:${MINTED_DID}`,
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
    expect(outcome.appDid).toBe(MINTED_DID);
    expect(outcome.secretsSet).toEqual(['IMAJIN_APP_PRIVATE_KEY', 'GITHUB_PACKAGES_TOKEN']);

    expect(ensureRepoFromTemplateMock).toHaveBeenCalledWith('dykil', 'ima-jin/imajin-app-template');
    expect(mintKeypairMock).toHaveBeenCalledWith(expect.objectContaining({
      requesterDid: NODE_DID,
      mintedBy: NODE_DID,
      oneTime: false,
    }));
    expect(sealActionsSecretMock).toHaveBeenCalledWith('ima-jin/dykil', 'IMAJIN_APP_PRIVATE_KEY', PRIVATE_KEY_PLAINTEXT);
    expect(sealActionsSecretMock).toHaveBeenCalledWith('ima-jin/dykil', 'GITHUB_PACKAGES_TOKEN', 'org-credential-token');

    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('succeeded');
    expect(row?.appDid).toBe(MINTED_DID);
    expect(row?.repoUrl).toBe('https://github.com/ima-jin/dykil');
    expect(row?.repoCreated).toBe(true);

    const registryRow = [...registryAppsStore.values()][0];
    expect(registryRow?.appDid).toBe(MINTED_DID);
    expect(registryRow?.publicKey).toBe('freshly-minted-public-key');
    expect(registryRow?.tier).toBe('third_party');
    expect(registryRow?.status).toBe('active');
    expect(registryRow?.slug).toBe('dykil');

    expect(publishMock).toHaveBeenCalledWith('apps.provisioned', expect.objectContaining({
      payload: expect.objectContaining({ slug: 'dykil', appDid: MINTED_DID }),
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
      MINTED_DID,
      'dykil',
      ['dykil/survey-response', 'dykil/survey-response-legacy-import'],
    );
    const row = appProvisionsStore.get('dykil');
    expect(row?.attestationTypes).toEqual(['dykil/survey-response', 'dykil/survey-response-legacy-import']);
  });
});

describe('runAppProvision — repo-exists path (no pre-existing registry row)', () => {
  it('skips repo creation when the repo already exists, and still registers + seals', async () => {
    ensureRepoFromTemplateMock.mockResolvedValue({ repoUrl: 'https://github.com/ima-jin/dykil', created: false });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.repoUrl).toBe('https://github.com/ima-jin/dykil');

    const row = appProvisionsStore.get('dykil');
    expect(row?.repoCreated).toBe(false);
    expect(registryAppsStore.size).toBe(1);
  });
});

describe('runAppProvision — legacy first-party row coexistence (dykil, real dev state)', () => {
  it('creates a NEW third-party row for the slug and leaves the legacy first-party row completely untouched', async () => {
    // dykil is NOT provisioned at all today: only the legacy 0139 seed row
    // exists (no slug, tier: first_party), and the standalone repo already
    // exists (built/Caddy-routed manually per #2370's evidence comment).
    registryAppsStore.set('app_first_party_dykil', legacyDykilRow());
    ensureRepoFromTemplateMock.mockResolvedValue({ repoUrl: 'https://github.com/ima-jin/dykil', created: false });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.appDid).toBe(MINTED_DID);
    expect(outcome.appDid).not.toBe(LEGACY_DYKIL_DID);

    // A NEW row was created — never an update/upsert of the legacy row.
    expect(registryAppsStore.size).toBe(2);
    const legacyRow = registryAppsStore.get('app_first_party_dykil');
    expect(legacyRow).toEqual(legacyDykilRow());

    const newRow = [...registryAppsStore.values()].find((r) => r.id !== 'app_first_party_dykil');
    expect(newRow).toMatchObject({
      appDid: MINTED_DID,
      publicKey: 'freshly-minted-public-key',
      tier: 'third_party',
      status: 'active',
      slug: 'dykil',
    });
    expect(newRow?.id).not.toBe('app_first_party_dykil');
  });
});

describe('runAppProvision — idempotent re-run', () => {
  it('returns the cached result without re-creating anything for an already-succeeded slug', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
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
      appDid: MINTED_DID,
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY', 'GITHUB_PACKAGES_TOKEN'],
      attestationTypeResults: [],
    });
    expect(ensureRepoFromTemplateMock).not.toHaveBeenCalled();
    expect(mintKeypairMock).not.toHaveBeenCalled();
    expect(sealActionsSecretMock).not.toHaveBeenCalled();
  });

  it('still additively seeds newly requested attestation types on an already-succeeded slug', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
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
    expect(mintKeypairMock).not.toHaveBeenCalled();
    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('failed');
    expect(row?.failedStep).toBe('repo');
    expect(row?.appDid).toBeUndefined();
    expect(publishMock).toHaveBeenCalledWith('apps.provision.failed', expect.objectContaining({
      payload: expect.objectContaining({ slug: 'dykil', failedStep: 'repo' }),
    }));
  });

  it('names the failed step and mints nothing external when the vault mint itself fails', async () => {
    mintKeypairMock.mockRejectedValueOnce(new Error('vault sealing failed'));

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome).toEqual({ status: 'failed', failedStep: 'mint', error: 'vault sealing failed' });
    expect(registryAppsStore.size).toBe(0);
    expect(sealActionsSecretMock).not.toHaveBeenCalled();
    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('failed');
    expect(row?.failedStep).toBe('mint');
    // Mint never succeeded, so no appDid was ever persisted to the ledger.
    expect(row?.appDid).toBeUndefined();
  });

  it('names the failed step when the freshly minted key cannot be re-unsealed', async () => {
    loadAndUnsealByGranteeMock.mockResolvedValueOnce(undefined);

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('mint');
    expect(outcome.error).toContain('could not be re-unsealed');
  });

  it('names the failed step when a REUSED previously-minted key cannot be unsealed (mint retry path)', async () => {
    // A prior run already persisted an appDid (mint succeeded before a
    // later step failed), and that minted key is still active — but its
    // sealed private key can no longer be unsealed.
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
      status: 'failed',
      failedStep: 'register',
      secretsSet: [],
      attestationTypes: [],
    });
    getMintedKeyByDidMock.mockResolvedValue({
      did: MINTED_DID,
      publicKey: 'already-minted-public-key',
      field: `vault-minted-key:${MINTED_DID}`,
      status: 'active',
    });
    loadAndUnsealByGranteeMock.mockResolvedValueOnce(undefined);

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('mint');
    expect(outcome.error).toContain(`minted key for '${MINTED_DID}' exists but its sealed private key could not be unsealed`);
    expect(mintKeypairMock).not.toHaveBeenCalled();
  });

  it('names the failed step when the register insert fails (e.g. slug still claimed by an untouched legacy row)', async () => {
    class FailingInsert {
      values(): Promise<void> {
        return Promise.reject(new Error('duplicate key value violates unique constraint "uniq_registry_apps_slug"'));
      }
    }
    // Force the registryApps insert specifically to fail, without touching appProvisions
    // inserts — restored in `finally` so this override never leaks into later tests
    // (vi.clearAllMocks() in beforeEach only resets call history, not implementations).
    const { db } = await import('@/src/db');
    const originalInsert = db.insert;
    db.insert = ((table: unknown) => (
      table === registryAppsRef ? (new FailingInsert() as never) : originalInsert(table as never)
    )) as typeof db.insert;

    try {
      const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

      expect(outcome.status).toBe('failed');
      if (outcome.status !== 'failed') throw new Error('unreachable');
      expect(outcome.failedStep).toBe('register');
      expect(outcome.error).toContain('uniq_registry_apps_slug');
      expect(sealActionsSecretMock).not.toHaveBeenCalled();
    } finally {
      db.insert = originalInsert;
    }
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
    expect(row?.appDid).toBe(MINTED_DID);
  });

  it('names the failed step when seeding attestation types throws unexpectedly', async () => {
    seedAttestationTypesMock.mockRejectedValueOnce(new Error('registry unavailable'));

    const outcome = await runAppProvision({
      slug: 'dykil',
      displayName: 'dykil',
      attestationTypes: ['dykil/survey-response'],
    });

    expect(outcome).toEqual({ status: 'failed', failedStep: 'attestation-types', error: 'registry unavailable' });
    // Seal already succeeded — a retry would skip straight to re-seeding.
    const row = appProvisionsStore.get('dykil');
    expect(row?.sealedAt).toBeInstanceOf(Date);
  });

  it('retrying after a seal failure skips repo/mint/register and only retries sealing', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
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
      did: MINTED_DID,
      publicKey: 'already-minted-public-key',
      field: `vault-minted-key:${MINTED_DID}`,
      status: 'active',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    expect(ensureRepoFromTemplateMock).toHaveBeenCalledTimes(1); // idempotent GET-before-create, not a duplicate create
    expect(mintKeypairMock).not.toHaveBeenCalled(); // reused the existing minted key via the ledger's appDid
    expect(getMintedKeyByDidMock).toHaveBeenCalledWith(MINTED_DID);
    expect(sealActionsSecretMock).toHaveBeenCalledTimes(2);
  });

  it('retrying after an attestation-types failure skips repo/mint/register/seal entirely (register already-registered, seal already sealedAt)', async () => {
    // Register already inserted this run's row (matched by appDid below), and
    // seal already succeeded (sealedAt set) — only attestation-types is retried.
    registryAppsStore.set('app_existing', {
      id: 'app_existing',
      appDid: MINTED_DID,
      publicKey: 'already-minted-public-key',
      tier: 'third_party',
      status: 'active',
      slug: 'dykil',
    });
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
      repoUrl: 'https://github.com/ima-jin/dykil',
      repoCreated: true,
      registeredAt: new Date(),
      sealedAt: new Date(),
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY', 'GITHUB_PACKAGES_TOKEN'],
      attestationTypes: [],
      status: 'failed',
      failedStep: 'attestation-types',
      errorMessage: 'registry unavailable',
    });
    getMintedKeyByDidMock.mockResolvedValue({
      did: MINTED_DID,
      publicKey: 'already-minted-public-key',
      field: `vault-minted-key:${MINTED_DID}`,
      status: 'active',
    });
    seedAttestationTypesMock.mockResolvedValue([{ type: 'dykil/survey-response', ok: true }]);

    const outcome = await runAppProvision({
      slug: 'dykil',
      displayName: 'dykil',
      attestationTypes: ['dykil/survey-response'],
    });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.secretsSet).toEqual(['IMAJIN_APP_PRIVATE_KEY', 'GITHUB_PACKAGES_TOKEN']);
    expect(mintKeypairMock).not.toHaveBeenCalled();
    expect(sealActionsSecretMock).not.toHaveBeenCalled(); // sealedAt already set — never re-sealed
    expect(registryAppsStore.size).toBe(1); // register found the already-registered row — never inserted a second one
  });
});

describe('getAppProvisionStatus', () => {
  it('returns the current ledger row for a slug, and undefined when never provisioned', async () => {
    await expect(getAppProvisionStatus('never-provisioned')).resolves.toBeUndefined();

    await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    const row = await getAppProvisionStatus('dykil');
    expect(row?.status).toBe('succeeded');
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
