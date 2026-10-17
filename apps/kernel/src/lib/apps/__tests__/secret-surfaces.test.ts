import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(), load: vi.fn(), read: vi.fn(), seal: vi.fn(), grant: vi.fn(), fetch: vi.fn(), rows: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({
  requireAdmin: async () => true,
  requireAuth: async () => ({ identity: { id: 'did:imajin:fake-owner' } }),
}));
vi.mock('@/src/lib/vault', () => ({
  vaultService: { list: mocks.list, loadVault: mocks.load },
  loadAndUnseal: mocks.read, sealAndStoreV2: mocks.seal,
  getGrantById: mocks.grant, fetchGrantSecret: mocks.fetch,
}));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:fake-node' }), isVaultTier1: () => false,
}));
vi.mock('@/src/lib/vault/route-helpers', () => ({ publishVaultDelegationAudit: vi.fn() }));
vi.mock('@/src/db', () => ({
  vaultDelegationGrants: {}, vaultGrantRequests: {}, vaultMintedKeys: {},
  db: {
    select: () => ({ from: () => ({ where: mocks.rows }) }),
    selectDistinct: () => ({ from: () => ({ where: mocks.rows }) }),
  },
}));
import { GET as list } from '@/app/api/vault/list/route';
import { POST as upgrade } from '@/app/api/vault/upgrade-custody/route';
import { POST as sweep } from '@/app/api/vault/rotation-sweep/route';
import { POST as fetchGrant } from '@/app/api/vault/delegation/grants/[grantId]/fetch/route';
import { listHandProvisionedFields } from '../../vault/key-cards';
import { selectLiveV1Fields } from '../../vault/migrate-custody';

const staging = 'internal-secret:app-self:staging:fake-reference';
const appSecret = 'internal-secret:app-self:did:imajin:fake-app:DATABASE_URL';
const entry = (field: string) => ({
  field, encrypted: 'OBVIOUSLY_FAKE_CIPHERTEXT', timestamp: '2026-10-17T00:00:00Z',
  senderDid: 'did:imajin:fake-node',
});
function request(body: unknown) {
  return new Request('https://fake.example/api/vault/fake', { method: 'POST', body: JSON.stringify(body) }) as Parameters<typeof sweep>[0];
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.rows.mockResolvedValue([]);
  mocks.list.mockResolvedValue([entry(staging), entry('FAKE_UNRELATED_FIELD')]);
  mocks.load.mockResolvedValue({ entries: [entry(staging), entry('FAKE_UNRELATED_FIELD')] });
});
describe('operator app input has no generic vault escape hatch', () => {
  it('hides pending staging from admin vault and hand-provisioned listings', async () => {
    const fields = await (await list()).json();
    expect(fields.map((item: { field: string }) => item.field)).toEqual(['FAKE_UNRELATED_FIELD']);
    expect((await listHandProvisionedFields()).map((item) => item.field)).toEqual(['FAKE_UNRELATED_FIELD']);
  });
  it('does not migrate staging into grant-bearing custody', async () => {
    expect((await selectLiveV1Fields()).map((item) => item.field)).toEqual(['FAKE_UNRELATED_FIELD']);
    expect((await upgrade(request({ field: staging }))).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });
  it('never unseals app or staging fields during the admin plaintext export sweep', async () => {
    mocks.rows.mockResolvedValue([{ field: staging }, { field: appSecret }]);
    const response = await sweep(request({ phase: 'export' }));
    expect(await response.json()).toEqual({ fields: [] });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([staging, appSecret])('refuses generic reimport of %s before any mutation', async (field) => {
    const response = await sweep(request({ phase: 'reimport', fields: [
      { field: 'FAKE_UNRELATED_FIELD', plaintext: 'OBVIOUSLY_FAKE_INPUT' },
      { field, plaintext: 'OBVIOUSLY_FAKE_INPUT' },
    ] }));
    expect(response.status).toBe(403);
    expect(mocks.seal).not.toHaveBeenCalled();
  });
  it.each([staging, appSecret])('refuses generic plaintext grant fetch for %s', async (field) => {
    mocks.grant.mockResolvedValue({ field });
    const response = await fetchGrant(request({}), { params: Promise.resolve({ grantId: 'fake-grant' }) });
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
