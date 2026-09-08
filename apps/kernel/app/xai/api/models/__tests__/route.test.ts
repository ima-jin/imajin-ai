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
import { vi, it } from 'vitest';
import {
  mockModelPickerRouteDeps,
  describeModelPickerRouteContract,
  expectSuccessfulGetCarriesCorsHeader,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const xaiMockLoadSealed = vi.fn();
const xaiMockKeyPending = vi.fn();
const mockSetModelId = vi.fn();

const { resolveOwnerDid: xaiMockResolveOwnerDid } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/xai/connector', () => ({
  loadXaiSealedCredentials: xaiMockLoadSealed,
  xaiKeyPending: xaiMockKeyPending,
  setModelId: mockSetModelId,
  XAI_BASE_URL: 'https://api.x.ai/v1',
}));

const { GET: xaiGet, PUT, OPTIONS } = await import('../route');

// Direct, literal it() (see expectSuccessfulGetCarriesCorsHeader's doc
// comment) so this file itself is recognized by Sonar S2187.
it('answers a successful GET with the shared CORS header attached', () =>
  expectSuccessfulGetCarriesCorsHeader({
    GET: xaiGet, resolveOwnerDid: xaiMockResolveOwnerDid, loadSealedCredentials: xaiMockLoadSealed,
    keyPending: xaiMockKeyPending, apiKey: 'xai-SEALED-KEY',
  }));

describeModelPickerRouteContract({
  label: 'xAI',
  id: 'xai',
  baseUrl: 'https://api.x.ai/v1',
  ownerDid: 'did:imajin:farmer',
  apiKey: 'xai-SEALED-KEY',
  sampleModelIds: ['grok-4', 'grok-4-fast'],
  deprecatedModelId: 'grok-1',
  GET: xaiGet,
  PUT,
  OPTIONS,
  mocks: {
    resolveOwnerDid: xaiMockResolveOwnerDid,
    loadSealed: xaiMockLoadSealed,
    keyPending: xaiMockKeyPending,
    setModelId: mockSetModelId,
  },
});
