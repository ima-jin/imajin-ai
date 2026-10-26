import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), select: vi.fn(), set: vi.fn(), write: vi.fn(), manifest: vi.fn(),
  ensure: vi.fn(), rotate: vi.fn(), revoke: vi.fn(), list: vi.fn(), consume: vi.fn(), supplied: vi.fn(), owner: vi.fn(),
  prepare: vi.fn(), audit: vi.fn(), lock: vi.fn(), generate: vi.fn(),
}));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: mocks.prepare }));
vi.mock('../../vault/authorization', () => ({ resolveVaultAuthorization: mocks.auth }));
vi.mock('../secret-staging', () => ({ consumeAppSecret: mocks.consume }));
vi.mock('@/src/lib/notify/operator-approvals', () => ({ getOperatorDid: mocks.owner }));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: vi.fn() }));
vi.mock('@/src/lib/github/org-provisioning', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/src/lib/github/org-provisioning')>(),
  fetchAppManifest: mocks.manifest, tryGetInstallationToken: async () => null,
}));
vi.mock('../self-secrets', () => ({
  ensureAppDeclaredSecrets: mocks.ensure, rotateAppDeclaredSecret: mocks.rotate,
  revokeAppDeclaredSecret: mocks.revoke, listAppDeclaredSecrets: mocks.list,
  setAppDeclaredSecret: mocks.supplied,
  generateAppDeclaredSecret: mocks.generate,
}));
vi.mock('@/src/db', () => ({
  registryApps: {}, appProvisions: {}, appSigningKeyClaims: {}, operatorApprovals: {}, attestations: {},
  db: {
    transaction: async (run: (tx: unknown) => Promise<unknown>) => run({
      execute: mocks.lock,
      select: () => ({ from: () => ({ where: () => ({ limit: mocks.select }) }) }),
      update: () => ({ set: mocks.set.mockImplementation(() => ({
        where: () => ({ returning: mocks.write }),
      })) }),
      insert: () => ({ values: mocks.audit }),
    }),
    select: () => ({ from: () => {
      const rows = mocks.select();
      const result = Object.assign(Promise.resolve(rows), { orderBy: () => Promise.resolve(rows) });
      return { where: () => result, orderBy: () => Promise.resolve(rows) };
    } }),
    update: () => ({ set: mocks.set.mockImplementation(() => ({ where: mocks.write })) }),
  },
}));
import { executeAppSecretsApproval, listOperatorAppSecrets, previewAppSecrets, withPendingSecretSync } from '../secrets-operator';

const declaration = { name: 'SESSION_SECRET', kind: 'random-32B' };
const authorization = { operatorDid: 'did:imajin:fake-operator', decidedAt: '2026-10-14T00:00:00Z', approvalId: 'fake-proposal', contentHash: 'fake-hash' };
afterEach(() => vi.unstubAllGlobals());
function card(kind = 'apps:secrets-sync', detail: Record<string, unknown> = { slug: 'fake-app', secrets: [declaration] }) {
  return { kind, source: 'apps', status: 'approved', decision: { decision: 'approve' }, detail: { appDid: 'did:imajin:fake-app', ...detail } } as OperatorApprovalCard;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.select.mockReset();
  mocks.rotate.mockReset();
  mocks.revoke.mockReset();
  mocks.generate.mockReset();
  mocks.auth.mockReturnValue(authorization);
  mocks.owner.mockResolvedValue(authorization.operatorDid);
  mocks.consume.mockResolvedValue('OBVIOUSLY_FAKE_OPERATOR_INPUT');
  mocks.select.mockReturnValueOnce([{ status: 'active', slug: 'fake-app', secrets: [declaration] }])
    .mockReturnValueOnce([{ appDid: 'did:imajin:fake-app' }]);
  mocks.manifest.mockResolvedValue({ ok: { secrets: [declaration] } });
  mocks.write.mockResolvedValue([{ appDid: 'did:imajin:fake-app' }]);
  mocks.lock.mockResolvedValue([{ locked: true }]);
  mocks.prepare.mockResolvedValue({ id: 'fake-attestation' });
  mocks.audit.mockResolvedValue(undefined);
});

