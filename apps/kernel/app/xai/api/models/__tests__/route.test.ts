/**
 * Tests for GET/PUT /xai/api/models (#1924).
 *
 * The route CONTRACT — auth, credential states, GET, PUT — is shared with
 * every OpenAI-compatible model picker; see `describeModelPickerRouteContract`
 * in `src/lib/kernel/__tests__/model-picker-route-test-support.ts` (#1927).
 * Only the provider-specific mock wiring lives here.
 */
import { vi } from 'vitest';
import { describeModelPickerRouteContract } from '@/src/lib/kernel/__tests__/model-picker-route-test-support';

const { mockResolveOwnerDid, mockLoadSealed, mockKeyPending, mockSetModelId } = vi.hoisted(() => ({
  mockResolveOwnerDid: vi.fn(),
  mockLoadSealed: vi.fn(),
  mockKeyPending: vi.fn(),
  mockSetModelId: vi.fn(),
}));

vi.mock('@/src/lib/kernel/connector-owner-did', () => ({
  resolveConnectorOwnerDid: mockResolveOwnerDid,
}));

vi.mock('@/src/lib/xai/connector', () => ({
  loadXaiSealedCredentials: mockLoadSealed,
  xaiKeyPending: mockKeyPending,
  setModelId: mockSetModelId,
  XAI_BASE_URL: 'https://api.x.ai/v1',
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://app.imajin.ai' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { GET, PUT, OPTIONS } from '../route';

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
