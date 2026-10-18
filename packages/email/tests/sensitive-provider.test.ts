import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  fetch: vi.fn(), sendMail: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@imajin/logger', () => ({ createLogger: () => mock.log }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: mock.sendMail }) },
}));

const privateContent = 'https://kernel.example/auth/api/onboard/verify?token=test-fixture';
const options = { to: 'buyer@example.com', subject: 'Verify email', html: privateContent, sensitive: true };

async function provider(name: string) {
  if (name === 'postal') return new (await import('../src/providers/postal')).PostalProvider();
  if (name === 'smtp') return new (await import('../src/providers/smtp')).SmtpProvider();
  return new (await import('../src/providers/sendgrid')).SendGridProvider();
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mock.fetch);
  vi.stubEnv('SENDGRID_API_KEY', 'test-only-mail-fixture');
  vi.stubEnv('POSTAL_API_URL', 'https://postal.example');
  vi.stubEnv('POSTAL_API_KEY', 'test-only-mail-fixture');
  vi.stubEnv('SMTP_HOST', 'smtp.example');
  vi.stubEnv('SMTP_USER', 'test-mailer');
  vi.stubEnv('SMTP_PASS', 'test-only-mail-fixture');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(['sendgrid', 'postal', 'smtp'])('%s credential-mail logging', (name) => {
  it('never logs a transport exception that echoes the verification URL', async () => {
    const error = new Error(privateContent);
    mock.fetch.mockRejectedValue(error);
    mock.sendMail.mockRejectedValue(error);
    expect((await (await provider(name)).send(options)).success).toBe(false);
    expect(mock.log.error).toHaveBeenCalledWith({}, expect.any(String));
  });

  it('omits recipient and untrusted provider message IDs from success logs', async () => {
    mock.fetch.mockResolvedValue(name === 'postal'
      ? new Response(JSON.stringify({ status: 'success', data: { message_id: privateContent } }), { status: 200 })
      : new Response(null, { status: 202, headers: { 'x-message-id': privateContent } }));
    mock.sendMail.mockResolvedValue({ messageId: privateContent });
    expect((await (await provider(name)).send(options)).success).toBe(true);
    expect(mock.log.info).toHaveBeenCalledWith({}, expect.any(String));
  });

  it('redacts configuration-warning recipient fields', async () => {
    vi.stubEnv('SENDGRID_API_KEY', '');
    vi.stubEnv('POSTAL_API_KEY', '');
    vi.stubEnv('SMTP_PASS', '');
    expect((await (await provider(name)).send(options)).success).toBe(false);
    expect(mock.log.warn).toHaveBeenCalledWith({}, expect.any(String));
  });
});

it.each(['sendgrid', 'postal'])('logs only HTTP status for %s provider bodies echoing the magic link', async (name) => {
  mock.fetch.mockResolvedValue(new Response(privateContent, { status: 422 }));
  expect((await (await provider(name)).send(options)).success).toBe(false);
  expect(mock.log.error).toHaveBeenCalledWith({ status: 422 }, expect.any(String));
});

it('keeps normal SendGrid observability and unsubscribe headers unchanged', async () => {
  mock.fetch.mockResolvedValue(new Response('invalid recipient', { status: 422 }));
  const result = await (await provider('sendgrid')).send({
    ...options, sensitive: false, unsubscribeUrl: 'https://app.example/unsubscribe',
  });
  expect(result.success).toBe(false);
  expect(mock.log.error).toHaveBeenCalledWith({ status: 422, body: 'invalid recipient' }, 'SendGrid error');
  expect(JSON.parse(mock.fetch.mock.calls[0][1].body).headers).toEqual({
    'List-Unsubscribe': '<https://app.example/unsubscribe>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
});
