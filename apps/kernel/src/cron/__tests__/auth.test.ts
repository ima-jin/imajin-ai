import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

import { requireCronAuth } from '../auth';

const request = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/cron/anything', { headers });

describe('requireCronAuth (#2550 fail-closed)', () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    mockWarn.mockClear();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('returns 503 and logs a WARN when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const denied = requireCronAuth(request({ authorization: 'Bearer whatever' }));
    expect(denied?.status).toBe(503);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockWarn.mock.calls[0])).toContain('/api/cron/anything');
  });

  it('returns 503 when CRON_SECRET is the empty string', () => {
    process.env.CRON_SECRET = '';
    expect(requireCronAuth(request())?.status).toBe(503);
  });

  it('returns 401 for a missing Authorization header', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(requireCronAuth(request())?.status).toBe(401);
  });

  it('returns 401 for a wrong bearer, including one of a different length', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(requireCronAuth(request({ authorization: 'Bearer wrong-secret' }))?.status).toBe(401);
    expect(requireCronAuth(request({ authorization: 'Bearer x' }))?.status).toBe(401);
  });

  it('returns 401 when the scheme is not Bearer', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(requireCronAuth(request({ authorization: 'right-secret' }))?.status).toBe(401);
  });

  it('returns null (proceed) for the correct bearer', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(requireCronAuth(request({ authorization: 'Bearer right-secret' }))).toBeNull();
  });

  it('never puts the secret or the presented header in a log call or a response body', async () => {
    process.env.CRON_SECRET = 'super-secret-value';
    const wrong = requireCronAuth(request({ authorization: 'Bearer presented-value' }));
    expect(await wrong?.text()).not.toMatch(/super-secret-value|presented-value/);

    delete process.env.CRON_SECRET;
    const unset = requireCronAuth(request({ authorization: 'Bearer presented-value' }));
    expect(await unset?.text()).not.toContain('presented-value');
    expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/presented-value|super-secret-value/);
  });
});
