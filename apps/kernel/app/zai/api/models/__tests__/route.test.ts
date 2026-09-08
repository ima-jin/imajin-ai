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
import { vi, it } from 'vitest';
import {
  mockModelPickerRouteDeps,
  describeModelPickerRouteContract,
  expectSuccessfulGetCarriesCorsHeader,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const zaiMockLoadSealed = vi.fn();
const zaiMockKeyPending = vi.fn();
const mockSetModelId = vi.fn();

const { resolveOwnerDid: zaiMockResolveOwnerDid } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/zai/connector', () => ({
  loadZaiSealedCredentials: zaiMockLoadSealed,
  zaiKeyPending: zaiMockKeyPending,
  setModelId: mockSetModelId,
  ZAI_BASE_URL: 'https://api.z.ai/api/paas/v4',
}));

const { GET: zaiGet, PUT, OPTIONS } = await import('../route');

// Direct, literal it() (see expectSuccessfulGetCarriesCorsHeader's doc
// comment) so this file itself is recognized by Sonar S2187.
it('answers a successful GET with the shared CORS header attached', () =>
  expectSuccessfulGetCarriesCorsHeader({
    GET: zaiGet, resolveOwnerDid: zaiMockResolveOwnerDid, loadSealedCredentials: zaiMockLoadSealed,
    keyPending: zaiMockKeyPending, apiKey: 'sk-SEALED-KEY',
  }));

describeModelPickerRouteContract({
  label: 'Z.ai',
  id: 'zai',
  baseUrl: 'https://api.z.ai/api/paas/v4',
  ownerDid: 'did:imajin:farmer',
  apiKey: 'sk-SEALED-KEY',
  sampleModelIds: ['glm-4.7', 'glm-4.6'],
  deprecatedModelId: 'glm-4.0-old',
  GET: zaiGet,
  PUT,
  OPTIONS,
  mocks: {
    resolveOwnerDid: zaiMockResolveOwnerDid,
    loadSealed: zaiMockLoadSealed,
    keyPending: zaiMockKeyPending,
    setModelId: mockSetModelId,
  },
});
