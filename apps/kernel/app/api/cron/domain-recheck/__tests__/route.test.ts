import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), recheck: vi.fn() }));
vi.mock('@/src/cron/auth', () => ({ requireCronAuth: mocks.auth }));
vi.mock('@/src/lib/domains/service', () => ({ recheckDomains: mocks.recheck }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }));
import { GET, dynamic } from '../route';
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue(null); });
it('uses request-time rendering and the shared fail-closed cron authenticator', async () => {
  expect(dynamic).toBe('force-dynamic');
  const denied = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  mocks.auth.mockResolvedValue(denied);
  expect(await GET(new NextRequest('http://localhost/api/cron/domain-recheck'))).toBe(denied);
  expect(mocks.recheck).not.toHaveBeenCalled();
});
it('returns bounded recheck results only after authorization', async () => {
  mocks.recheck.mockResolvedValue({ checked: 4, revoked: 1, failed: 0 });
  expect(await (await GET(new NextRequest('http://localhost/api/cron/domain-recheck'))).json())
    .toEqual({ ok: true, checked: 4, revoked: 1, failed: 0 });
});
it('never leaks internal errors', async () => {
  mocks.recheck.mockRejectedValue(new Error('private credential'));
  const result = await GET(new NextRequest('http://localhost/api/cron/domain-recheck'));
  expect(result.status).toBe(500);
  expect(await result.text()).not.toContain('private credential');
});