describe('additive declaration refresh', () => {
  const added = { name: 'LEGACY_DATABASE_URL', kind: 'operator-supplied' };
  function registered(secrets = [declaration]) {
    return {
      status: 'active', slug: 'fake-app', secrets, appDid: 'did:imajin:fake-app',
      id: 'app_fixture', publicKey: 'fixture-public-key', ownerDid: 'did:imajin:fixture-owner',
      claim: { status: 'claimed' }, providesScopes: ['fake:read'], dependsOn: [],
      emittableEvents: [], updatedAt: '2026-10-14T00:00:00Z',
    };
  }
  it('adds the prod-dykil-shaped slot, preserves every other column, and executing twice is a no-op', async () => {
    const row = registered();
    const before = structuredClone(row);
    mocks.select.mockReset().mockImplementation(() => [row]);
    mocks.manifest.mockResolvedValue({ ok: {
      secrets: [added], providesScopes: ['fake:admin'], dependsOn: [{ aud: 'other', scopes: ['write'] }],
      emittableEvents: ['new.event'],
    } });
    mocks.write.mockImplementation(async () => {
      Object.assign(row, mocks.set.mock.calls.at(-1)![0]);
      return [{ appDid: row.appDid }];
    });
    const approved = card('apps:secrets-sync', { slug: row.slug, secrets: [added] });
    expect((await executeAppSecretsApproval(approved)).ok).toBe(true);
    expect(row).toEqual({ ...before, secrets: [...before.secrets, added] });
    expect(mocks.set).toHaveBeenCalledWith({ secrets: [...before.secrets, added] });
    expect(await executeAppSecretsApproval(approved)).toEqual({
      ok: true, data: { appDid: row.appDid, action: 'sync', names: [] },
    });
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it('passes only the approved app/name and countersigned authority to Generate, never returns its material', async () => {
    mocks.generate.mockResolvedValueOnce({ value: 'OBVIOUSLY_FAKE_GENERATED_MATERIAL' });
    expect(await executeAppSecretsApproval(card('apps:secrets-generate', { name: declaration.name }))).toEqual({
      ok: true, data: { appDid: 'did:imajin:fake-app', action: 'generate', names: [declaration.name] },
    });
    expect(mocks.generate).toHaveBeenCalledWith('did:imajin:fake-app', declaration.name, authorization);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.supplied).not.toHaveBeenCalled();
  });
  it.each(['unclaimed', 'inactive', 'undeclared', 'operator-supplied'])('refuses Generate for %s apps or declarations', async (boundary) => {
    const app = { status: boundary === 'inactive' ? 'revoked' : 'active',
      secrets: boundary === 'undeclared' ? [] : [{ ...declaration, kind: boundary === 'operator-supplied' ? 'operator-supplied' : declaration.kind }] };
    mocks.select.mockReset().mockReturnValueOnce([app]).mockReturnValueOnce(boundary === 'unclaimed' ? [] : [{ appDid: 'did:imajin:fake-app' }]);
    expect((await executeAppSecretsApproval(card('apps:secrets-generate', { name: declaration.name }))).ok).toBe(false);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('redacts Generate custody failures without logging or returning underlying material', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('OBVIOUSLY_FAKE_GENERATED_MATERIAL'));
    expect(await executeAppSecretsApproval(card('apps:secrets-generate', { name: declaration.name })))
      .toEqual({ ok: false, error: 'App-secret execution failed' });
  });
  it('does not apply an approved kind change', async () => {
    const changed = { ...declaration, kind: 'random-64B' };
    mocks.manifest.mockResolvedValue({ ok: { secrets: [changed] } });
    expect((await executeAppSecretsApproval(card('apps:secrets-sync', { slug: 'fake-app', secrets: [changed] }))).ok).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('refuses a combined list exceeding the declaration limit', async () => {
    mocks.select.mockReset().mockReturnValueOnce([registered(Array.from({ length: 32 }, (_, i) => ({
      name: `EXISTING_${i}`, kind: 'random-32B',
    }))) ]).mockReturnValueOnce([{ appDid: 'did:imajin:fake-app' }]);
    mocks.manifest.mockResolvedValue({ ok: { secrets: [added] } });
    expect((await executeAppSecretsApproval(card('apps:secrets-sync', { slug: 'fake-app', secrets: [added] }))).ok).toBe(false);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it.each(['sign', 'compare-and-set', 'audit'])('fails closed on %s failure', async (step) => {
    mocks.manifest.mockResolvedValue({ ok: { secrets: [added] } });
    if (step === 'sign') mocks.prepare.mockRejectedValueOnce(new Error('fixture'));
    if (step === 'compare-and-set') mocks.write.mockResolvedValueOnce([]);
    if (step === 'audit') mocks.audit.mockRejectedValueOnce(new Error('fixture'));
    expect((await executeAppSecretsApproval(card('apps:secrets-sync', { slug: 'fake-app', secrets: [added] }))).ok).toBe(false);
    if (step === 'sign') expect(mocks.set).not.toHaveBeenCalled();
    if (step === 'compare-and-set') expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('reuses the pending card without rereading the manifest or creating another', async () => {
    mocks.select.mockReset().mockResolvedValue([{ proposalId: 'pending-fixture' }]);
    const create = vi.fn();
    expect(await withPendingSecretSync('did:imajin:fake-app', authorization.operatorDid, create)).toBe('pending-fixture');
    expect(create).not.toHaveBeenCalled();
  });
  it('creates a card only after acquiring the per-app lock and finding no pending card', async () => {
    mocks.select.mockReset().mockResolvedValue([]);
    const create = vi.fn().mockResolvedValue('new-fixture');
    expect(await withPendingSecretSync('did:imajin:fake-app', authorization.operatorDid, create)).toBe('new-fixture');
    expect(create).toHaveBeenCalledTimes(1);
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  });
  it.each([{ lock: [] }, { lock: [{ locked: false }] }])('does not create duplicates when a concurrent detector holds the lock', async ({ lock }) => {
    mocks.lock.mockResolvedValueOnce(lock);
    const create = vi.fn();
    await expect(withPendingSecretSync('did:imajin:fake-app', authorization.operatorDid, create)).rejects.toThrow('busy');
    expect(create).not.toHaveBeenCalled();
  });
});
describe('app secret execution', () => {
  it.each(['pending', 'denied', 'withdrawn', 'expired', 'applied'])('refuses %s cards even when signature authorization fields exist', async (status) => {
    expect((await executeAppSecretsApproval({ ...card(), status } as OperatorApprovalCard)).ok).toBe(false);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it('refuses an approved-looking card carrying a signed rejection', async () => {
    const rejected = card();
    rejected.decision = { decision: 'reject' } as NonNullable<OperatorApprovalCard['decision']>;
    expect((await executeAppSecretsApproval(rejected)).ok).toBe(false);
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it.each(['sync', 'generate', 'set', 'rotate', 'revoke'])('refuses unsigned %s without any read or mutation', async (action) => {
    mocks.auth.mockReturnValue(null);
    expect((await executeAppSecretsApproval(card(`apps:secrets-${action}`))).ok).toBe(false);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it.each(['set', 'rotate'])('consumes only a reference bound to the approved owner/app/name/%s action', async (action) => {
    mocks.select.mockReset().mockReturnValueOnce([{ status: 'active', secrets: [{ name: 'DATABASE_URL', kind: 'operator-supplied' }] }])
      .mockReturnValueOnce([{ appDid: 'did:imajin:fake-app' }]);
    const result = await executeAppSecretsApproval(card(`apps:secrets-${action}`, { name: 'DATABASE_URL', stagingRef: 'fake-reference' }));
    expect(mocks.consume).toHaveBeenCalledWith('fake-reference', {
      proposalId: authorization.approvalId, operatorDid: authorization.operatorDid, appDid: 'did:imajin:fake-app', name: 'DATABASE_URL', action,
    });
    expect(mocks.supplied).toHaveBeenCalledWith('did:imajin:fake-app', 'DATABASE_URL', action, 'OBVIOUSLY_FAKE_OPERATOR_INPUT', authorization);
    expect(result).toEqual({ ok: true, data: { appDid: 'did:imajin:fake-app', action, names: ['DATABASE_URL'] } });
  });
  it('refuses input for generated declarations and a signer who is not the current owner', async () => {
    expect((await executeAppSecretsApproval(card('apps:secrets-set', { name: 'SESSION_SECRET', stagingRef: 'fake-reference' }))).ok).toBe(false);
    mocks.select.mockReset().mockReturnValueOnce([{ status: 'active', secrets: [{ name: 'DATABASE_URL', kind: 'operator-supplied' }] }])
      .mockReturnValueOnce([{ appDid: 'did:imajin:fake-app' }]);
    mocks.owner.mockResolvedValue('did:imajin:fake-other-owner');
    expect((await executeAppSecretsApproval(card('apps:secrets-set', { name: 'DATABASE_URL', stagingRef: 'fake-reference' }))).ok).toBe(false);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.supplied).not.toHaveBeenCalled();
  });
  it('redacts provider failure after approval without importing input', async () => {
    mocks.select.mockReset().mockReturnValueOnce([{ status: 'active', secrets: [{ name: 'DATABASE_URL', kind: 'operator-supplied' }] }])
      .mockReturnValueOnce([{ appDid: 'did:imajin:fake-app' }]);
    mocks.consume.mockRejectedValueOnce(new Error('OBVIOUSLY_FAKE_OPERATOR_INPUT'));
    expect(await executeAppSecretsApproval(card('apps:secrets-set', { name: 'DATABASE_URL', stagingRef: 'fake-reference' })))
      .toEqual({ ok: false, error: 'App-secret execution failed' });
    expect(mocks.supplied).not.toHaveBeenCalled();
  });
  it('previews public manifest secrets with no installation credential', async () => {
    expect(await previewAppSecrets('fake-app')).toEqual({ ok: [declaration] });
    expect(mocks.manifest).toHaveBeenCalledWith('fake-app', null);
  });
  it.each([
    [{ error: 'unreadable', status: 404 }, "App 'fake-app' manifest unreadable (HTTP 404)"],
    [{ error: 'unreadable', status: 503 }, "App 'fake-app' manifest unreadable (HTTP 503)"],
    [{ error: 'unreadable' }, "App 'fake-app' manifest unreadable"],
    [{ error: 'invalid' }, "App 'fake-app' manifest invalid"],
  ])('surfaces names-only failure for preview and Sync execution: %j', async (manifest, error) => {
    mocks.manifest.mockResolvedValue(manifest);
    expect(await previewAppSecrets('fake-app')).toEqual({ error });
    expect(await executeAppSecretsApproval(card())).toEqual({ ok: false, error });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it('sanitizes unexpected manifest provider errors', async () => {
    mocks.manifest.mockRejectedValue(new Error('obvious-fake-provider-placeholder'));
    expect(await previewAppSecrets('fake-app')).toEqual({ error: "App 'fake-app' manifest unreadable" });
  });
  it.each([{}, { secrets: [] }])('accepts declared-none manifests in preview and signed Sync: %j', async (manifest) => {
    mocks.manifest.mockResolvedValue({ ok: manifest });
    expect(await previewAppSecrets('fake-app')).toEqual({ ok: [] });
    expect(await executeAppSecretsApproval(card('apps:secrets-sync', { slug: 'fake-app', secrets: [] })))
      .toEqual({ ok: true, data: { appDid: 'did:imajin:fake-app', action: 'sync', names: [] } });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it('persists only the approved recipes with signed authority, never generates values', async () => {
    mocks.select.mockReset().mockReturnValueOnce([{ status: 'active', slug: 'fake-app', secrets: [] }])
      .mockReturnValueOnce([{ appDid: 'did:imajin:fake-app' }]);
    const result = await executeAppSecretsApproval(card());
    expect(result).toEqual({ ok: true, data: { appDid: 'did:imajin:fake-app', action: 'sync', names: ['SESSION_SECRET'] } });
    expect(mocks.set).toHaveBeenCalledWith({ secrets: [declaration] });
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      payload: { appDid: 'did:imajin:fake-app', additions: [declaration], authorizedBy: authorization },
    }));
    expect(mocks.audit).toHaveBeenCalledWith({ id: 'fake-attestation' });
    expect(mocks.write.mock.invocationCallOrder[0]).toBeLessThan(mocks.audit.mock.invocationCallOrder[0]);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.supplied).not.toHaveBeenCalled();
  });
  it.each([
    { error: 'unreadable', status: 404 },
    { error: 'unreadable', status: 503 },
    { error: 'unreadable' },
    { error: 'invalid' },
    { ok: { secrets: [{ name: 'NEW_SECRET', kind: 'random-64B' }] } },
    { ok: { secrets: [{ ...declaration, value: 'obvious-fake-placeholder' }] } },
  ])('refuses unreadable, invalid, drifted or value-bearing manifests', async (manifest) => {
    mocks.manifest.mockResolvedValue(manifest);
    expect((await executeAppSecretsApproval(card())).ok).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it('refuses source drift and missing snapshots', async () => {
    expect((await executeAppSecretsApproval(card('apps:secrets-sync', { slug: 'other-app', secrets: [declaration] }))).ok).toBe(false);
    expect((await executeAppSecretsApproval(card('apps:secrets-sync', { slug: 'fake-app' }))).ok).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it.each(['rotate', 'revoke'])('passes authority to %s without returning helper data', async (action) => {
    mocks.rotate.mockResolvedValue({ value: 'obvious-fake-placeholder' });
    mocks.revoke.mockResolvedValue({ value: 'obvious-fake-placeholder' });
    const result = await executeAppSecretsApproval(card(`apps:secrets-${action}`, { name: 'SESSION_SECRET' }));
    expect(action === 'rotate' ? mocks.rotate : mocks.revoke).toHaveBeenCalledWith('did:imajin:fake-app', 'SESSION_SECRET', authorization);
    expect(JSON.stringify(result)).not.toContain('obvious-fake-placeholder');
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('does not surface provider error text', async () => {
    mocks.rotate.mockRejectedValue(new Error('obvious-fake-placeholder'));
    expect(await executeAppSecretsApproval(card('apps:secrets-rotate', { name: 'SESSION_SECRET' })))
      .toEqual({ ok: false, error: 'App-secret execution failed' });
  });
  it('refuses undeclared names', async () => {
    expect((await executeAppSecretsApproval(card('apps:secrets-revoke', { name: 'OTHER_SECRET' }))).ok).toBe(false);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it('refuses an unclaimed app', async () => {
    mocks.select.mockReset().mockReturnValueOnce([{ status: 'active', secrets: [] }]).mockReturnValueOnce([]);
    expect((await executeAppSecretsApproval(card())).ok).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('refuses a revoked app', async () => {
    mocks.select.mockReset().mockReturnValueOnce([{ status: 'revoked' }]);
    expect((await executeAppSecretsApproval(card())).ok).toBe(false);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
describe('metadata and manifest preview', () => {
  it('returns no cards and reads no secret metadata when both ledgers are empty', async () => {
    mocks.select.mockReset().mockReturnValue([]);
    mocks.list.mockClear();
    expect(await listOperatorAppSecrets()).toEqual([]);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledTimes(3);
  });
  it('reads operator-supplied names and kinds through the real manifest validator', async () => {
    const { fetchAppManifest } = await vi.importActual<typeof import('@/src/lib/github/org-provisioning')>('@/src/lib/github/org-provisioning');
    mocks.manifest.mockImplementation(fetchAppManifest);
    const secrets = [{ name: 'DATABASE_URL', kind: 'operator-supplied' }];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ secrets })));
    expect(await previewAppSecrets('fake-app')).toEqual({ ok: secrets });
  });
  it('reads a public manifest without credentials, then persists only signed declaration slots', async () => {
    mocks.select.mockReset().mockReturnValueOnce([{ status: 'active', slug: 'fake-app', secrets: [] }])
      .mockReturnValueOnce([{ appDid: 'did:imajin:fake-app' }]);
    const { fetchAppManifest } = await vi.importActual<typeof import('@/src/lib/github/org-provisioning')>('@/src/lib/github/org-provisioning');
    mocks.manifest.mockImplementation(fetchAppManifest);
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ secrets: [declaration] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await previewAppSecrets('fake-app')).toEqual({ ok: [declaration] });
    expect(await executeAppSecretsApproval(card())).toEqual({
      ok: true, data: { appDid: 'did:imajin:fake-app', action: 'sync', names: ['SESSION_SECRET'] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://raw.githubusercontent.com/ima-jin/fake-app/HEAD/imajin.app.json');
      expect(init).toMatchObject({ method: 'GET', cache: 'no-store' });
      expect(init.headers).toBeUndefined();
    }
    expect(mocks.set).toHaveBeenCalledWith({ secrets: [declaration] });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it.each([
    [404, 'provider placeholder', 'unreadable'],
    [503, 'provider placeholder', 'unreadable'],
    [200, 'invalid JSON placeholder', 'invalid'],
    [200, '{"secrets":"invalid placeholder"}', 'invalid'],
  ])('real public reader failure %s refuses both preview and Sync without a write', async (status, body, failure) => {
    const { fetchAppManifest } = await vi.importActual<typeof import('@/src/lib/github/org-provisioning')>('@/src/lib/github/org-provisioning');
    mocks.manifest.mockImplementation(fetchAppManifest);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(body, { status })));
    const error = `App 'fake-app' manifest ${failure} (HTTP ${status})`;
    expect(await previewAppSecrets('fake-app')).toEqual({ error });
    expect(await executeAppSecretsApproval(card())).toEqual({ ok: false, error });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it('rejects malformed manifests instead of treating them as no secrets', async () => {
    mocks.manifest.mockResolvedValue({ ok: { secrets: 'bad' } });
    expect(await previewAppSecrets('fake-app')).toEqual({ error: "App 'fake-app' manifest invalid" });
  });
  it('includes active claimed registry apps with no provision ledger, and unclaimed provisions', async () => {
    mocks.select.mockReset()
      .mockReturnValueOnce([{ appDid: 'did:imajin:fake-old', name: 'Old app', slug: 'old-app', createdAt: null, ownerDid: null }])
      .mockReturnValueOnce([{ appDid: 'did:imajin:fake-new', slug: 'new-app' }])
      .mockReturnValueOnce([{ appDid: 'did:imajin:fake-old', status: 'claimed', expiresAt: new Date('2026-10-14T00:00:00Z') }])
      .mockReturnValueOnce([]);
    mocks.list.mockResolvedValue([{ ...declaration, status: 'active', timeline: [], value: 'obvious-fake-placeholder' }]);
    const provenance = {
      created: { at: null, by: null },
      provisioned: { at: null, proposedBy: null, approvedBy: null },
      claimed: { at: null, by: null }, lastSeen: { at: null, by: null },
    };
    expect(await listOperatorAppSecrets()).toEqual([
      { appDid: 'did:imajin:fake-old', name: 'Old app', slug: 'old-app', active: true, claimed: true,
        provisionFailed: false,
        claimExpiresAt: '2026-10-14T00:00:00.000Z', provenance,
        secrets: [{ ...declaration, status: 'active', timeline: [] }] },
      { appDid: 'did:imajin:fake-new', name: 'new-app', slug: 'new-app', active: false, claimed: false,
        provisionFailed: false,
        claimExpiresAt: null, provenance, secrets: [] },
    ]);
  });
});
