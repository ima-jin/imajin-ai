/**
 * Tests for GET/PUT /openai/api/models (#1927).
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

vi.doMock('@/src/lib/openai/connector', () => ({
  loadOpenaiSealedCredentials: mockLoadSealed,
  openaiKeyPending: mockKeyPending,
  setModelId: mockSetModelId,
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
}));

const { GET, PUT, OPTIONS } = await import('../route');

describeModelPickerRouteContract({
  label: 'OpenAI',
  id: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  ownerDid: 'did:imajin:farmer',
  apiKey: 'sk-SEALED-KEY',
  sampleModelIds: ['gpt-5.5', 'gpt-5.6-sol'],
  deprecatedModelId: 'gpt-3',
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
