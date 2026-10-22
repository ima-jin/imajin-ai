import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), notify: vi.fn() }));
vi.mock('@/src/cron/auth', () => ({ requireCronAuth: mocks.auth }));
vi.mock('@/src/lib/notify/grant-expiry', () => ({ notifyExpiringOperatorGrants: mocks.notify }));
import { GET, dynamic } from '../route';
import { KERNEL_CRON_MANIFEST } from '@/src/cron/schedule';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(null);
});

describe('grant expiry scheduled notifications', () => {
  it.each([401, 503])('fails closed with cron auth status %s', async status => {
    mocks.auth.mockResolvedValue(Response.json({ error: 'Denied' }, { status }));
    expect((await GET(new Request('https://node.test/api/cron/grant-expiry'))).status).toBe(status);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('runs dynamically every ten minutes and reports the sweep', async () => {
    expect(dynamic).toBe('force-dynamic');
    expect(KERNEL_CRON_MANIFEST.jobs).toContainEqual({ path: '/api/cron/grant-expiry', schedule: '*/10 * * * *', noOverlap: true });
    mocks.notify.mockResolvedValue({ checked: 2, notified: 1 });
    const response = await GET(new Request('https://node.test/api/cron/grant-expiry'));
    expect(await response.json()).toEqual({ ok: true, checked: 2, notified: 1 });
  });
  it('reports failure without leaking underlying storage errors', async () => {
    mocks.notify.mockRejectedValue(new Error('private database detail'));
    const response = await GET(new Request('https://node.test/api/cron/grant-expiry'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Grant expiry notifications unavailable' });
  });
});
