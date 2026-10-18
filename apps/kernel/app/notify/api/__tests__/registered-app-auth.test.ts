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
  mail: vi.fn(),
  template: vi.fn(),
  eligible: vi.fn(),
  payment: vi.fn(),
  emptyLimit: vi.fn<() => Promise<Record<string, unknown>[]>>(async () => []),
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
  paymentRequests: { id: 'paymentId' },
  notifications: {}, preferences: {}, identities: {}, profiles: {}, credentials: {},
  db: {
    select: () => ({
      from: (table: { appDid?: string; id?: string }) => ({
        where: () => ({ limit: table?.id === 'paymentId' ? mocks.payment : table?.appDid ? mocks.registration : mocks.emptyLimit }),
      }),
    }),
    insert: () => ({ values: mocks.insert }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: mocks.mail }));
vi.mock('@imajin/email', () => ({ renderBroadcastEmail: vi.fn() }));
vi.mock('@/src/lib/notify/template-store', () => ({ getTemplate: mocks.template }));
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
  checkRegistryPreferences: mocks.eligible,
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
  mocks.template.mockResolvedValue(undefined);
  mocks.mail.mockResolvedValue({ success: true });
  mocks.emptyLimit.mockResolvedValue([]);
  mocks.eligible.mockResolvedValue(true);
  mocks.payment.mockResolvedValue([]);
});

describe('mail sender propagation through actual notify routes', () => {
  beforeEach(() => {
    mocks.claims.mockResolvedValue({ azp: appDid, scope: 'notify:send notify:broadcast', isServiceToken: true });
    mocks.registration.mockResolvedValue([{
      status: 'active', approved: ['notify:send', 'notify:broadcast'], ownerDid: 'did:imajin:app-owner',
    }]);
    mocks.template.mockResolvedValue({
      urgency: 'normal', title: () => 'Receipt', body: () => 'Body',
      email: { subject: () => 'Receipt', html: () => '<p>Receipt</p>' },
    });
  });
  it.each([
    ['pay:payment_request-paid', 'receipts'],
    ['pay:payment_request-settled', 'receipts'],
    ['event:ticket-receipt', 'receipts'],
    ['custom:receipt', 'notifications'],
  ])('selects kernel purpose for %s and ignores injected owner/app/from/replyTo/purpose', async (scope, purpose) => {
    const res = await send(request({
      to: 'did:imajin:recipient', scope, purpose: 'signin', ownerDid: 'did:imajin:spoof',
      appDid: 'did:imajin:spoof', from: 'spoof@example.com', replyTo: 'spoof@example.com',
      data: { email: 'recipient@example.com', ownerDid: 'did:imajin:spoof', paymentRequestId: 'pr_spoof' },
    }));
    expect(res.status).toBe(200);
    expect(mocks.mail).toHaveBeenCalledWith({
      ownerDid: 'did:imajin:app-owner', appDid, purpose, messageRef: expect.stringMatching(/^ntf_/),
      to: 'recipient@example.com', subject: 'Receipt', html: '<p>Receipt</p>',
    });
  });
  it('keeps internal ordinary mail on the node default, never the recipient sender', async () => {
    await send(request({
      to: 'did:imajin:recipient', scope: 'custom:notice',
      ownerDid: 'did:imajin:spoof', data: { email: 'recipient@example.com' },
    }, 'fake-vault-internal-key'));
    const options = mocks.mail.mock.calls[0][0];
    expect(options.purpose).toBe('notifications');
    expect(options).not.toHaveProperty('ownerDid');
    expect(options).not.toHaveProperty('appDid');
  });
  it('resolves internal pay bus receipt sender from canonical issuer, not recipient or payload owner', async () => {
    mocks.payment.mockResolvedValue([{ issuerDid: 'did:imajin:issuer', recipientDid: 'did:imajin:recipient' }]);
    await send(request({
      to: 'did:imajin:recipient', scope: 'pay:payment_request-paid',
      data: { email: 'recipient@example.com', paymentRequestId: 'pr_test', ownerDid: 'did:imajin:spoof' },
    }, 'fake-vault-internal-key'));
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'receipts', ownerDid: 'did:imajin:issuer' }));
    expect(mocks.mail.mock.calls[0][0]).not.toHaveProperty('appDid');
  });
  it('binds broadcast to registry owner, fixes its purpose/from and forwards valid organizer replyTo', async () => {
    mocks.emptyLimit.mockResolvedValue([{ contactEmail: 'recipient@example.com' }]);
    const res = await broadcast(request({
      scope: 'pay:payment_request-paid', subject: 'Broadcast', html: '<p>Broadcast</p>',
      dids: ['did:imajin:recipient'], ownerDid: 'did:imajin:spoof', appDid: 'did:imajin:spoof',
      purpose: 'receipts', from: 'spoof@example.com', replyTo: 'organizer@example.org',
    }));
    expect(await res.json()).toMatchObject({ sent: 1, errors: 0 });
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({
      ownerDid: 'did:imajin:app-owner', appDid, purpose: 'notifications', to: 'recipient@example.com',
      replyTo: 'organizer@example.org',
    }));
    expect(mocks.mail.mock.calls[0][0]).not.toHaveProperty('from');
  });
  it('rejects broadcast reply-to header injection before any send', async () => {
    mocks.emptyLimit.mockResolvedValue([{ contactEmail: 'recipient@example.com' }]);
    const res = await broadcast(request({
      scope: 'events', subject: 'Broadcast', html: '<p>Broadcast</p>',
      dids: ['did:imajin:recipient'], replyTo: 'a@example.org\r\nBcc: victim',
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid reply-to' });
    expect(mocks.mail).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllEnvs());

describe.each(routes)('%s actual POST authorization', (scope, handler, body) => {
  beforeEach(() => {
    mocks.claims.mockResolvedValue({ azp: appDid, scope, isServiceToken: true });
    mocks.registration.mockResolvedValue([{ status: 'active', approved: [scope], ownerDid: 'did:imajin:app-owner' }]);
  });
  it('accepts a registered app holding only this endpoint scope', async () => {
    expect((await handler(request(body))).status).toBe(200);
    expect(mocks.registration).toHaveBeenCalledTimes(scope === 'notify:interest' ? 1 : 2);
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
