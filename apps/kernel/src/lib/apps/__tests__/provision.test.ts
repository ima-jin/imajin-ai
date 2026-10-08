/**
 * Unit tests for `runAppProvision` (#2375) — the apps.provision pipeline.
 * Covers: happy path, idempotent re-run, repo-exists path, the
 * legacy-first-party-row coexistence scenario (dykil), fail-closed
 * mid-step (naming the failed step, for every step), retry-resumes, a
 * no-raw-key-leak contract test, and (#2437) proof that provisioning never
 * writes the app key to GitHub Actions secrets — the real org-provisioning
 * module runs against a faked `fetch`, so any PUT would be observed.
 */
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PRIVATE_KEY_PLAINTEXT = 'ed25519-secret-do-not-leak-1234567890abcdef';
const NODE_DID = 'did:imajin:node';
const MINTED_DID = 'did:imajin:9f2c8a1b7e6d5c4b';
const LEGACY_DYKIL_DID = 'did:imajin:app-dykil';

const {
  appProvisionsRef,
  registryAppsRef,
  vaultDelegationGrantsRef,
  appProvisionsStore,
  registryAppsStore,
  vaultDelegationGrantsStore,
  publishMock,
  emitAttestationMock,
  getNodeSigningIdentityMock,
  mintKeypairMock,
  emitMintedEventsMock,
  mintedKeyFieldMock,
  grantExistingMintedKeyMock,
  emitGrantEventsMock,
  getMintedKeyByDidMock,
  loadAndUnsealByGranteeMock,
  issueSigningKeyClaimMock,
  ensureRepoFromTemplateMock,
  tryGetInstallationTokenMock,
  fetchAppManifestMock,
  loadAndUnsealMock,
  seedAttestationTypesMock,
  logMock,
} = vi.hoisted(() => {
  return {
    appProvisionsRef: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? prop : undefined) }) as Record<string, unknown>,
    registryAppsRef: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? prop : undefined) }) as Record<string, unknown>,
    vaultDelegationGrantsRef: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? prop : undefined) }) as Record<string, unknown>,
    appProvisionsStore: new Map<string, Record<string, unknown>>(),
    registryAppsStore: new Map<string, Record<string, unknown>>(),
    vaultDelegationGrantsStore: new Map<string, Record<string, unknown>>(),
    publishMock: vi.fn().mockResolvedValue(undefined),
    emitAttestationMock: vi.fn().mockResolvedValue({}),
    getNodeSigningIdentityMock: vi.fn(),
    mintKeypairMock: vi.fn(),
    emitMintedEventsMock: vi.fn(),
    mintedKeyFieldMock: vi.fn((did: string) => `vault-minted-key:${did}`),
    grantExistingMintedKeyMock: vi.fn(),
    emitGrantEventsMock: vi.fn(),
    getMintedKeyByDidMock: vi.fn(),
    loadAndUnsealByGranteeMock: vi.fn(),
    issueSigningKeyClaimMock: vi.fn(),
    ensureRepoFromTemplateMock: vi.fn(),
    tryGetInstallationTokenMock: vi.fn().mockResolvedValue('installation-token'),
    fetchAppManifestMock: vi.fn().mockResolvedValue(null),
    loadAndUnsealMock: vi.fn(),
    seedAttestationTypesMock: vi.fn().mockResolvedValue([]),
    logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

// #2663: the registry/auth-backed validator is covered by app-declarations.test.ts;
// here it passes manifest declarations through unless a test overrides it.
const { validateAppDeclarationsMock } = vi.hoisted(() => ({ validateAppDeclarationsMock: vi.fn() }));
vi.mock('@/src/lib/kernel/app-declarations', () => ({ validateAppDeclarations: validateAppDeclarationsMock }));

vi.mock('@imajin/logger', () => ({ createLogger: () => logMock }));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));
vi.mock('@imajin/auth', async () => ({
  emitAttestation: emitAttestationMock,
  // The real helper, not a copy — a duplicated regex here would hide drift from the provision pattern.
  isAppAudienceSlug: (await import('../../../../../../packages/auth/src/app-audience')).isAppAudienceSlug,
}));
vi.mock('nanoid', () => ({ nanoid: () => 'testnanoid1234567' }));

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: unknown) => ({ col, val }),
  and: (...conds: FakeCond[]) => conds,
}));

function storeFor(table: unknown) {
  if (table === appProvisionsRef) return appProvisionsStore;
  if (table === vaultDelegationGrantsRef) return vaultDelegationGrantsStore;
  return registryAppsStore;
}

