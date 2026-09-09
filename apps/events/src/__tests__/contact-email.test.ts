/**
 * Tests for apps/events/src/lib/contact-email.ts (#2058).
 *
 * `backfillContactEmail` no longer writes `auth.identities` directly — it
 * delegates to the kernel's `POST /auth/api/identity/:did/contact` via the
 * `@imajin/auth` client (mocked here), mirroring how the check-in route
 * (#1999/#2053) delegates to `evaluateEligibility`. `getContactEmail` is
 * unaffected (still a direct read) and is covered too for completeness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  backfillContactEmailMock: vi.fn(),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@imajin/auth', () => ({
  backfillContactEmail: mocks.backfillContactEmailMock,
}));

import { getContactEmail, backfillContactEmail } from '../lib/contact-email';

function makeLog() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sqlMock.mockReset();
  mocks.backfillContactEmailMock.mockReset();
});

describe('getContactEmail', () => {
  it('returns the contact_email column for the DID', async () => {
    mocks.sqlMock.mockResolvedValueOnce([{ contact_email: 'buyer@example.com' }]);

    const result = await getContactEmail('did:imajin:buyer', makeLog());

    expect(result).toBe('buyer@example.com');
  });

  it('returns null and logs a warning when the query throws', async () => {
    mocks.sqlMock.mockRejectedValueOnce(new Error('db down'));
    const log = makeLog();

    const result = await getContactEmail('did:imajin:buyer', log);

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('backfillContactEmail (#2058 — delegates to the kernel route)', () => {
  it('calls the @imajin/auth client with the did and email, and never touches sql directly', async () => {
    mocks.backfillContactEmailMock.mockResolvedValueOnce({
      did: 'did:imajin:buyer',
      contactEmail: 'buyer@example.com',
      backfilled: true,
    });

    await backfillContactEmail('did:imajin:buyer', 'buyer@example.com', makeLog());

    expect(mocks.backfillContactEmailMock).toHaveBeenCalledWith('did:imajin:buyer', 'buyer@example.com');
    expect(mocks.sqlMock).not.toHaveBeenCalled();
  });

  it('logs a warning (non-fatal) when the kernel call fails, without throwing', async () => {
    mocks.backfillContactEmailMock.mockResolvedValueOnce(null);
    const log = makeLog();

    await expect(
      backfillContactEmail('did:imajin:buyer', 'buyer@example.com', log),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
