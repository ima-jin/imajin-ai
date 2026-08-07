import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the nodemailer 6 -> 9 upgrade (#1566).
 *
 * The two high-severity advisories against nodemailer 6 (GHSA-rcmh-qjqh-p98v,
 * GHSA-p6gq-j5cr-w38f) have no 6.x patch, so the only fix is a three-major jump.
 * Nothing in majors 7/8/9 touches the plain SMTP path this package uses, but
 * "nothing touches it" is exactly the claim that needs a test: these cases pin
 * the transport options, the auth shape and the compiled RFC822 output so a
 * future bump that *does* move them fails here rather than in production SMTP.
 */

const HOST = 'smtp.example.com';
const USER = 'mailer';
const PASS = 'hunter2';
const FROM = 'Jin <jin@imajin.ai>';
const TO = 'someone@example.com';
const SUBJECT = 'Your invite';
const HTML = '<p>rich</p>';
const TEXT = 'plain';
const REPLY_TO = 'organizer@example.com';
const MESSAGE_ID = '<generated@imajin.ai>';
const UNSUBSCRIBE_URL = 'https://imajin.ai/u/abc';
const UNSUBSCRIBE_COMMENT = 'Unsubscribe from this mailing list';

const SMTP_ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'EMAIL_FROM'];

const { createTransport, sendMail } = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

// smtp.ts uses a default import, so the mock has to satisfy the CJS interop
// shape as well as the named export the type definitions advertise.
vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport,
}));

const ORIGINAL_ENV = { ...process.env };

function setSmtpEnv(overrides: Record<string, string>): void {
  for (const key of SMTP_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

/**
 * smtp.ts snapshots the SMTP_* variables into module-level constants at import
 * time, so each case needs a fresh module registry after touching the env.
 */
async function loadProvider() {
  vi.resetModules();
  const { SmtpProvider } = await import('../src/providers/smtp');
  return new SmtpProvider();
}

function configuredEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { SMTP_HOST: HOST, SMTP_USER: USER, SMTP_PASS: PASS, SMTP_FROM: FROM, ...extra };
}

/** RFC 5322 header unfolding, so folded long headers can be matched as one line. */
function unfold(raw: string): string {
  return raw.replaceAll('\n ', ' ');
}

beforeEach(() => {
  createTransport.mockReset();
  sendMail.mockReset();
  createTransport.mockReturnValue({ sendMail });
  sendMail.mockResolvedValue({ messageId: MESSAGE_ID });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('SmtpProvider transport construction', () => {
  it.each([
    ['SMTP_PASS', { SMTP_HOST: HOST, SMTP_USER: USER }],
    ['SMTP_USER', { SMTP_HOST: HOST, SMTP_PASS: PASS }],
    ['SMTP_HOST', { SMTP_USER: USER, SMTP_PASS: PASS }],
  ])('never opens a connection when %s is missing', async (_label, env) => {
    setSmtpEnv(env);
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result).toEqual({ success: false, error: 'SMTP not fully configured' });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('passes host, port and auth straight through to createTransport', async () => {
    setSmtpEnv(configuredEnv({ SMTP_PORT: '2525' }));
    const provider = await loadProvider();

    await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(createTransport).toHaveBeenCalledWith({
      host: HOST,
      port: 2525,
      secure: false,
      auth: { user: USER, pass: PASS },
    });
  });

  it('defaults to submission port 587 when SMTP_PORT is unset', async () => {
    setSmtpEnv(configuredEnv());
    const provider = await loadProvider();

    await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false }));
  });

  it('requests implicit TLS on port 465', async () => {
    setSmtpEnv(configuredEnv({ SMTP_PORT: '465' }));
    const provider = await loadProvider();

    await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 465, secure: true }));
  });
});

describe('SmtpProvider message building', () => {
  it('sends the message fields and returns the provider message id', async () => {
    setSmtpEnv(configuredEnv());
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML, text: TEXT, replyTo: REPLY_TO });

    expect(result).toEqual({ success: true, messageId: MESSAGE_ID });
    expect(sendMail).toHaveBeenCalledWith({
      from: FROM,
      to: TO,
      subject: SUBJECT,
      text: TEXT,
      html: HTML,
      replyTo: REPLY_TO,
    });
  });

  it('omits replyTo and list rather than sending undefined values', async () => {
    setSmtpEnv(configuredEnv());
    const provider = await loadProvider();

    await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    const message = sendMail.mock.calls[0][0];
    expect(message).not.toHaveProperty('replyTo');
    expect(message).not.toHaveProperty('list');
    expect(message.text).toBe('');
  });

  it('maps unsubscribeUrl onto the nodemailer list-header option', async () => {
    setSmtpEnv(configuredEnv());
    const provider = await loadProvider();

    await provider.send({ to: TO, subject: SUBJECT, html: HTML, unsubscribeUrl: UNSUBSCRIBE_URL });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        list: { unsubscribe: { url: UNSUBSCRIBE_URL, comment: UNSUBSCRIBE_COMMENT } },
      }),
    );
  });

  it('falls back to EMAIL_FROM when SMTP_FROM is unset', async () => {
    setSmtpEnv({ SMTP_HOST: HOST, SMTP_USER: USER, SMTP_PASS: PASS, EMAIL_FROM: FROM });
    const provider = await loadProvider();

    await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: FROM }));
  });

  it('reports a transport failure instead of throwing', async () => {
    setSmtpEnv(configuredEnv());
    const failure = new Error('550 mailbox unavailable');
    sendMail.mockRejectedValue(failure);
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result).toEqual({ success: false, error: failure });
  });
});

describe('nodemailer message contract', () => {
  /**
   * Runs the real (unmocked) nodemailer over the exact option shape SmtpProvider
   * builds. `createTransport`/`sendMail` and the `list.unsubscribe` option are
   * the surfaces this package depends on; if a future major renames or drops any
   * of them the compiled message below stops matching.
   */
  it('compiles the SmtpProvider option shape into the expected RFC822 headers', async () => {
    const nodemailer = await vi.importActual<typeof import('nodemailer')>('nodemailer');
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

    const info = await transporter.sendMail({
      from: FROM,
      to: TO,
      subject: SUBJECT,
      text: TEXT,
      html: HTML,
      replyTo: REPLY_TO,
      list: { unsubscribe: { url: UNSUBSCRIBE_URL, comment: UNSUBSCRIBE_COMMENT } },
    });

    const raw = unfold(String(info.message));

    expect(info.messageId).toMatch(/^<.+>$/);
    expect(raw).toContain(`From: ${FROM}`);
    expect(raw).toContain(`To: ${TO}`);
    expect(raw).toContain(`Reply-To: ${REPLY_TO}`);
    expect(raw).toContain(`Subject: ${SUBJECT}`);
    expect(raw).toContain(`List-Unsubscribe: <${UNSUBSCRIBE_URL}> (${UNSUBSCRIBE_COMMENT})`);
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain(TEXT);
    expect(raw).toContain(HTML);
  });
});
