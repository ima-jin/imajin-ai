import { beforeEach, expect, it, vi } from 'vitest';
import { DatabaseTimeoutError } from '../../../../../../../packages/db/src/bounds';

const { resolveSession } = vi.hoisted(() => ({ resolveSession: vi.fn() }));
vi.mock('@/src/lib/auth/session-resolver', () => ({ resolveKernelSession: resolveSession }));
vi.mock('@/src/lib/auth/jwt', () => ({ getSessionCookieOptions: () => ({ name: 'session' }) }));
vi.mock('@/src/lib/auth/session-cookie', () => ({ withSessionCookie: (response: Response) => response }));
vi.mock('@imajin/config', () => ({ corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.test' }) }));
vi.mock('@imajin/logger', () => ({
  withLogger: (_name: string, handler: (request: unknown, ctx: unknown) => unknown) =>
    (request: unknown) => handler(request, { log: { error: vi.fn() } }),
}));

import { GET } from '../route';
const request = (present = true) => ({
  cookies: { get: () => present ? { value: 'fixture-session' } : undefined },
}) as never;
beforeEach(() => { resolveSession.mockReset(); });

it.each(['DB_ACQUIRE_TIMEOUT', 'DB_QUERY_TIMEOUT'] as const)('returns 503 and Retry-After: 5 on %s', async code => {
  resolveSession.mockRejectedValue(new Error('wrapped query', { cause: new DatabaseTimeoutError(code) }));
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('5');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.test');
  expect(response.headers.get('Set-Cookie')).toBeNull();
});

it('preserves generic errors as 500 without Retry-After', async () => {
  resolveSession.mockRejectedValue(new Error('other failure'));
  const response = await GET(request());
  expect(response.status).toBe(500);
  expect(response.headers.get('Retry-After')).toBeNull();
});

it('preserves unauthenticated and invalid-session refusals', async () => {
  expect((await GET(request(false))).status).toBe(401);
  expect(resolveSession).not.toHaveBeenCalled();
  resolveSession.mockResolvedValue({ error: 'Invalid or expired session' });
  const response = await GET(request());
  expect(response.status).toBe(401);
  expect(response.headers.get('Retry-After')).toBeNull();
});

it.each(['did:imajin:personal', 'did:imajin:org'])('preserves resolved identity %s', async did => {
  resolveSession.mockResolvedValue({ data: { did, handle: 'fixture' } });
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ did, handle: 'fixture' });
});
