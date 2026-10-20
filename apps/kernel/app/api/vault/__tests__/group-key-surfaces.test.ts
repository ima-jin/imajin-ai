import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from 'node:crypto';
const rotationPublicKey = Buffer.from(ed25519.getPublicKey(randomBytes(32))).toString('hex');
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUP_KEY_NAMESPACE, isGroupKeyField } from '@/src/lib/vault/field-grammar';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireAuth: vi.fn(),
  fetchGrantSecret: vi.fn(),
  getGrantById: vi.fn(),
  loadAndUnseal: vi.fn(),
  sealAndStore: vi.fn(),
  sealAndStoreV2: vi.fn(),
  rotateAndStore: vi.fn(),
  eraseInactiveGrantKeyMaterial: vi.fn(),
  vaultGet: vi.fn(),
  vaultPeek: vi.fn(),
  deleteSecretAndRevokeGrants: vi.fn(),
  getNodeSigningIdentity: vi.fn(),
  listOtherActiveGrantees: vi.fn(),
  getRotateGranteeGuard: vi.fn(),
  migrateCustody: vi.fn(),
  selectLiveV1Fields: vi.fn(),
  selectDistinct: vi.fn(),
  rows: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  publish: vi.fn(),
  audit: vi.fn(),
  log: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAdmin: mocks.requireAdmin, requireAuth: mocks.requireAuth,
  authErrorResponse: vi.fn(), verifySync: vi.fn(),
}));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: mocks.log, warn: mocks.log, error: mocks.log }),
}));
vi.mock('@/src/db', () => ({
  db: { selectDistinct: mocks.selectDistinct, update: mocks.update, insert: mocks.insert },
  vaultDelegationGrants: { field: 'field', status: 'status' }, vaultGrantRequests: {},
}));
vi.mock('@/src/lib/vault/rotation-handoff', async (original) => ({
  ...await original<typeof import('@/src/lib/vault/rotation-handoff')>(),
  exportRotationHandoff: async (newPublicKey: string, collect: () => Promise<unknown[]>) => ({ exported: (await collect()).length, newPublicKey }),
}));
vi.mock('@/src/lib/vault', () => ({
  fetchGrantSecret: mocks.fetchGrantSecret, getGrantById: mocks.getGrantById,
  loadAndUnseal: mocks.loadAndUnseal, sealAndStore: mocks.sealAndStore,
  sealAndStoreV2: mocks.sealAndStoreV2, rotateAndStore: mocks.rotateAndStore,
  eraseInactiveGrantKeyMaterial: mocks.eraseInactiveGrantKeyMaterial,
  vaultService: { get: mocks.vaultGet, peek: mocks.vaultPeek },
}));
vi.mock('@/src/lib/vault/delete-secret', () => ({
  deleteSecretAndRevokeGrants: mocks.deleteSecretAndRevokeGrants,
}));
vi.mock('@/src/lib/vault/sealing', () => ({ getNodeSigningIdentity: mocks.getNodeSigningIdentity }));
vi.mock('@/src/lib/vault/grantees', () => ({
  listOtherActiveGrantees: mocks.listOtherActiveGrantees,
  getRotateGranteeGuard: mocks.getRotateGranteeGuard,
}));
vi.mock('@/src/lib/vault/migrate-custody', () => ({
  migrateCustody: mocks.migrateCustody, selectLiveV1Fields: mocks.selectLiveV1Fields,
}));
vi.mock('@/src/lib/vault/subscribe', () => ({ ensureVaultHotReloadReactorRegistered: vi.fn() }));
vi.mock('@/src/lib/vault/route-helpers', () => ({
  publishVaultDelegationAudit: mocks.audit,
  GRANT_NOT_FOUND_STATUS: 404, GRANT_NOT_FOUND_ERROR: 'Not found',
}));
vi.mock('@/src/lib/vault/errors', () => ({
  toVaultErrorResponse: (_error: unknown, error: string, status: number) =>
    new Response(JSON.stringify({ error }), { status }),
}));

