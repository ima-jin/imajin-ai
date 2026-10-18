import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as send } from '../send/route';
import { POST as setup } from '../setup/route';

const mocks = vi.hoisted(() => ({
  mail: vi.fn(), credential: vi.fn(), session: vi.fn(), challenge: vi.fn(), store: vi.fn(),
}));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: mocks.mail }));
vi.mock('@/src/db', () => ({
  credentials: { did: 'did', type: 'type', value: 'value' },
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.credential }) }) }) },
}));
vi.mock('@/src/lib/auth/jwt', () => ({
  verifySessionToken: mocks.session, verifyMfaChallengeToken: mocks.challenge,
  getSessionCookieOptions: () => ({ name: 'imajin_session' }),
}));
vi.mock('@/src/lib/auth/email-mfa-codes', () => ({
  generateEmailMfaCode: () => '123456', storeEmailMfaCode: mocks.store,
}));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({}) }));
vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn() } }),
}));
function request(body: unknown = { challengeToken: 'challenge-fixture' }, cookie = true) {
  return new NextRequest('https://kernel.test/auth/api/mfa/email/send', {
    method: 'POST', headers: cookie ? { cookie: 'imajin_session=session-fixture' } : {},
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mail.mockResolvedValue({ success: true });
  mocks.credential.mockResolvedValue([{ value: 'verified@example.com' }]);
  mocks.session.mockResolvedValue({ sub: 'did:imajin:user' });
  mocks.challenge.mockResolvedValue({ sub: 'did:imajin:user', methods: ['email'] });
});

describe.each([['send', send], ['setup', setup]] as const)('MFA email %s kernel delivery', (_name, handler) => {
  it('uses signin purpose without letting recipient or body select a sender', async () => {
    const response = await handler(request({
      challengeToken: 'challenge-fixture', purpose: 'receipts', ownerDid: 'did:imajin:spoof', appDid: 'did:imajin:spoof',
    }));
    expect(response.status).toBe(200);
    expect(mocks.store).toHaveBeenCalledWith('did:imajin:user', '123456');
    expect(mocks.mail).toHaveBeenCalledWith({
      purpose: 'signin', to: 'verified@example.com', subject: 'Your Imajin verification code',
      html: expect.stringContaining('123456'), text: expect.stringContaining('123456'),
    });
  });
  it('retains non-fatal exception behavior', async () => {
    mocks.mail.mockRejectedValue(new Error('transport unavailable'));
    expect((await handler(request())).status).toBe(200);
  });
});
it('MFA send suppresses mail when no credential resolves', async () => {
  mocks.credential.mockResolvedValue([]);
  expect((await send(request())).status).toBe(200);
  expect(mocks.mail).not.toHaveBeenCalled();
});
it('MFA setup requires authentication', async () => {
  expect((await setup(request({}, false))).status).toBe(401);
  expect(mocks.mail).not.toHaveBeenCalled();
});
it('MFA setup rejects missing registered email', async () => {
  mocks.credential.mockResolvedValue([]);
  expect((await setup(request())).status).toBe(400);
  expect(mocks.mail).not.toHaveBeenCalled();
});
it('MFA send requires a valid email-enabled challenge', async () => {
  mocks.challenge.mockResolvedValue({ sub: 'did:imajin:user', methods: ['totp'] });
  expect((await send(request())).status).toBe(400);
  expect(mocks.mail).not.toHaveBeenCalled();
});
