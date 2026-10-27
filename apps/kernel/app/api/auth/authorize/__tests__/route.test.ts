import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  where: vi.fn(),
  auth: vi.fn(),
  validate: vi.fn(),
  upsert: vi.fn(),
  promote: vi.fn(),
  membership: vi.fn(),
  issue: vi.fn(),
}));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: h.where }) }) },
  registryApps: { id: 'id' },
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: h.auth,
  validateScopes: h.validate,
  resolveActingDid: (identity: { id: string; actingFor?: string; actingAs?: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
}));
vi.mock('@imajin/logger', () => ({
  withLogger: (_service: string, handler: unknown) => handler,
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/src/lib/auth/upsert-app-authorization', () => ({ upsertAppAuthorization: h.upsert }));
vi.mock('@/src/lib/auth/promote-actor', () => ({ promoteActorOnGrant: h.promote }));
vi.mock('@/src/lib/kernel/app-membership', () => ({ addConsentedApp: h.membership }));
vi.mock('@/src/lib/auth/app-authorization-code', () => ({ issueAppAuthorizationCode: h.issue }));

import { POST } from '../route';

const PERSONAL_DID = 'did:imajin:person';
const BUSINESS_DID = 'did:imajin:business';
const STATE = 's'.repeat(64);
const CODE = 'a'.repeat(64);
const APP = {
  id: 'app_test', slug: 'coffee', appDid: 'did:imajin:app',
  publicKey: 'a1'.repeat(32), status: 'active', requestedScopes: ['profile:read'],
  callbackUrl: 'https://app.example.test/callback', name: 'Test app', logoUrl: null,
  visibility: 'public',
};
function request(body: unknown = { appId: APP.id, scopes: ['profile:read'] }) {
  return new Request('https://kernel.test/api/auth/authorize', {
    method: 'POST', body: JSON.stringify({ state: STATE, ...(body as object) }),
  }) as never;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', 'test-private-key');
  h.auth.mockResolvedValue({ identity: { id: PERSONAL_DID } });
  h.where.mockResolvedValue([APP]);
  h.validate.mockImplementation((scopes: string[]) => ({ valid: scopes, invalid: [] }));
  h.upsert.mockResolvedValue('att_shared');
  h.issue.mockResolvedValue(CODE);
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /api/auth/authorize — shared consent seam (#3008)', () => {
  it('delegates validated scopes and returns the helper string ID', async () => {
    h.validate.mockReturnValue({ valid: ['profile:read'], invalid: [] });
    const response = await POST(request({ appId: APP.id, scopes: ['input-normalized-by-validator'] }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ redirect: `${APP.callbackUrl}?code=${CODE}&state=${STATE}` });
    expect(h.issue).toHaveBeenCalledWith({
      appDid: APP.appDid, subjectDid: PERSONAL_DID, attestationId: 'att_shared',
      callbackUrl: APP.callbackUrl, state: STATE,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.upsert).toHaveBeenCalledOnce();
    expect(h.upsert).toHaveBeenCalledWith({
      ownerDid: PERSONAL_DID, appDid: APP.appDid, appId: APP.id,
      callbackUrl: APP.callbackUrl, scopes: ['profile:read'], privateKey: 'test-private-key',
    });
    expect(h.promote).toHaveBeenCalledWith(expect.objectContaining({
      ownerDid: PERSONAL_DID, publicKey: APP.publicKey, adapter: 'keypair',
    }));
    expect(h.membership).toHaveBeenCalledWith(PERSONAL_DID, 'coffee');
  });

  it.each(['actingFor', 'actingAs'])('keeps consent under the session DID while promoting under %s', async (field) => {
    h.auth.mockResolvedValue({ identity: { id: PERSONAL_DID, [field]: BUSINESS_DID } });
    expect((await POST(request())).status).toBe(201);
    expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ ownerDid: PERSONAL_DID }));
    expect(h.promote).toHaveBeenCalledWith(expect.objectContaining({ ownerDid: BUSINESS_DID }));
    expect(h.membership).toHaveBeenCalledWith(PERSONAL_DID, APP.slug);
  });

  it('restores membership on repeat consent, using the same helper ID without route-level grant writes', async () => {
    for (let i = 0; i < 2; i++) {
      expect((await POST(request())).status).toBe(201);
    }
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(h.membership).toHaveBeenCalledTimes(2);
    expect(h.where).toHaveBeenCalledTimes(2); // registry only; live grants belong to the helper
  });

  it('does not publish membership or promote if the atomic grant fails', async () => {
    h.upsert.mockRejectedValueOnce(new Error('projection failed'));
    await expect(POST(request())).rejects.toThrow('projection failed');
    expect(h.membership).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated callers before any grant or lookup', async () => {
    h.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await POST(request())).status).toBe(401);
    expect(h.where).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [{ scopes: [] }, 400],
    [{ appId: APP.id, scopes: 'profile:read' }, 400],
  ])('rejects malformed input %j without consent', async (body, status) => {
    expect((await POST(request(body))).status).toBe(status);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON without consent', async () => {
    const response = await POST(new Request('https://kernel.test/api/auth/authorize', {
      method: 'POST', body: '{',
    }) as never);
    expect(response.status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('rejects unknown scopes without calling the helper', async () => {
    h.validate.mockReturnValue({ valid: [], invalid: ['bogus:scope'] });
    expect((await POST(request({ appId: APP.id, scopes: ['bogus:scope'] }))).status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('rejects valid but unregistered scopes without calling the helper', async () => {
    expect((await POST(request({ appId: APP.id, scopes: ['connections:read'] }))).status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it.each([['missing', [], 404], ['revoked', [{ ...APP, status: 'revoked' }], 403]] as const)(
    'rejects a %s app without calling the helper', async (_name, rows, status) => {
      h.where.mockResolvedValue(rows);
      expect((await POST(request())).status).toBe(status);
      expect(h.upsert).not.toHaveBeenCalled();
      expect(h.promote).not.toHaveBeenCalled();
    },
  );

  it('fails closed without a signing key', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await POST(request())).status).toBe(500);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it.each([null, '', 'short', 's'.repeat(257), 123])('rejects invalid state before issuing a grant', async state => {
    expect((await POST(request({ appId: APP.id, scopes: [], state }))).status).toBe(400);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('uses only the registry callback and authenticated subject when issuing', async () => {
    await POST(request({
      appId: APP.id, scopes: [], callbackUrl: 'https://other.test', subjectDid: BUSINESS_DID,
    }));
    expect(h.issue).toHaveBeenCalledWith(expect.objectContaining({
      callbackUrl: APP.callbackUrl, subjectDid: PERSONAL_DID,
    }));
  });
});
