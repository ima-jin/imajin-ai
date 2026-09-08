/**
 * Tests for GET/PUT /moonshot/api/models (#1930).
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

const mockLoadSealed = vi.fn();
const mockKeyPending = vi.fn();
const mockSetModelId = vi.fn();

const { resolveOwnerDid: mockResolveOwnerDid } = mockModelPickerRouteDeps();

vi.doMock('@/src/lib/moonshot/connector', () => ({
  loadMoonshotSealedCredentials: mockLoadSealed,
  moonshotKeyPending: mockKeyPending,
  setModelId: mockSetModelId,
  MOONSHOT_BASE_URL: 'https://api.moonshot.ai/v1',
}));

const { GET, PUT, OPTIONS } = await import('../route');

// Direct, literal it() (see expectSuccessfulGetCarriesCorsHeader's doc
// comment) so this file itself is recognized by Sonar S2187.
it('answers a successful GET with the shared CORS header attached', () =>
  expectSuccessfulGetCarriesCorsHeader({
    GET, resolveOwnerDid: mockResolveOwnerDid, loadSealedCredentials: mockLoadSealed,
    keyPending: mockKeyPending, apiKey: 'sk-SEALED-KEY',
  }));

describeModelPickerRouteContract({
  label: 'Moonshot AI',
  id: 'moonshot',
  baseUrl: 'https://api.moonshot.ai/v1',
  ownerDid: 'did:imajin:farmer',
  apiKey: 'sk-SEALED-KEY',
  sampleModelIds: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview'],
  deprecatedModelId: 'moonshot-v1-old',
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
