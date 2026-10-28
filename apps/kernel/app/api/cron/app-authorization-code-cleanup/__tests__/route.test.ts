import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sweep: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/src/lib/auth/app-authorization-code-retention', () => ({
  sweepAppAuthorizationCodes: h.sweep,
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: h.info, error: h.error, warn: vi.fn() }),
}));

import { GET, dynamic } from '../route';
import { _resetCronSecretForTests, _setCronSecretForTests } from '@/src/cron/secret';

// Ephemeral fixture credentials, never copied from a live environment.
const credential = randomBytes(32).toString('hex');
function request(authorization?: string) {
  return new Request('http://localhost/api/cron/app-authorization-code-cleanup', {
    headers: authorization ? { authorization } : {},
  });
}

describe('app authorization code cleanup cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _setCronSecretForTests(credential);
    h.sweep.mockResolvedValue(0);
  });
  afterEach(() => { _resetCronSecretForTests(); });

  it('is never evaluated at build time', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it.each([undefined, 'Bearer invalid', 'Basic invalid'])('refuses an unauthorized caller (%s) without sweeping', async header => {
    const response = await GET(request(header) as never);
    expect(response.status).toBe(401);
    expect(h.sweep).not.toHaveBeenCalled();
  });

  it('fails closed when the vault cron secret is unavailable', async () => {
    _setCronSecretForTests(null);
    const response = await GET(request(`Bearer ${credential}`) as never);
    expect(response.status).toBe(503);
    expect(h.sweep).not.toHaveBeenCalled();
  });

  it.each([0, 2])('returns the deleted count (%s) for an authenticated sweep', async deleted => {
    h.sweep.mockResolvedValue(deleted);
    const response = await GET(request(`Bearer ${credential}`) as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted });
    expect(h.sweep).toHaveBeenCalledOnce();
    expect(h.sweep).toHaveBeenCalledWith();
    expect(h.info).toHaveBeenCalledWith({ deleted }, 'App authorization code cleanup sweep complete');
  });

  it('returns a generic error without exposing database error details in responses or logs', async () => {
    h.sweep.mockRejectedValue(new Error('injected database failure'));
    const response = await GET(request(`Bearer ${credential}`) as never);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(h.error).toHaveBeenCalledOnce();
    expect(h.error).toHaveBeenCalledWith({}, 'App authorization code cleanup sweep failed');
  });
});
