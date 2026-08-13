import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the Postal 500 + missing-observability fix (#1847).
 *
 * Postal invite-email failures used to log `{ status, body }` with no
 * recipient, and a non-JSON Postal response (e.g. an HTML 502 page) made
 * `res.json()` fail silently, logging `body: null` instead of the actual
 * error payload. These cases pin the recipient in every error log and the
 * raw-text fallback when Postal's response body isn't valid JSON.
 */

const POSTAL_API_URL = 'https://postal.example.com';
const POSTAL_API_KEY = 'test-postal-key';
const TO = 'someone@example.com';
const SUBJECT = 'Your invite';
const HTML = '<p>rich</p>';

const POSTAL_ENV_KEYS = ['POSTAL_API_URL', 'POSTAL_API_KEY', 'POSTAL_FROM', 'EMAIL_FROM'];

const { fetchMock, logger } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => logger,
}));

const ORIGINAL_ENV = { ...process.env };

function setPostalEnv(overrides: Record<string, string> = {}): void {
  for (const key of POSTAL_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

/**
 * postal.ts snapshots POSTAL_API_URL/POSTAL_API_KEY/POSTAL_FROM into
 * module-level constants at import time, so each case needs a fresh module
 * registry after touching the env (same pattern as smtp-provider.test.ts).
 */
async function loadProvider() {
  vi.resetModules();
  const { PostalProvider } = await import('../src/providers/postal');
  return new PostalProvider();
}

beforeEach(() => {
  fetchMock.mockReset();
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('PostalProvider configuration guards', () => {
  it('skips the request when POSTAL_API_URL is unset', async () => {
    setPostalEnv({ POSTAL_API_KEY });
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result).toEqual({ success: false, error: 'POSTAL_API_URL not configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the request when POSTAL_API_KEY is unset', async () => {
    setPostalEnv({ POSTAL_API_URL });
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result).toEqual({ success: false, error: 'POSTAL_API_KEY not configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PostalProvider error handling (#1847)', () => {
  it('returns success and the Postal message id on a 200 success response', async () => {
    setPostalEnv({ POSTAL_API_URL, POSTAL_API_KEY });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'success', data: { message_id: 'msg_123' } }), { status: 200 }),
    );
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result).toEqual({ success: true, messageId: 'msg_123' });
  });

  it('includes the recipient address in the error log for a JSON error response', async () => {
    setPostalEnv({ POSTAL_API_URL, POSTAL_API_KEY });
    const errorBody = { status: 'error', message: 'invalid recipient' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(errorBody), { status: 422 }));
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result.success).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 422, to: TO, body: errorBody }),
      'Postal error',
    );
  });

  it('captures the raw text body and includes the recipient when Postal returns a non-JSON response', async () => {
    setPostalEnv({ POSTAL_API_URL, POSTAL_API_KEY });
    const rawHtml = '<html><body>502 Bad Gateway</body></html>';
    fetchMock.mockResolvedValue(new Response(rawHtml, { status: 502 }));
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result.success).toBe(false);
    expect(result.error).toContain(rawHtml);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 502, to: TO, body: rawHtml }),
      'Postal error',
    );
  });

  it('treats a 500 with an empty body as a failure and still logs the recipient', async () => {
    setPostalEnv({ POSTAL_API_URL, POSTAL_API_KEY });
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result.success).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 500, to: TO }),
      'Postal error',
    );
  });

  it('reports a network failure instead of throwing', async () => {
    setPostalEnv({ POSTAL_API_URL, POSTAL_API_KEY });
    const failure = new Error('fetch failed');
    fetchMock.mockRejectedValue(failure);
    const provider = await loadProvider();

    const result = await provider.send({ to: TO, subject: SUBJECT, html: HTML });

    expect(result).toEqual({ success: false, error: failure });
    expect(logger.error).toHaveBeenCalledWith({ err: String(failure) }, 'Postal send failed');
  });
});
