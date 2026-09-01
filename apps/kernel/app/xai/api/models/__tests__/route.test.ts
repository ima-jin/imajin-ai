/**
 * Tests for GET/PUT /xai/api/models (#1924).
 *
 * The route CONTRACT — auth, credential states, GET, PUT — and the
 * mock-setup boilerplate for the connector-agnostic dependencies
 * (auth, CORS, logger) are shared with every OpenAI-compatible model picker;
 * see `mockModelPickerRouteDeps` and `describeModelPickerRouteContract` in
 * `src/lib/kernel/__tests__/model-picker-route-test-support.ts` (#1927).
 * Only the provider-specific mock and route import live here.
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

vi.doMock('@/src/lib/xai/connector', () => ({
  loadXaiSealedCredentials: mockLoadSealed,
  xaiKeyPending: mockKeyPending,
  setModelId: mockSetModelId,
  XAI_BASE_URL: 'https://api.x.ai/v1',
}));

const { GET, PUT, OPTIONS } = await import('../route');

describeModelPickerRouteContract({
  label: 'xAI',
  id: 'xai',
  baseUrl: 'https://api.x.ai/v1',
  ownerDid: 'did:imajin:farmer',
  apiKey: 'xai-SEALED-KEY',
  sampleModelIds: ['grok-4', 'grok-4-fast'],
  deprecatedModelId: 'grok-1',
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
