/**
 * Shared doubles for the kernel / pay-service seam of the route suites:
 *
 *   - `@/lib/kernel`  → `serviceUrl` (reads the live `serviceUrls` table below),
 *                       `getIdentityTier`, `isPodMember`
 *   - global `fetch`  → `fetchMock` (pay + chat service calls)
 *   - `PAY_SERVICE_API_KEY` env, captured by the settle route at import time
 *
 * Import this module BEFORE the route under test (vitest hoists the mocks and
 * ES imports evaluate in order). Use `resetKernelMocks()` from `beforeEach`.
 */
import { vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const payUrl = 'https://kernel.test/pay';
  const chatUrl = 'https://kernel.test/chat';
  const payApiKey = 'pay-api-key-fixture';
  process.env.PAY_SERVICE_API_KEY = payApiKey;

  return {
    payUrl,
    chatUrl,
    payApiKey,
    serviceUrls: { pay: payUrl, chat: chatUrl } as Record<string, string | null>,
    getIdentityTierMock: vi.fn(),
    isPodMemberMock: vi.fn(),
    fetchMock: vi.fn(),
  };
});

export const { payUrl, chatUrl, payApiKey, getIdentityTierMock, isPodMemberMock, fetchMock } = hoisted;

vi.mock('../../lib/pledge-pay-url', () => ({
  // A plain function (not a mock) so route modules can call it at import time.
  serviceUrl: (service: string) => hoisted.serviceUrls[service] ?? null,
  getIdentityTier: hoisted.getIdentityTierMock,
  isPodMember: hoisted.isPodMemberMock,
}));

vi.stubGlobal('fetch', fetchMock);

/** Point `serviceUrl('chat')` at a URL, or at nothing (`null`). */
export function setChatUrl(url: string | null): void {
  hoisted.serviceUrls.chat = url;
}

/** A real `Response` carrying a JSON body. */
export function jsonResponse(status: number, body: unknown = {}): Response {
  return Response.json(body, { status });
}

/** A real `Response` whose body is not JSON (so `.json()` rejects). */
export function textResponse(status: number, body: string, statusText: string): Response {
  return new Response(body, { status, statusText });
}

/** Restore the default kernel behaviour: chat configured, soft identities, non-members, fetch → 200. */
export function resetKernelMocks(): void {
  hoisted.serviceUrls.chat = chatUrl;
  getIdentityTierMock.mockReset().mockResolvedValue('soft');
  isPodMemberMock.mockReset().mockResolvedValue(false);
  fetchMock.mockReset().mockImplementation(async () => jsonResponse(200));
}