const FIELD = `${GROUP_KEY_NAMESPACE}:did:imajin:group-test`;
// Generated test-only seed; neither snapshots nor assertion diagnostics print it.
const seed = randomBytes(32).toString('hex');
const mutationEdges = [
  mocks.fetchGrantSecret, mocks.loadAndUnseal, mocks.sealAndStore, mocks.sealAndStoreV2,
  mocks.rotateAndStore, mocks.eraseInactiveGrantKeyMaterial, mocks.deleteSecretAndRevokeGrants,
  mocks.update, mocks.insert, mocks.migrateCustody, mocks.publish,
];

function request(path: string, body: unknown, method = 'POST'): never {
  return new Request(`https://kernel.example/api/vault/${path}`, {
    method, body: JSON.stringify(body),
  }) as never;
}

async function expectPrivateRefusal(response: Response, status: number) {
  expect(response.status).toBe(status);
  const text = await response.text();
  // Fail with a constant message rather than printing the secret as an
  // expected/actual matcher argument if the non-disclosure invariant breaks.
  if (text.includes(seed)) throw new Error('Group key material disclosed in response');
  expect(text).not.toContain(FIELD);
  expect(JSON.stringify(mocks.log.mock.calls).includes(seed)).toBe(false);
  expect(mocks.log).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  for (const edge of mutationEdges) expect(edge).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue(true);
  mocks.requireAuth.mockResolvedValue({ identity: { id: 'did:imajin:grantee-test' } });
  mocks.getGrantById.mockResolvedValue({
    field: FIELD, oneTime: true, wrappedKey: seed, ownerSignature: seed,
  });
  mocks.loadAndUnseal.mockResolvedValue(seed);
  mocks.selectDistinct.mockReturnValue({ from: () => ({ where: mocks.rows }) });
  mocks.rows.mockResolvedValue([{ field: FIELD }]);
  mocks.selectLiveV1Fields.mockResolvedValue([{ field: FIELD }]);
  mocks.getNodeSigningIdentity.mockReturnValue({ senderDid: 'did:imajin:node-test' });
});

describe('group-key field grammar', () => {
  it('recognizes only the parsed exact namespace, with normal grammar trimming', () => {
    expect(GROUP_KEY_NAMESPACE).toBe('vault-group-key');
    expect(isGroupKeyField(` ${FIELD} `)).toBe(true);
    for (const field of ['vault-group-key', 'vault-group-key:', 'vault-group-key::bad',
      'vault-group-key-other:test', 'other:vault-group-key:test', 'VAULT-GROUP-KEY:test']) {
      expect(isGroupKeyField(field)).toBe(false);
    }
  });
});

