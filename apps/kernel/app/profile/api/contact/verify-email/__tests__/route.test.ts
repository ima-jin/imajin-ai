import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), email: vi.fn(), store: vi.fn(), mail: vi.fn() }));
vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.auth, resolveActingDid: () => 'did:imajin:verified-owner',
}));
vi.mock('@/src/lib/mail/send', () => ({ sendKernelEmail: mocks.mail }));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: mocks.email, sealAndStore: mocks.store }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}) }));
vi.mock('@imajin/config', () => ({
  rateLimit: () => ({ limited: false }), getClientIP: () => '127.0.0.1',
  buildPublicUrlAbsolute: () => 'https://kernel.test',
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
function request() {
  return new NextRequest('https://kernel.test/profile/api/contact/verify-email', { method: 'POST' });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:verified-owner' } });
  mocks.email.mockResolvedValue('contact@example.com');
  mocks.store.mockResolvedValue(undefined);
  mocks.mail.mockResolvedValue({ success: true });
});
describe('contact verification through kernel mail', () => {
  it('uses contact purpose and the vault address without treating recipient as sender owner', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.email).toHaveBeenCalledWith('contact:email:did:imajin:verified-owner');
    expect(mocks.mail).toHaveBeenCalledWith({
      purpose: 'contact', to: 'contact@example.com', subject: 'Verify your email — Imajin',
      html: expect.stringContaining('/profile/api/contact/verify-email/confirm?'),
    });
  });
  it('reports provider refusal', async () => {
    mocks.mail.mockResolvedValue({ success: false, error: 'refused' });
    expect((await POST(request())).status).toBe(502);
  });
  it('does not send without authentication', async () => {
    mocks.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.mail).not.toHaveBeenCalled();
  });
  it('does not send without vault contact email', async () => {
    mocks.email.mockResolvedValue(undefined);
    expect((await POST(request())).status).toBe(400);
    expect(mocks.mail).not.toHaveBeenCalled();
  });
  it('does not send when nonce persistence fails', async () => {
    mocks.store.mockRejectedValue(new Error('store unavailable'));
    expect((await POST(request())).status).toBe(500);
    expect(mocks.mail).not.toHaveBeenCalled();
  });
});
