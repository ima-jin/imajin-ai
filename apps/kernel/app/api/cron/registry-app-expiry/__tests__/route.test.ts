import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ expire: vi.fn() }));
vi.mock('@/src/lib/apps/registry-app-expiry', () => ({ expireRegistryApps: h.expire }));
import { GET, dynamic } from '../route';
import { _resetCronSecretForTests, _setCronSecretForTests } from '@/src/cron/secret';

beforeEach(() => {
  vi.clearAllMocks();
  _setCronSecretForTests('fixture-cron-bearer');
  h.expire.mockResolvedValue({ checked: 35, expired: 35 });
});
afterEach(() => { _resetCronSecretForTests(); });

function request(authorization?: string) {
  return new Request('http://localhost/api/cron/registry-app-expiry', {
    headers: authorization ? { authorization } : {},
  });
}

describe('registry expiry cron boundary', () => {
  it.each([undefined, 'Bearer wrong', 'Basic fixture-cron-bearer'])('rejects unauthorized callers (%s) before reading registry', async bearer => {
    expect((await GET(request(bearer) as never)).status).toBe(401);
    expect(h.expire).not.toHaveBeenCalled();
  });
  it('fails closed when the vault cron secret is unavailable', async () => {
    _setCronSecretForTests(null);
    expect((await GET(request() as never)).status).toBe(503);
    expect(h.expire).not.toHaveBeenCalled();
  });
  it('returns the bounded expiry result and is never statically generated', async () => {
    const response = await GET(request('Bearer fixture-cron-bearer') as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, checked: 35, expired: 35 });
    expect(h.expire).toHaveBeenCalledOnce();
    expect(dynamic).toBe('force-dynamic');
  });
  it('redacts persistence/signing failures', async () => {
    h.expire.mockRejectedValue(new Error('private provider detail'));
    const response = await GET(request('Bearer fixture-cron-bearer') as never);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
