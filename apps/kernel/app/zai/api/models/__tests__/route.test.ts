/**
 * Tests for GET/PUT /zai/api/models (#1931).
 *
 * The route CONTRACT — auth, credential states, GET, PUT — and the
 * mock-setup boilerplate for the connector-agnostic dependencies
 * (auth, CORS, logger) are shared with every OpenAI-compatible model picker;
 * see `mockModelPickerRouteDeps` and `describeModelPickerRouteContract` in
 * `src/lib/kernel/__tests__/model-picker-route-test-support.ts`. Only the
 * provider-specific mock and route import live here.
 */
import { vi, it, expect } from 'vitest';
import {
  mockModelPickerRouteDeps,
  describeModelPickerRouteContract,
  makeModelPickerRequest,
  stubModelPickerFetch,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const mockLoadSealed = vi.fn();
const mockKeyPending = vi.fn();
const mockSetModelId = vi.fn();

const { resolveOwnerDid: mockResolveOwnerDid } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/zai/connector', () => ({
  loadZaiSealedCredentials: mockLoadSealed,
  zaiKeyPending: mockKeyPending,
  setModelId: mockSetModelId,
  ZAI_BASE_URL: 'https://api.z.ai/api/paas/v4',
}));

const { GET, PUT, OPTIONS } = await import('../route');

// Direct, literal assertion (rather than only delegating to the shared
// contract below) so this file itself is recognized as containing test
// cases. See the module doc comment on model-picker-route-test-support.ts.
// Also a real gap the contract doesn't cover: it only asserts status/body,
// never that the shared CORS header actually reaches a non-OPTIONS response.
it('answers a successful GET with the shared CORS header attached', async () => {
  mockResolveOwnerDid.mockResolvedValueOnce({ ok: true, ownerDid: 'did:imajin:farmer' });
  mockLoadSealed.mockResolvedValueOnce({ apiKey: 'sk-SEALED-KEY' });
  mockKeyPending.mockResolvedValueOnce(false);
  stubModelPickerFetch({ data: [] });

  const res = await GET(makeModelPickerRequest());

  expect(res.status).toBe(200);
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.imajin.ai');
});

describeModelPickerRouteContract({
  label: 'Z.ai',
  id: 'zai',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  ownerDid: 'did:imajin:farmer',
  apiKey: 'sk-SEALED-KEY',
  sampleModelIds: ['glm-4.7', 'glm-4.6'],
  deprecatedModelId: 'glm-4.0-old',
  GET,
  PUT,
  OPTIONS,
  mocks: {
    resolveOwnerDid: mockResolveOwnerDid,
    loadSealed: mockLoadSealed,
    keyPending: mockKeyPending,
    setModelId: mockSetModelId,
  },
});
