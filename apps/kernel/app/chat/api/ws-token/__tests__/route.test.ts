import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@imajin/auth', async original => ({
  ...await original<typeof import('@imajin/auth')>(), requireAuth: auth,
}));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
import { GET } from '../route';
import { resolveWsToken } from '@/src/lib/chat/ws-tokens';
beforeEach(() => { auth.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });
it.each([undefined, 'did:imajin:org'])('binds the one-time token to acting identity %s, not the personal session', async actingAs => {
  auth.mockResolvedValue({ identity: { id: 'did:imajin:person', ...(actingAs ? { actingAs } : {}) } });
  const response = await GET(new NextRequest('http://localhost/chat/api/ws-token'));
  expect(response.status).toBe(200);
  const { token } = await response.json();
  expect(resolveWsToken(token)).toBe(actingAs ?? 'did:imajin:person');
  expect(resolveWsToken(token)).toBeNull();
});
it('does not mint a WS token without an authenticated identity', async () => {
  auth.mockResolvedValue({ error: 'Not authenticated', status: 401 });
  const response = await GET(new NextRequest('http://localhost/chat/api/ws-token'));
  expect(response.status).toBe(401);
  expect(await response.json()).not.toHaveProperty('token');
});