function projectRow(row: Record<string, unknown>, projection: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(projection)) out[key] = row[key];
  return out;
}

interface FakeCond { col: string; val: unknown }
type FakeWhere = FakeCond | FakeCond[];

function matchesWhere(row: Record<string, unknown>, where: FakeWhere | undefined): boolean {
  if (!where) return true;
  const conds = Array.isArray(where) ? where : [where];
  return conds.every((cond) => row[cond.col] === cond.val);
}

class FakeSelectChain {
  private table: unknown;
  private cond: FakeWhere | undefined;
  constructor(private readonly projection?: Record<string, unknown>) {}
  from(table: unknown): this {
    this.table = table;
    return this;
  }
  where(cond: FakeWhere): this {
    this.cond = cond;
    return this;
  }
  limit(n: number): Promise<Record<string, unknown>[]> {
    let rows = [...storeFor(this.table).values()].filter((r) => matchesWhere(r, this.cond));
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
  vaultDelegationGrants: vaultDelegationGrantsRef,
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
  mintedKeyField: mintedKeyFieldMock,
}));
vi.mock('@/src/lib/vault/key-cards', () => ({
  getMintedKeyByDid: getMintedKeyByDidMock,
}));
vi.mock('@/src/lib/vault', () => ({
  // `loadAndUnseal` is only reached by the REAL org-provisioning module, which the
  // #2436 stale-PAT and #2437 no-Actions-secrets describe blocks delegate to; every
  // other test mocks that module.
  loadAndUnseal: loadAndUnsealMock,
  // #2437: provision.ts must never unseal the app key — this spy exists so a test can prove it.
  loadAndUnsealByGrantee: loadAndUnsealByGranteeMock,
  grantExistingMintedKey: grantExistingMintedKeyMock,
  emitGrantEvents: emitGrantEventsMock,
}));
vi.mock('@/src/lib/github/org-provisioning', () => ({
  ensureRepoFromTemplate: ensureRepoFromTemplateMock,
  tryGetInstallationToken: tryGetInstallationTokenMock,
  fetchAppManifest: fetchAppManifestMock,
  PROVISIONING_ORG: 'ima-jin',
  DEFAULT_APP_TEMPLATE: 'ima-jin/imajin-app-template',
}));
vi.mock('../attestation-types', () => ({
  seedAttestationTypes: seedAttestationTypesMock,
}));
vi.mock('../signing-key-claims', () => ({
  APP_SIGNING_KEY_PURPOSE: 'app-signing-key',
  issueSigningKeyClaim: issueSigningKeyClaimMock,
}));

import { runAppProvision, getAppProvisionStatus } from '../provision';
import { isAppAudienceSlug } from '@imajin/auth';
import { SLUG_PATTERN as PROVISION_SLUG_PATTERN } from '@/app/jin/provision-app-validation';

const CLAIM_CODE = 'claim_test_code_0000000000000000';
const APP_SELF_GRANT_ID = 'vdg_appself_1';

function resetStores(): void {
  appProvisionsStore.clear();
  registryAppsStore.clear();
  vaultDelegationGrantsStore.clear();
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
  tryGetInstallationTokenMock.mockResolvedValue('installation-token');
  fetchAppManifestMock.mockResolvedValue(null);
  seedAttestationTypesMock.mockResolvedValue([]);
  grantExistingMintedKeyMock.mockResolvedValue({ status: 'ok', grantId: APP_SELF_GRANT_ID });
  issueSigningKeyClaimMock.mockResolvedValue(CLAIM_CODE);
  validateAppDeclarationsMock.mockImplementation(async (input: { providesScopes?: string[]; dependsOn?: unknown[] }) => ({
    ok: { providesScopes: input.providesScopes ?? [], dependsOn: input.dependsOn ?? [], requestedScopes: [] },
  }));
});

