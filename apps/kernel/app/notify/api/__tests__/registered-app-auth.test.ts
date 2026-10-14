import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as send } from '../send/route';
import { POST as broadcast } from '../broadcast/route';
import { POST as interest } from '../interest/route';

const mocks = vi.hoisted(() => ({
  claims: vi.fn(),
  registration: vi.fn(),
  insert: vi.fn(),
  resolveScope: vi.fn(),
  audience: vi.fn(),
  emptyLimit: vi.fn(async () => []),
}));
vi.mock('@/src/lib/auth/jwt', () => ({ verifyAppToken: mocks.claims }));
vi.mock('@/src/lib/vault/internal-secret', () => ({
  getInternalSecret: async () => 'fake-vault-internal-key',
}));
vi.mock('@imajin/config', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
  buildPublicUrlAbsolute: () => 'https://kernel.test/notify',
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  withLogger: (_name: string, handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }),
}));
vi.mock('@/src/db', () => ({
  registryApps: { appDid: 'appDid' },
  notifications: {}, preferences: {}, identities: {}, profiles: {}, credentials: {},
  db: {
    select: () => ({
      from: (table: { appDid?: string }) => ({
        where: () => ({ limit: table?.appDid ? mocks.registration : mocks.emptyLimit }),
      }),
    }),
    insert: () => ({ values: mocks.insert }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock('@imajin/email', () => ({ sendEmail: vi.fn(), renderBroadcastEmail: vi.fn() }));
vi.mock('@/src/lib/notify/template-store', () => ({ getTemplate: async () => undefined }));
vi.mock('@/src/lib/notify/ws-push', () => ({
  buildNotificationFrame: () => ({}),
  pushNotificationToDid: async () => false,
}));
vi.mock('@/src/lib/notify/operator-approvals', () => ({
  OPERATOR_APPROVAL_REQUESTED_SCOPE: 'operator.approval.requested',
}));
vi.mock('@/src/lib/notify/operator-approvals-service', () => ({ recordApprovalRequested: vi.fn() }));
vi.mock('../interest/registry', () => ({
  resolveScopeForAttestation: mocks.resolveScope,
  didInterestExists: vi.fn(), createDidInterest: vi.fn(),
}));
vi.mock('../broadcast/registry', () => ({
  fetchAudienceFromRegistry: mocks.audience,
  checkRegistryPreferences: vi.fn(),
}));

const routes = [
  ['notify:send', send, { to: 'did:imajin:fake-recipient', scope: 'test.notification' }],
  ['notify:broadcast', broadcast, { scope: 'events', subject: 'Test', html: '<p>Test</p>' }],
  ['notify:interest', interest, { did: 'did:imajin:fake-recipient', attestationType: 'test.event' }],
] as const;
const appDid = 'did:imajin:fake-registered-app';
function request(body: unknown, credential = 'fake-app-service-token') {
  return new NextRequest('https://kernel.test/notify/api/test', {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NOTIFY_WEBHOOK_SECRET', '');
  mocks.insert.mockResolvedValue(undefined);
  mocks.resolveScope.mockResolvedValue(null);
  mocks.audience.mockResolvedValue([]);
});

afterEach(() => vi.unstubAllEnvs());

describe.each(routes)('%s actual POST authorization', (scope, handler, body) => {
  beforeEach(() => {
    mocks.claims.mockResolvedValue({ azp: appDid, scope, isServiceToken: true });
    mocks.registration.mockResolvedValue([{ status: 'active', approved: [scope] }]);
  });
  it('accepts a registered app holding only this endpoint scope', async () => {
    expect((await handler(request(body))).status).toBe(200);
    expect(mocks.registration).toHaveBeenCalledOnce();
  });
  it('keeps the vault internal Bearer path working without an app token', async () => {
    expect((await handler(request(body, 'fake-vault-internal-key'))).status).toBe(200);
    expect(mocks.claims).not.toHaveBeenCalled();
  });
  it('rejects a different notify scope even if it is operator approved', async () => {
    const differentScope = scope === 'notify:send' ? 'notify:broadcast' : 'notify:send';
    mocks.claims.mockResolvedValue({ azp: appDid, scope: differentScope, isServiceToken: true });
    mocks.registration.mockResolvedValue([{ status: 'active', approved: [differentScope] }]);
    expect((await handler(request(body))).status).toBe(403);
  });
  it('rejects an approval revoked after token mint', async () => {
    mocks.registration.mockResolvedValue([{ status: 'active', approved: [] }]);
    expect((await handler(request(body))).status).toBe(403);
  });
  it('rejects a revoked registration even before token expiry', async () => {
    mocks.registration.mockResolvedValue([{ status: 'revoked', approved: [scope] }]);
    expect((await handler(request(body))).status).toBe(403);
  });
  it('rejects user-delegated/session tokens even carrying the endpoint scope', async () => {
    mocks.claims.mockResolvedValue({ azp: appDid, scope, isServiceToken: false });
    expect((await handler(request(body))).status).toBe(403);
  });
  it('rejects expired/invalid Bearer tokens', async () => {
    mocks.claims.mockResolvedValue(null);
    expect((await handler(request(body))).status).toBe(401);
  });
  it('rejects the old webhook header instead of accepting a second auth lane', async () => {
    const req = request(body);
    req.headers.delete('authorization');
    req.headers.set('x-webhook-secret', 'fake-retired-key');
    expect((await handler(req)).status).toBe(401);
    expect(mocks.registration).not.toHaveBeenCalled();
  });
  it('accepts the configured rollout legacy lane only without Authorization', async () => {
    vi.stubEnv('NOTIFY_WEBHOOK_SECRET', 'fake-legacy-rollout-key');
    const req = request(body);
    req.headers.delete('authorization');
    req.headers.set('x-webhook-secret', 'fake-legacy-rollout-key');
    expect((await handler(req)).status).toBe(200);
    expect(mocks.claims).not.toHaveBeenCalled();
  });
  it('never downgrades rejected Bearer auth to a valid legacy credential', async () => {
    vi.stubEnv('NOTIFY_WEBHOOK_SECRET', 'fake-legacy-rollout-key');
    mocks.claims.mockResolvedValue(null);
    const req = request(body);
    req.headers.set('x-webhook-secret', 'fake-legacy-rollout-key');
    expect((await handler(req)).status).toBe(401);
  });

});
