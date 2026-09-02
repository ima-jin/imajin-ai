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
import { vi } from 'vitest';
import {
  mockModelPickerRouteDeps,
  describeModelPickerRouteContract,
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
