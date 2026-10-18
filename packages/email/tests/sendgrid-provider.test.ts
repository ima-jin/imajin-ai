import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('SENDGRID_API_KEY', 'test-only-placeholder');
  vi.stubEnv('SENDGRID_FROM', 'Legacy <legacy@example.com>');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('SendGrid sender selection', () => {
  it.each([
    ['Signin <signin@imajin.ai>', { name: 'Signin', email: 'signin@imajin.ai' }],
    ['receipts@example.com', { email: 'receipts@example.com' }],
    [undefined, { name: 'Legacy', email: 'legacy@example.com' }],
  ])('honors sender %s or legacy fallback', async (from, expected) => {
    fetchMock.mockResolvedValue(new Response(null, { status: 202, headers: { 'x-message-id': 'msg_1' } }));
    const { SendGridProvider } = await import('../src/providers/sendgrid');
    const result = await new SendGridProvider().send({ to: 'to@example.com', subject: 'Subject', html: '<p>Body</p>', from });
    expect(result).toEqual({ success: true, messageId: 'msg_1' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).from).toEqual(expected);
  });
});
