/**
 * `backfillContactEmail()` (#2058) — the shared-package client for the
 * kernel's `POST /auth/api/identity/:did/contact` endpoint. Mirrors
 * evaluate-eligibility.test.ts's approach: stub global fetch directly
 * rather than mocking fetch generically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AUTH_SERVICE_URL,
  INTERNAL_API_KEY as API_KEY,
  requestBody,
  setUpInternalPostEnv,
  tearDownInternalPostEnv,
} from './support/internal-post-test-env';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const DID = 'did:imajin:buyer';

beforeEach(setUpInternalPostEnv);
afterEach(tearDownInternalPostEnv);

describe('backfillContactEmail', () => {
  it('POSTs { email } to the DID-scoped route with a Bearer ATTESTATION_INTERNAL_API_KEY and returns the parsed result', async () => {
    const { backfillContactEmail } = await import('../src/backfill-contact-email');
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ did: DID, contactEmail: 'buyer@example.com', backfilled: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await backfillContactEmail(DID, 'buyer@example.com');

    expect(fetchMock).toHaveBeenCalledWith(
      `${AUTH_SERVICE_URL}/api/identity/${encodeURIComponent(DID)}/contact`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
      }),
    );
    expect(requestBody(fetchMock)).toEqual({ email: 'buyer@example.com' });
    expect(result).toEqual({ did: DID, contactEmail: 'buyer@example.com', backfilled: true });
  });

  it('returns null and warns without throwing when the kernel rejects the call', async () => {
    const { backfillContactEmail } = await import('../src/backfill-contact-email');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await backfillContactEmail(DID, 'buyer@example.com');

    expect(result).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ did: DID, status: 401 }),
      expect.any(String),
    );
  });

  it('returns null and logs an error when fetch itself throws', async () => {
    const { backfillContactEmail } = await import('../src/backfill-contact-email');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const result = await backfillContactEmail(DID, 'buyer@example.com');

    expect(result).toBeNull();
    expect(mocks.log.error).toHaveBeenCalled();
  });

  it('returns null without calling fetch when AUTH_SERVICE_URL is unset', async () => {
    delete process.env.AUTH_SERVICE_URL;
    const { backfillContactEmail } = await import('../src/backfill-contact-email');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await backfillContactEmail(DID, 'buyer@example.com');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when no internal API key is configured', async () => {
    delete process.env.ATTESTATION_INTERNAL_API_KEY;
    const { backfillContactEmail } = await import('../src/backfill-contact-email');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await backfillContactEmail(DID, 'buyer@example.com');

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
