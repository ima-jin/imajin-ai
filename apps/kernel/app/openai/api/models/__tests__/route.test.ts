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
import { vi, it, expect } from 'vitest';
import {
  mockModelPickerRouteDeps,
  describeModelPickerRouteContract,
  expectSuccessfulGetCarriesCorsHeader,
} from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const openaiMockLoadSealed = vi.fn();
const openaiMockKeyPending = vi.fn();
const mockSetModelId = vi.fn();

const { resolveOwnerDid: openaiMockResolveOwnerDid } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/openai/connector', () => ({
  loadOpenaiSealedCredentials: openaiMockLoadSealed,
  openaiKeyPending: openaiMockKeyPending,
  setModelId: mockSetModelId,
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
}));

const { GET: openaiGet, PUT, OPTIONS } = await import('../route');

// Direct, literal it() with literal expect()s on the helper's return value
// (see expectSuccessfulGetCarriesCorsHeader's doc comment) so Sonar S2699
// recognizes this file as containing real assertions.
it('answers a successful GET with the shared CORS header attached', async () => {
  const result = await expectSuccessfulGetCarriesCorsHeader({
    GET: openaiGet, resolveOwnerDid: openaiMockResolveOwnerDid, loadSealedCredentials: openaiMockLoadSealed,
    keyPending: openaiMockKeyPending, apiKey: 'sk-SEALED-KEY',
  });
  expect(result.status).toBe(200);
  expect(result.corsOrigin).toBe('https://app.imajin.ai');
});

describeModelPickerRouteContract({
  label: 'OpenAI',
  id: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  ownerDid: 'did:imajin:farmer',
  apiKey: 'sk-SEALED-KEY',
  sampleModelIds: ['gpt-5.5', 'gpt-5.6-sol'],
  deprecatedModelId: 'gpt-3',
  GET: openaiGet,
  PUT,
  OPTIONS,
  mocks: {
    resolveOwnerDid: openaiMockResolveOwnerDid,
    loadSealed: openaiMockLoadSealed,
    keyPending: openaiMockKeyPending,
    setModelId: mockSetModelId,
  },
});
