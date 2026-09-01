/**
 * Tests for GET/PUT /openai/api/models (#1927).
 *
 * The route CONTRACT — auth, credential states, GET, PUT — is shared with
 * every OpenAI-compatible model picker; see `describeModelPickerRouteContract`
 * in `src/lib/kernel/__tests__/model-picker-route-test-support.ts`. Only the
 * provider-specific mock wiring lives here.
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

vi.mock('@/src/lib/openai/connector', () => ({
  loadOpenaiSealedCredentials: mockLoadSealed,
  openaiKeyPending: mockKeyPending,
  setModelId: mockSetModelId,
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
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