describe('runAppProvision — #2663 scope declarations: exactly what the operator approved', () => {
  const declared = {
    providesScopes: ['dykil:read', 'dykil:write'],
    dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }],
    emittableEvents: ['tip.granted', 'tip.sent'],
  };

  it('registers the manifest declarations when they match the approved list, validated against the slug', async () => {
    fetchAppManifestMock.mockResolvedValue(declared);

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil', approvedDeclarations: declared });

    expect(outcome.status).toBe('succeeded');
    expect(validateAppDeclarationsMock).toHaveBeenCalledWith(expect.objectContaining({ slug: 'dykil' }));
    // #2674: requested_scopes records the WHOLE approved list — the app's own scopes plus the
    // approved dependency scopes — so it can serve as the ceiling mint and PATCH hold the app to.
    expect([...registryAppsStore.values()][0]).toMatchObject({
      providesScopes: ['dykil:read', 'dykil:write'],
      requestedScopes: ['dykil:read', 'dykil:write', 'media:read'],
      dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }],
      emittableEvents: ['tip.granted', 'tip.sent'],
    });
  });

  it('records no scope beyond the approved list in requested_scopes (#2674)', async () => {
    const approved = {
      providesScopes: ['dykil:read'],
      dependsOn: [
        { aud: 'jin.imajin.ai', scopes: ['media:read'] },
        { aud: 'events.imajin.ai', scopes: ['media:read', 'events:read'] },
      ],
    };
    fetchAppManifestMock.mockResolvedValue(approved);

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil', approvedDeclarations: approved });

    expect(outcome.status).toBe('succeeded');
    // de-duplicated: media:read is listed under two dependencies but recorded once
    expect([...registryAppsStore.values()][0]?.requestedScopes).toEqual(['dykil:read', 'media:read', 'events:read']);
  });

  it('treats a reordered but identical list as the same list', async () => {
    fetchAppManifestMock.mockResolvedValue({
      providesScopes: ['dykil:write', 'dykil:read'],
      dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }],
      emittableEvents: ['tip.sent', 'tip.granted'],
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil', approvedDeclarations: declared });

    expect(outcome.status).toBe('succeeded');
  });

  it('registers empty declarations when the manifest has none and none were approved', async () => {
    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil', approvedDeclarations: null });

    expect(outcome.status).toBe('succeeded');
    expect([...registryAppsStore.values()][0]).toMatchObject({ providesScopes: [], dependsOn: [], emittableEvents: [] });
  });

  it.each([
    ['an extra dependency scope (media:write the operator never saw)', { ...declared, dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] }] }],
    ['an extra dependency audience', { ...declared, dependsOn: [...declared.dependsOn, { aud: 'events.imajin.ai', scopes: ['events:read'] }] }],
    ['an extra providesScope', { ...declared, providesScopes: [...declared.providesScopes, 'dykil:admin'] }],
    ['a missing providesScope', { ...declared, providesScopes: ['dykil:read'] }],
    ['an extra emittable event (listing.purchased the operator never saw)', { ...declared, emittableEvents: [...declared.emittableEvents, 'listing.purchased'] }],
    ['a missing emittable event', { ...declared, emittableEvents: ['tip.granted'] }],
  ])('fails closed at register, writing no row, when the manifest now declares %s', async (_label, drifted) => {
    fetchAppManifestMock.mockResolvedValue(drifted);

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil', approvedDeclarations: declared });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('register');
    expect(outcome.error).toContain('differ from the list the operator approved');
    expect(registryAppsStore.size).toBe(0);
  });

  it.each([
    ['null (no manifest was readable at proposal time)', null],
    ['omitted', undefined],
  ])('approves nothing when the approved list is %s: a manifest that declares anything fails closed', async (_label, approved) => {
    fetchAppManifestMock.mockResolvedValue(declared);

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil', approvedDeclarations: approved });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('register');
    expect(registryAppsStore.size).toBe(0);
  });

  it('#2638: a manifest that asks to emit events when none were approved fails closed, writing no row', async () => {
    fetchAppManifestMock.mockResolvedValue({ emittableEvents: ['tip.granted'] });

    const outcome = await runAppProvision({ slug: 'coffee', displayName: 'coffee', approvedDeclarations: null });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('register');
    expect(outcome.error).toContain('differ from the list the operator approved');
    expect(registryAppsStore.size).toBe(0);
  });

  it.each([
    ['a wildcard', ['tip.*']],
    ['an uppercase type', ['Tip.Granted']],
    ['a non-string entry', [42]],
  ])('#2638: rejects a manifest whose emittableEvents has %s, writing no row', async (_label, emittableEvents) => {
    fetchAppManifestMock.mockResolvedValue({ emittableEvents });

    const outcome = await runAppProvision({ slug: 'coffee', displayName: 'coffee', approvedDeclarations: null });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('register');
    expect(outcome.error).toContain('emittableEvents');
    expect(registryAppsStore.size).toBe(0);
  });

  it('fails closed at the register step, writing no row, when the declarations are rejected as invalid', async () => {
    fetchAppManifestMock.mockResolvedValue({ providesScopes: ['media:write'] });
    validateAppDeclarationsMock.mockResolvedValue({ error: 'providesScopes rejected: media:write' });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil', approvedDeclarations: null });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('register');
    expect(outcome.error).toContain('providesScopes rejected: media:write');
    expect(registryAppsStore.size).toBe(0);
  });
});

