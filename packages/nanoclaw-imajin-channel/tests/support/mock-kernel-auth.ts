import { vi } from 'vitest';

/**
 * Build a `fetch` mock that answers the kernel's two-step Ed25519
 * challenge-response handshake (`/auth/api/login/challenge` then
 * `/auth/api/login/verify`) and delegates every other URL to `onOtherRequest`.
 * Shared by tests exercising `authenticate()` indirectly (the channel
 * adapter, `sendChatMessage`) so the handshake fixture isn't repeated per file.
 */
export function mockKernelAuthFetch(
  onOtherRequest: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  sessionCookie = 'session=live; Path=/',
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/api/login/challenge')) {
      return new Response(JSON.stringify({ challengeId: 'c1', challenge: 'abcd' }), { status: 200 });
    }
    if (url.endsWith('/auth/api/login/verify')) {
      return new Response(null, { status: 200, headers: { 'set-cookie': sessionCookie } });
    }
    return onOtherRequest(url, init);
  });
}
