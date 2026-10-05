import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

import { requireCronAuth } from '../auth';
import { _resetCronSecretForTests, _setCronSecretForTests } from '../secret';

const request = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/cron/anything', { headers });

describe('requireCronAuth (#2550 fail-closed)', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  afterEach(() => {
    _resetCronSecretForTests();
  });

  it('returns 503 and logs a WARN when the cron secret is unavailable', async () => {
    _setCronSecretForTests(null);
    const denied = await requireCronAuth(request({ authorization: 'Bearer whatever' }));
    expect(denied?.status).toBe(503);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockWarn.mock.calls[0])).toContain('/api/cron/anything');
  });

  it('returns 503 when the cron secret is the empty string', async () => {
    _setCronSecretForTests('');
    expect((await requireCronAuth(request()))?.status).toBe(503);
  });

  it('returns 401 for a missing Authorization header', async () => {
    _setCronSecretForTests('right-secret');
    expect((await requireCronAuth(request()))?.status).toBe(401);
  });

  it('returns 401 for a wrong bearer, including one of a different length', async () => {
    _setCronSecretForTests('right-secret');
    expect((await requireCronAuth(request({ authorization: 'Bearer wrong-secret' })))?.status).toBe(401);
    expect((await requireCronAuth(request({ authorization: 'Bearer x' })))?.status).toBe(401);
  });

  it('returns 401 when the scheme is not Bearer', async () => {
    _setCronSecretForTests('right-secret');
    expect((await requireCronAuth(request({ authorization: 'right-secret' })))?.status).toBe(401);
  });

  it('returns null (proceed) for the correct bearer', async () => {
    _setCronSecretForTests('right-secret');
    expect(await requireCronAuth(request({ authorization: 'Bearer right-secret' }))).toBeNull();
  });

  it('never reads the secret from process.env', async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'env-secret';
    try {
      _setCronSecretForTests(null);
      expect((await requireCronAuth(request({ authorization: 'Bearer env-secret' })))?.status).toBe(503);
    } finally {
      if (original === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = original;
    }
  });

  it('never puts the secret or the presented header in a log call or a response body', async () => {
    _setCronSecretForTests('super-secret-value');
    const wrong = await requireCronAuth(request({ authorization: 'Bearer presented-value' }));
    expect(await wrong?.text()).not.toMatch(/super-secret-value|presented-value/);

    _setCronSecretForTests(null);
    const unset = await requireCronAuth(request({ authorization: 'Bearer presented-value' }));
    expect(await unset?.text()).not.toContain('presented-value');
    expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/presented-value|super-secret-value/);
  });
});