describe('runAppProvision — happy path', () => {
  it('runs repo -> mint -> register -> grant and returns a succeeded outcome (#2437: no Actions secrets)', async () => {
    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.repoUrl).toBe('https://github.com/ima-jin/dykil');
    expect(outcome.appDid).toBe(MINTED_DID);
    expect(outcome.secretsSet).toEqual([]);

    expect(ensureRepoFromTemplateMock).toHaveBeenCalledWith('dykil', 'ima-jin/imajin-app-template');
    expect(mintKeypairMock).toHaveBeenCalledWith(expect.objectContaining({
      requesterDid: NODE_DID,
      mintedBy: NODE_DID,
      oneTime: false,
    }));
    // #2437: the minted private key stays in the vault — provisioning never even unseals it.
    expect(loadAndUnsealByGranteeMock).not.toHaveBeenCalled();

    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('succeeded');
    expect(row?.appDid).toBe(MINTED_DID);
    expect(row?.repoUrl).toBe('https://github.com/ima-jin/dykil');
    expect(row?.repoCreated).toBe(true);
    expect(row?.secretsSet).toEqual([]);
    expect(row?.sealedAt).toBeUndefined();

    const registryRow = [...registryAppsStore.values()][0];
    expect(registryRow?.appDid).toBe(MINTED_DID);
    expect(registryRow?.publicKey).toBe('freshly-minted-public-key');
    expect(registryRow?.tier).toBe('third_party');
    expect(registryRow?.status).toBe('active');
    expect(registryRow?.slug).toBe('dykil');
    // #2706: the audience apps.provision registers is the slug — never a host — so a Bearer
    // token minted for it verifies at the app with no post-provision registry edit.
    expect(registryRow?.tokenAudiences).toEqual(['dykil']);
    expect(isAppAudienceSlug((registryRow?.tokenAudiences as string[])[0])).toBe(true);
    // #2425: no manifest present (fetchAppManifestMock defaults to null) — falls back to defaults.
    expect(registryRow?.icon).toBeNull();
    expect(registryRow?.entryUrl).toBe('/dykil');
    expect(registryRow?.placements).toEqual(['auth-submenu']);
    expect(registryRow?.requiredScope).toBeNull();

    expect(publishMock).toHaveBeenCalledWith('apps.provisioned', expect.objectContaining({
      payload: expect.objectContaining({ slug: 'dykil', appDid: MINTED_DID, secretsSet: [] }),
    }));
    expect(outcome.claimCode).toBe(CLAIM_CODE);
  });

  it('grants the app its own app-signing-key delegation and issues a claim code', async () => {
    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.claimCode).toBe(CLAIM_CODE);

    expect(grantExistingMintedKeyMock).toHaveBeenCalledWith({
      did: MINTED_DID,
      grantedTo: MINTED_DID,
      purpose: 'app-signing-key',
      oneTime: false,
      grantedBy: NODE_DID,
    });
    expect(emitGrantEventsMock).toHaveBeenCalledWith({
      grantId: APP_SELF_GRANT_ID,
      did: MINTED_DID,
      field: `vault-minted-key:${MINTED_DID}`,
      grantedTo: MINTED_DID,
      grantedBy: NODE_DID,
    });
    expect(issueSigningKeyClaimMock).toHaveBeenCalledWith({
      nodeDid: NODE_DID,
      slug: 'dykil',
      appDid: MINTED_DID,
      grantId: APP_SELF_GRANT_ID,
    });
  });

  it('reuses an already-active app-signing-key grant instead of issuing a duplicate one', async () => {
    vaultDelegationGrantsStore.set('vdg_existing', {
      id: 'vdg_existing',
      subject: MINTED_DID,
      grantedTo: MINTED_DID,
      field: `vault-minted-key:${MINTED_DID}`,
      purpose: 'app-signing-key',
      status: 'active',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    expect(grantExistingMintedKeyMock).not.toHaveBeenCalled();
    expect(issueSigningKeyClaimMock).toHaveBeenCalledWith(expect.objectContaining({ grantId: 'vdg_existing' }));
  });

  it('names the failed step when the app-signing-key grant cannot be issued', async () => {
    grantExistingMintedKeyMock.mockResolvedValueOnce({ status: 'no_reusable_grant' });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('app-signing-key-grant');
    expect(issueSigningKeyClaimMock).not.toHaveBeenCalled();
  });

  it('#2425: writes nav metadata from the app manifest when present and valid', async () => {
    fetchAppManifestMock.mockResolvedValue({
      name: 'Dykil (from manifest)',
      icon: '\ud83d\udccb',
      entryUrl: '/dykil',
      placements: ['launcher', 'home', 'auth-submenu'],
      requiredScope: 'creator',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    expect(fetchAppManifestMock).toHaveBeenCalledWith('dykil', 'installation-token');
    const registryRow = [...registryAppsStore.values()][0];
    expect(registryRow).toMatchObject({
      name: 'Dykil (from manifest)',
      icon: '\ud83d\udccb',
      entryUrl: '/dykil',
      placements: ['launcher', 'home', 'auth-submenu'],
      requiredScope: 'creator',
    });
  });

  it.each([
    ['relative path', '/dykil/home'],
    ['https URL', 'https://dykil.example.com/app'],
  ])('#2434: accepts a manifest entryUrl that is a %s', async (_label, entryUrl) => {
    fetchAppManifestMock.mockResolvedValue({ entryUrl });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    expect([...registryAppsStore.values()][0]?.entryUrl).toBe(entryUrl);
  });

  it.each([
    ['http URL', 'http://dykil.example.com/app'],
    ['javascript: URL', 'javascript:alert(1)'],
    ['protocol-relative URL', '//evil.example.com/app'],
  ])('#2434: rejects a manifest entryUrl that is a %s, failing closed at the register step', async (_label, entryUrl) => {
    fetchAppManifestMock.mockResolvedValue({ entryUrl });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('register');
    expect(outcome.error).toContain('Invalid manifest entryUrl');
    // Fail-closed: no registry row is ever written for a rejected entryUrl.
    expect(registryAppsStore.size).toBe(0);
  });

  it('#2425: falls back to defaults when the manifest read returns null (unsealed credential, missing file, etc.)', async () => {
    fetchAppManifestMock.mockResolvedValue(null);

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'My Dykil' });

    expect(outcome.status).toBe('succeeded');
    const registryRow = [...registryAppsStore.values()][0];
    expect(registryRow).toMatchObject({
      name: 'My Dykil',
      icon: null,
      entryUrl: '/dykil',
      placements: ['auth-submenu'],
      requiredScope: null,
    });
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
  it('skips repo creation when the repo already exists, and still registers', async () => {
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

describe('runAppProvision — #2415 an unsealed org credential still reaches the claim code', () => {
  it('existing-repo + unsealed credential: reaches the claim code, secretsSet is empty, and no seal event is emitted', async () => {
    ensureRepoFromTemplateMock.mockResolvedValue({ repoUrl: 'https://github.com/ima-jin/dykil', created: false });
    tryGetInstallationTokenMock.mockResolvedValue(null);

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.secretsSet).toEqual([]);
    expect(outcome).not.toHaveProperty('sealSkipped');
    expect(outcome.claimCode).toBe(CLAIM_CODE);

    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('succeeded');
    expect(row?.sealedAt).toBeUndefined();
    expect(row?.secretsSet).toEqual([]);

    const eventNames = publishMock.mock.calls.map((call) => call[0]);
    expect(eventNames).toContain('apps.provisioned');
    expect(eventNames.some((name) => String(name).includes('seal'))).toBe(false);
  });

  it('missing-repo + unsealed credential: fails at \'repo\' with the out-of-band create message, before mint/register ever run', async () => {
    ensureRepoFromTemplateMock.mockRejectedValue(new Error(
      "ima-jin/dykil does not exist and github-org-provisioning is not sealed — create it out of band with " +
      "'gh repo create ima-jin/dykil --template ima-jin/imajin-app-template' and re-run apps.provision, or seal an " +
      "org-scoped GitHub credential via POST /api/vault/set first (see docs/REGISTRATION.md)",
    ));

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('repo');
    expect(outcome.error).toContain('does not exist and github-org-provisioning is not sealed');
    expect(outcome.error).toContain('gh repo create ima-jin/dykil --template ima-jin/imajin-app-template');
    expect(mintKeypairMock).not.toHaveBeenCalled();
    expect(registryAppsStore.size).toBe(0);
  });

  it('sealed credential: same outcome — secretsSet stays empty and the app key is never unsealed (#2437)', async () => {
    ensureRepoFromTemplateMock.mockResolvedValue({ repoUrl: 'https://github.com/ima-jin/dykil', created: false });
    tryGetInstallationTokenMock.mockResolvedValue('installation-token');

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.secretsSet).toEqual([]);
    expect(loadAndUnsealByGranteeMock).not.toHaveBeenCalled();

    const row = appProvisionsStore.get('dykil');
    expect(row?.sealedAt).toBeUndefined();
  });
});

/**
 * #2436 (follow-up to #2418/#2416): a stale pre-#2416 PAT still sealed in
 * `github-org-provisioning` must fail the pipeline closed with
 * `OrgCredentialMalformedError` — not degrade like the never-sealed case.
 * Unlike the rest of this file, the org-provisioning functions here are the
 * REAL implementations (only the vault read and `fetch` are faked), so the
 * error genuinely travels the whole `runAppProvision` chain.
 */
describe('runAppProvision — stale PAT still sealed (#2436, real org-provisioning)', () => {
  const STALE_PAT = 'ghp_stale_pre_2416_pat_not_json';
  const MALFORMED_MESSAGE = 'github-org-provisioning is sealed but malformed (not valid JSON)';
  let fetchMock: ReturnType<typeof vi.fn>;

  function repoResponse(status: number): Response {
    const body = status === 200
      ? JSON.stringify({ html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' })
      : JSON.stringify({ message: 'Not Found' });
    return new Response(body, { status });
  }

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/src/lib/github/org-provisioning')>(
      '@/src/lib/github/org-provisioning',
    );
    actual.__resetInstallationTokenCacheForTests();
    ensureRepoFromTemplateMock.mockImplementation(actual.ensureRepoFromTemplate);
    tryGetInstallationTokenMock.mockImplementation(actual.tryGetInstallationToken);
    fetchAppManifestMock.mockImplementation(actual.fetchAppManifest);
    loadAndUnsealMock.mockResolvedValue(STALE_PAT);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('repo already exists: fails closed at the first credential read (register) with OrgCredentialMalformedError, writing no registry row and never provisioning further', async () => {
    fetchMock.mockResolvedValueOnce(repoResponse(200));

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('register');
    expect(outcome.error).toContain(MALFORMED_MESSAGE);
    expect(outcome.error).not.toContain(STALE_PAT);

    // Only the unauthenticated existence GET ever reached GitHub — the stale PAT was never sent anywhere.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(registryAppsStore.size).toBe(0);
    expect(grantExistingMintedKeyMock).not.toHaveBeenCalled();
    expect(issueSigningKeyClaimMock).not.toHaveBeenCalled();

    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('failed');
    expect(row?.failedStep).toBe('register');
    expect(row?.errorMessage).toContain(MALFORMED_MESSAGE);
    expect(row?.sealedAt).toBeUndefined();
    expect(publishMock).toHaveBeenCalledWith('apps.provision.failed', expect.objectContaining({
      payload: expect.objectContaining({ slug: 'dykil', failedStep: 'register' }),
    }));
  });

  it('repo missing: fails closed at repo with OrgCredentialMalformedError, before mint/register ever run', async () => {
    fetchMock.mockResolvedValueOnce(repoResponse(404));

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.failedStep).toBe('repo');
    expect(outcome.error).toContain(MALFORMED_MESSAGE);
    expect(outcome.error).not.toContain(STALE_PAT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mintKeypairMock).not.toHaveBeenCalled();
    expect(registryAppsStore.size).toBe(0);
  });

  it('is NOT treated as the soft unsealed case: a stale PAT fails where a never-sealed credential succeeds', async () => {
    fetchMock.mockResolvedValueOnce(repoResponse(200));
    loadAndUnsealMock.mockResolvedValue(undefined);

    // Control: the genuinely-unsealed credential degrades and succeeds through the same real chain...
    const unsealed = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });
    expect(unsealed.status).toBe('succeeded');

    // ...whereas the stale PAT, for a fresh slug, does not.
    resetStores();
    publishMock.mockClear();
    loadAndUnsealMock.mockResolvedValue(STALE_PAT);
    fetchMock.mockResolvedValueOnce(repoResponse(200));

    const stale = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });
    expect(stale.status).toBe('failed');
  });
});

