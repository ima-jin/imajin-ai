import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { KERNEL_CRON_MANIFEST } from '@/src/cron/schedule';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), sweep: vi.fn() }));
vi.mock('@/src/cron/auth', () => ({ requireCronAuth: mocks.auth }));
vi.mock('@/src/lib/notify/approval-expiry', () => ({ expireApprovals: mocks.sweep }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
import { GET, dynamic } from '../route';
const request = () => new NextRequest('http://localhost/api/cron/operator-approval-expiry');
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue(null); mocks.sweep.mockResolvedValue(3); });

describe('scheduled approval expiry', () => {
  it('runs dynamically on the pm2 scheduler every ten minutes with overlap protection', async () => {
    expect(dynamic).toBe('force-dynamic');
    expect(KERNEL_CRON_MANIFEST.jobs).toContainEqual({ path: '/api/cron/operator-approval-expiry', schedule: '*/10 * * * *', noOverlap: true });
    const response = await GET(request());
    expect(await response.json()).toEqual({ ok: true, expired: 3 });
  });
  it.each([401, 503])('preserves cron auth refusal %s before mutations', async status => {
    mocks.auth.mockResolvedValue(new Response(null, { status }));
    expect((await GET(request())).status).toBe(status);
    expect(mocks.sweep).not.toHaveBeenCalled();
  });
  it('sanitizes failures without claiming an unsigned success', async () => {
    mocks.sweep.mockRejectedValue(new Error('private detail'));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Approval expiry unavailable' });
  });
});