describe('group-key plaintext HTTP surfaces', () => {
  it.each([true, false])('blocks fetch before decrypt or one-time consumption (grantee=%s)', async (isGrantee) => {
    if (!isGrantee) mocks.requireAuth.mockResolvedValue({ identity: { id: 'did:imajin:other-test' } });
    const { POST } = await import('../delegation/grants/[grantId]/fetch/route');
    const response = await POST(request('delegation/grants/test/fetch', {}), {
      params: Promise.resolve({ grantId: 'test-grant' }),
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expectPrivateRefusal(response, 403);
  });

  it('also blocks the auth-prefixed fetch alias', async () => {
    const { POST } = await import('@/app/auth/api/vault/delegation/grants/[grantId]/fetch/route');
    await expectPrivateRefusal(await POST(request('fetch', {}), {
      params: Promise.resolve({ grantId: 'test-grant' }),
    }), 403);
  });

  it('redacts metadata lookup errors before any decrypt or diagnostic logging', async () => {
    mocks.getGrantById.mockRejectedValue(new Error(seed));
    const { POST } = await import('../delegation/grants/[grantId]/fetch/route');
    await expectPrivateRefusal(await POST(request('fetch', {}), {
      params: Promise.resolve({ grantId: 'test-grant' }),
    }), 403);
  });

  it('omits group keys from rotation export without unsealing them', async () => {
    const { POST } = await import('../rotation-sweep/route');
    const response = await POST(request('rotation-sweep', { phase: 'export', newPublicKey: rotationPublicKey }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exported: 0, newPublicKey: rotationPublicKey });
    expect(mocks.loadAndUnseal).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('retains ordinary rotation exports alongside protected group keys', async () => {
    mocks.rows.mockResolvedValue([{ field: FIELD }, { field: 'GH_TOKEN' }]);
    const { POST } = await import('../rotation-sweep/route');
    const response = await POST(request('rotation-sweep', { phase: 'export', newPublicKey: rotationPublicKey }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ exported: 1, newPublicKey: rotationPublicKey });
    expect(mocks.loadAndUnseal.mock.calls.map(([field]) => field)).toEqual(['GH_TOKEN']);
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('rejects an entire mixed reimport batch before any ordinary field is written', async () => {
    const { POST } = await import('../rotation-sweep/route');
    await expectPrivateRefusal(await POST(request('rotation-sweep', {
      phase: 'reimport',
      fields: [{ field: 'GH_TOKEN', plaintext: seed }, { field: ` ${FIELD} `, plaintext: seed }],
    })), 403);
  });
});

describe('group-key generic custody mutation refusals', () => {
  const grantBody = {
    subject: 'did:imajin:group-test', grantedTo: 'did:imajin:grantee-test',
    ownerXPub: 'test-public-key', wrappedKey: seed, wrappedNonce: 'test-nonce',
    keyId: 'test-key', ownerSignature: seed,
  };
  it.each([
    ['set', () => import('../set/route'), { field: ` ${FIELD} `, value: seed }, 409],
    ['set v2', () => import('../set/route'), { field: FIELD, value: seed, custodyScheme: 'delegation-grant' }, 409],
    ['rotate', () => import('../rotate/route'), { field: ` ${FIELD} `, value: seed }, 409],
    ['upgrade-custody', () => import('../upgrade-custody/route'), { field: ` ${FIELD} ` }, 403],
    ['delegation/grant renewal', () => import('../delegation/grant/route'), { ...grantBody, field: FIELD }, 409],
    ['delegation/grant handshake', () => import('../delegation/grant/route'), { ...grantBody, field: FIELD, requestId: 'test-request' }, 409],
    ['delegation/revoke', () => import('../delegation/revoke/route'), { field: ` ${FIELD} ` }, 409],
    ['migrate-custody explicit', () => import('../migrate-custody/route'), { fields: ['GH_TOKEN', ` ${FIELD} `], dryRun: false }, 403],
    ['migrate-custody automatic', () => import('../migrate-custody/route'), { dryRun: false }, 403],
  ] as const)('%s refuses using field metadata only', async (path, load, body, status) => {
    const { POST } = await load();
    await expectPrivateRefusal(await POST(request(path, body)), status);
    expect(mocks.vaultGet).not.toHaveBeenCalled();
    expect(mocks.vaultPeek).not.toHaveBeenCalled();
    expect(mocks.getNodeSigningIdentity).not.toHaveBeenCalled();
  });

  it('refuses delete even when the caller confirms the exact field', async () => {
    const { DELETE } = await import('../delete/route');
    await expectPrivateRefusal(await DELETE(request('delete', { field: FIELD, confirmField: FIELD }, 'DELETE')), 409);
    expect(mocks.vaultPeek).not.toHaveBeenCalled();
  });
});

it('preserves admin grantee metadata visibility without unsealing', async () => {
  const grantees = [{ grantId: 'test-grant', grantedTo: 'did:imajin:grantee-test', purpose: 'group-signing' }];
  mocks.getRotateGranteeGuard.mockResolvedValue({ grantees, reissuedOnRotate: false });
  const { GET } = await import('../grantees/[field]/route');
  const response = await GET(request('grantees', {}), { params: Promise.resolve({ field: FIELD }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ field: FIELD, count: 1, grantees, reissuedOnRotate: false });
  expect(mocks.loadAndUnseal).not.toHaveBeenCalled();
  expect(mocks.fetchGrantSecret).not.toHaveBeenCalled();
});