/**
 * #2437: provisioning must never copy the app's raw signing key into a GitHub
 * Actions secret. Like the #2436 block, this runs the REAL org-provisioning
 * module (only the vault read and `fetch` are faked) with a VALID App credential,
 * so every GitHub call a successful run makes is observed on the faked `fetch`.
 */
describe('runAppProvision — never writes the app key to GitHub Actions secrets (#2437, real org-provisioning)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  /** Every request a full, successful provision run is allowed to make; anything else is a 599. */
  function githubFake(url: string, init?: RequestInit): Response {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === 'https://api.github.com/repos/ima-jin/dykil') {
      return jsonResponse(200, { html_url: 'https://github.com/ima-jin/dykil', full_name: 'ima-jin/dykil' });
    }
    if (method === 'POST' && url === 'https://api.github.com/app/installations/42/access_tokens') {
      return jsonResponse(201, { token: 'ghs_installation_token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (method === 'GET' && url === 'https://api.github.com/repos/ima-jin/dykil/contents/imajin.app.json') {
      return jsonResponse(404, { message: 'Not Found' });
    }
    return jsonResponse(599, { message: `unexpected GitHub call: ${method} ${url}` });
  }

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/src/lib/github/org-provisioning')>(
      '@/src/lib/github/org-provisioning',
    );
    actual.__resetInstallationTokenCacheForTests();
    ensureRepoFromTemplateMock.mockImplementation(actual.ensureRepoFromTemplate);
    tryGetInstallationTokenMock.mockImplementation(actual.tryGetInstallationToken);
    fetchAppManifestMock.mockImplementation(actual.fetchAppManifest);
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    loadAndUnsealMock.mockResolvedValue(JSON.stringify({ appId: '1', installationId: '42', privateKeyPem: privateKey }));
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => githubFake(url, init));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a full run succeeds with secretsSet [] and makes no PUT / Actions-secrets call to GitHub', async () => {
    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.secretsSet).toEqual([]);
    expect(outcome.claimCode).toBe(CLAIM_CODE);

    // The run really did talk to GitHub (so the assertions below are not vacuous)...
    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      body: (init as RequestInit | undefined)?.body,
    }));
    // ...but never wrote a secret.
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([]);
    expect(calls.filter((call) => call.url.includes('/actions/secrets'))).toEqual([]);
    expect(calls.filter((call) => call.url.includes('IMAJIN_APP_PRIVATE_KEY'))).toEqual([]);
    for (const call of calls) {
      expect(String(call.body ?? '')).not.toContain(PRIVATE_KEY_PLAINTEXT);
    }

    // The key never left the vault: it was not unsealed, and nothing marks a seal on the ledger row.
    expect(loadAndUnsealByGranteeMock).not.toHaveBeenCalled();
    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('succeeded');
    expect(row?.secretsSet).toEqual([]);
    expect(row?.sealedAt).toBeUndefined();
  });

  it('a retry of an already-succeeded slug also never touches Actions secrets', async () => {
    await runAppProvision({ slug: 'dykil', displayName: 'dykil' });
    fetchMock.mockClear();

    const again = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(again.status).toBe('succeeded');
    const methods = fetchMock.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');
    expect(methods).not.toContain('PUT');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/actions/secrets'))).toBe(false);
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
  it('returns the cached result without re-creating anything for an already-succeeded slug (a pre-#2437 row replays its recorded secretsSet)', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
      repoUrl: 'https://github.com/ima-jin/dykil',
      repoCreated: false,
      sealedAt: new Date(),
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY'],
      attestationTypes: [],
      status: 'succeeded',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome).toEqual({
      status: 'succeeded',
      repoUrl: 'https://github.com/ima-jin/dykil',
      appDid: MINTED_DID,
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY'],
      attestationTypeResults: [],
      claimCode: CLAIM_CODE,
    });
    expect(ensureRepoFromTemplateMock).not.toHaveBeenCalled();
    expect(mintKeypairMock).not.toHaveBeenCalled();
  });

  it('a post-#2437 succeeded row (secretsSet []) replays an empty list', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
      repoUrl: 'https://github.com/ima-jin/dykil',
      repoCreated: true,
      secretsSet: [],
      attestationTypes: [],
      status: 'succeeded',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.secretsSet).toEqual([]);
  });

  it('re-issues a fresh claim code every time, reusing the existing grant', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
      repoUrl: 'https://github.com/ima-jin/dykil',
      repoCreated: false,
      sealedAt: new Date(),
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY'],
      attestationTypes: [],
      status: 'succeeded',
    });
    vaultDelegationGrantsStore.set('vdg_existing', {
      id: 'vdg_existing',
      subject: MINTED_DID,
      grantedTo: MINTED_DID,
      field: `vault-minted-key:${MINTED_DID}`,
      purpose: 'app-signing-key',
      status: 'active',
    });

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    if (outcome.status !== 'succeeded') throw new Error('unreachable');
    expect(outcome.claimCode).toBe(CLAIM_CODE);
    expect(grantExistingMintedKeyMock).not.toHaveBeenCalled();
    expect(issueSigningKeyClaimMock).toHaveBeenCalledWith({
      nodeDid: NODE_DID,
      slug: 'dykil',
      appDid: MINTED_DID,
      grantId: 'vdg_existing',
    });
  });

  it('still additively seeds newly requested attestation types on an already-succeeded slug', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
      repoUrl: 'https://github.com/ima-jin/dykil',
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY'],
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
    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('failed');
    expect(row?.failedStep).toBe('mint');
    // Mint never succeeded, so no appDid was ever persisted to the ledger.
    expect(row?.appDid).toBeUndefined();
  });

  it('reuses a previously-minted active key on retry without minting again or ever unsealing it (#2437)', async () => {
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

    const outcome = await runAppProvision({ slug: 'dykil', displayName: 'dykil' });

    expect(outcome.status).toBe('succeeded');
    expect(mintKeypairMock).not.toHaveBeenCalled();
    expect([...registryAppsStore.values()][0]?.publicKey).toBe('already-minted-public-key');
    expect(loadAndUnsealByGranteeMock).not.toHaveBeenCalled();
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
    } finally {
      db.insert = originalInsert;
    }
  });

  it('names the failed step when seeding attestation types throws unexpectedly', async () => {
    seedAttestationTypesMock.mockRejectedValueOnce(new Error('registry unavailable'));

    const outcome = await runAppProvision({
      slug: 'dykil',
      displayName: 'dykil',
      attestationTypes: ['dykil/survey-response'],
    });

    expect(outcome).toEqual({ status: 'failed', failedStep: 'attestation-types', error: 'registry unavailable' });
    // Register + grant already succeeded — a retry only re-seeds.
    const row = appProvisionsStore.get('dykil');
    expect(row?.status).toBe('failed');
    expect(row?.failedStep).toBe('attestation-types');
    expect(registryAppsStore.size).toBe(1);
  });

  it('retrying after a grant failure reuses the minted key and registered row, completing the run', async () => {
    appProvisionsStore.set('dykil', {
      slug: 'dykil',
      appDid: MINTED_DID,
      repoUrl: 'https://github.com/ima-jin/dykil',
      repoCreated: true,
      registeredAt: new Date(),
      secretsSet: [],
      attestationTypes: [],
      status: 'failed',
      failedStep: 'app-signing-key-grant',
      errorMessage: 'could not grant',
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
    expect(issueSigningKeyClaimMock).toHaveBeenCalledTimes(1);
  });

  it('retrying after an attestation-types failure skips mint/register (register already-registered)', async () => {
    // Register already inserted this run's row (matched by appDid below) — only
    // attestation-types is retried. The ledger row is a pre-#2437 one, so it replays its recorded secretsSet.
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
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY'],
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
    expect(outcome.secretsSet).toEqual(['IMAJIN_APP_PRIVATE_KEY']);
    expect(mintKeypairMock).not.toHaveBeenCalled();
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

    // #2437: the plaintext never even left the vault — nothing in provisioning unseals it.
    expect(loadAndUnsealByGranteeMock).not.toHaveBeenCalled();
  });
});

