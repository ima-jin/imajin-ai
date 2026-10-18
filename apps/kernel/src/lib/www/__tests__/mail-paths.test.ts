import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as subscribe } from '@/app/api/subscribe/route';
import { POST as resend } from '@/app/api/admin/subscribers/[id]/resend-verify/route';
import { POST as newsletter } from '@/app/api/admin/newsletter/send/route';
import { subscribeEmailToMailingList } from '@/src/lib/auth/register';

const mocks = vi.hoisted(() => ({
  mail: vi.fn(), sql: vi.fn(), admin: vi.fn(), contact: vi.fn(), list: vi.fn(),
  subscription: vi.fn(), insert: vi.fn(), audience: vi.fn(), testRecipient: vi.fn(),
}));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: mocks.mail }));
vi.mock('@imajin/email', () => ({ renderBroadcastEmail: () => ({ html: '<p>Newsletter</p>', text: 'Newsletter' }) }));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.sql }));
vi.mock('@imajin/auth', () => ({ requireAdmin: mocks.admin }));
vi.mock('@/src/lib/auth/crypto', () => ({ verifySignature: vi.fn() }));
vi.mock('@/src/lib/kernel/utils', () => ({ generateId: () => 'id_fixture' }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@/src/lib/www/subscribe-tokens', () => ({
  generateVerifyToken: () => 'verify-fixture', verifyTokenExpiry: () => 9999, generateUnsubscribeToken: () => 'unsubscribe-fixture',
}));
vi.mock('@/src/lib/www/verify-email-template', () => ({
  verificationEmail: (url: string) => `<p>${url}</p>`, verificationEmailText: (url: string) => url,
}));
vi.mock('@/src/lib/admin/newsletter-send', () => ({
  resolveNewsletterAudience: mocks.audience, resolveTestRecipient: mocks.testRecipient,
}));
vi.mock('@imajin/config', () => ({ buildPublicUrlAbsolute: () => 'https://kernel.test' }));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
  withLogger: (_name: string, handler: (req: unknown, ctx: unknown) => unknown) =>
    (req: unknown) => handler(req, { log: { error: vi.fn() } }),
}));
vi.mock('@/src/db', () => ({
  mailingLists: { slug: 'slug' }, contacts: { email: 'email' }, subscriptions: { contactId: 'contactId' },
  db: {
    query: {
      mailingLists: { findFirst: mocks.list }, contacts: { findFirst: mocks.contact },
      subscriptions: { findFirst: mocks.subscription },
    },
    insert: () => ({ values: mocks.insert }),
  },
}));
function request(body: unknown) {
  return new NextRequest('https://kernel.test/api/subscribe', { method: 'POST', body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mail.mockResolvedValue({ success: true });
  mocks.admin.mockResolvedValue({ actingAs: 'did:imajin:operator' });
  mocks.list.mockResolvedValue({ id: 'list_fixture' });
  mocks.contact.mockResolvedValue({ id: 'contact_fixture', isVerified: false });
  mocks.subscription.mockResolvedValue({ status: 'subscribed' });
  mocks.sql.mockResolvedValue([{ id: 'contact_fixture', email: 'contact@example.com', is_verified: false }]);
  mocks.insert.mockResolvedValue(undefined);
  mocks.audience.mockResolvedValue({ ok: true, emails: ['one@example.com', 'two@example.com'], listSlug: 'updates' });
  mocks.testRecipient.mockResolvedValue('test@example.com');
});

describe('mailing list transport paths', () => {
  it('resends verification through contact purpose for a public subscriber', async () => {
    expect((await subscribe(request({ email: 'Contact@Example.com', purpose: 'signin', ownerDid: 'did:imajin:spoof' }))).status).toBe(200);
    expect(mocks.mail).toHaveBeenCalledWith({
      purpose: 'contact', to: 'contact@example.com', subject: 'Confirm your email — Imajin',
      html: expect.stringContaining('/api/subscribe/verify?'), text: expect.stringContaining('/api/subscribe/verify?'),
    });
  });
  it('does not send to already verified subscribers', async () => {
    mocks.contact.mockResolvedValue({ id: 'contact_fixture', isVerified: true });
    expect((await subscribe(request({ email: 'contact@example.com' }))).status).toBe(200);
    expect(mocks.mail).not.toHaveBeenCalled();
  });
  it('uses the same wrapper for registration opt-in without misattributing recipient as owner', async () => {
    subscribeEmailToMailingList('Contact@Example.com', 'did:imajin:recipient', 'https://kernel.test/auth/api/register');
    await vi.waitFor(() => expect(mocks.mail).toHaveBeenCalled());
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'contact', to: 'contact@example.com' }));
    expect(mocks.mail.mock.calls[0][0]).not.toHaveProperty('ownerDid');
  });
  it('uses contact purpose for an authorized admin verification resend', async () => {
    const response = await resend(request({}), { params: Promise.resolve({ id: 'contact_fixture' }) });
    expect(response.status).toBe(200);
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'contact', to: 'contact@example.com' }));
  });
  it('does not send admin resends without admin authorization', async () => {
    mocks.admin.mockResolvedValue(null);
    expect((await resend(request({}), { params: Promise.resolve({ id: 'contact_fixture' }) })).status).toBe(401);
    expect(mocks.mail).not.toHaveBeenCalled();
  });
  it('does not resend a verified contact', async () => {
    mocks.sql.mockResolvedValue([{ is_verified: true }]);
    expect((await resend(request({}), { params: Promise.resolve({ id: 'contact_fixture' }) })).status).toBe(400);
    expect(mocks.mail).not.toHaveBeenCalled();
  });
});
describe('newsletter transport paths', () => {
  const body = { subject: 'Update', markdown: 'Newsletter', audienceType: 'newsletter' };
  it('uses notifications for test sends', async () => {
    const response = await newsletter(request({ ...body, test: true, purpose: 'receipts', ownerDid: 'did:imajin:spoof' }));
    expect(await response.json()).toMatchObject({ sent: true, recipientCount: 1 });
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'notifications', to: 'test@example.com', subject: '[TEST] Update', html: '<p>Newsletter</p>',
    }));
    expect(mocks.mail.mock.calls[0][0]).not.toHaveProperty('ownerDid');
  });
  it('uses the wrapper for each batch recipient and preserves unsubscribe URLs', async () => {
    const response = await newsletter(request(body));
    expect(await response.json()).toMatchObject({ sent: true, recipientCount: 2 });
    await vi.waitFor(() => expect(mocks.mail).toHaveBeenCalledTimes(2));
    for (const [options] of mocks.mail.mock.calls) {
      expect(options).toMatchObject({ purpose: 'notifications', subject: 'Update', unsubscribeUrl: expect.stringContaining('/api/subscribe/unsubscribe?') });
    }
  });
  it('does not send without admin authorization', async () => {
    mocks.admin.mockResolvedValue(null);
    expect((await newsletter(request(body))).status).toBe(401);
    expect(mocks.mail).not.toHaveBeenCalled();
  });
});
