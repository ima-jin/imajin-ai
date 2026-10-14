import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { requireNotifyAuth, notifyRegistryKey } from '../service-auth';
import { SCOPE_VOCABULARY } from '@imajin/auth/scope-vocabulary';

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  app: vi.fn(),
  internalKey: vi.fn(),
}));
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: mocks.verify }));
vi.mock('@/src/lib/vault/internal-secret', () => ({ getInternalSecret: mocks.internalKey }));
vi.mock('@/src/db', () => ({
  registryApps: { appDid: 'appDid', status: 'status', approvedServiceScopes: 'approved' },
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.app }) }) }) },
}));

const scopes = ['notify:send', 'notify:broadcast', 'notify:interest'] as const;
const claims = { azp: 'did:imajin:fake-app', scope: scopes.join(' '), isServiceToken: true };
function request(token = 'fake-app-token') {
  return new NextRequest('https://kernel.test/notify/api/send', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue(claims);
  mocks.app.mockResolvedValue([{ status: 'active', approved: [...scopes] }]);
  mocks.internalKey.mockResolvedValue('fake-vault-internal-key');
});

describe.each(scopes)('%s auth', (scope) => {
  it('accepts an active registered app with token scope and live approval', async () => {
    expect(await requireNotifyAuth(request(), scope, {})).toBeNull();
    expect(mocks.app).toHaveBeenCalledOnce();
  });
  it('accepts the established vault internal Bearer without an app lookup', async () => {
    expect(await requireNotifyAuth(request('fake-vault-internal-key'), scope, {})).toBeNull();
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('rejects user/session app tokens', async () => {
    mocks.verify.mockResolvedValue({ ...claims, isServiceToken: false });
    expect((await requireNotifyAuth(request(), scope, {}))?.status).toBe(403);
  });
  it('rejects a missing scope before reading registry', async () => {
    mocks.verify.mockResolvedValue({ ...claims, scope: 'profile:read' });
    expect((await requireNotifyAuth(request(), scope, {}))?.status).toBe(403);
    expect(mocks.app).not.toHaveBeenCalled();
  });
  it.each([[], [{ status: 'revoked', approved: [...scopes] }], [{ status: 'active', approved: [] }]])(
    'rejects revoked/missing registrations or revoked approvals: %j', async (...rows) => {
      mocks.app.mockResolvedValue(rows);
      expect((await requireNotifyAuth(request(), scope, {}))?.status).toBe(403);
    },
  );
  it('rejects invalid/expired tokens', async () => {
    mocks.verify.mockResolvedValue(null);
    expect((await requireNotifyAuth(request(), scope, {}))?.status).toBe(401);
  });
});

it('rejects the retired webhook header and cookies without Bearer auth', async () => {
  const req = new NextRequest('https://kernel.test/notify/api/send', {
    headers: { 'x-webhook-secret': 'fake-old-key', cookie: 'imajin_session=fake-session' },
  });
  expect((await requireNotifyAuth(req, 'notify:send', {}))?.status).toBe(401);
});
it('fails closed when vault resolution fails and credential is invalid', async () => {
  mocks.internalKey.mockRejectedValue(new Error('vault unavailable'));
  mocks.verify.mockResolvedValue(null);
  expect((await requireNotifyAuth(request(), 'notify:send', {}))?.status).toBe(401);
});
it('resolves registry credentials itself rather than forwarding app credentials', async () => {
  expect(await notifyRegistryKey()).toBe('fake-vault-internal-key');
  expect(mocks.internalKey).toHaveBeenCalledWith('kernel.attestation-internal-api-key');
});
it('registers notify scopes without globally enabling self-requested service minting', () => {
  for (const scope of scopes) {
    const entry = SCOPE_VOCABULARY.find((entry) => entry.scope === scope);
    expect(entry).toBeDefined();
    expect('serviceEligible' in entry! && entry.serviceEligible).not.toBe(true);
  }
});