describe('provision slug pattern vs audience slug pattern (#2706) — they must not drift', () => {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-';

  /** Every string of length 1..3 over the slug alphabet plus a few out-of-alphabet shapes. */
  function* candidates(): Generator<string> {
    let layer = [''];
    for (let len = 1; len <= 3; len++) {
      layer = layer.flatMap((prefix) => [...ALPHABET].map((c) => prefix + c));
      yield* layer;
    }
    yield 'a'.padEnd(39, 'b');
    yield 'a'.padEnd(40, 'b');
    yield* ['app-', 'a--b', 'My-App', 'my_app', 'dev-jin.imajin.ai', 'jin.imajin.ai:443', 'https://x/y', ''];
  }

  it('every slug the provision pattern accepts is a valid token audience (and vice versa)', () => {
    let accepted = 0;
    for (const candidate of candidates()) {
      const provisionable = PROVISION_SLUG_PATTERN.test(candidate);
      expect(isAppAudienceSlug(candidate), JSON.stringify(candidate)).toBe(provisionable);
      if (provisionable) accepted += 1;
    }
    expect(accepted).toBeGreaterThan(1000);
  });

  it("the /jin form's pattern is the provision route's pattern", () => {
    const routeSource = readFileSync(
      resolve(__dirname, '../../../../app/api/apps/provision/route.ts'),
      'utf8',
    );
    const match = /const SLUG_PATTERN = (\/.*\/);/.exec(routeSource);
    expect(match?.[1]).toBe(String(PROVISION_SLUG_PATTERN));
  });
});
