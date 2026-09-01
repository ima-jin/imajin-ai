/**
 * OpenAI connector wiring tests (#1927).
 *
 * The custody mechanics and the identity contract itself are shared with
 * every other token-paste connector — see `describeConnectorIdentityContract`
 * in `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mock wiring lives here.
 */
import { vi } from 'vitest';
import { describeConnectorIdentityContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, factoryStub, loadCredentials, loadSealedCredentials } = vi.hoisted(() => ({
  capturedOpts: { current: null as Record<string, unknown> | null },
  factoryStub: {} as Record<string, unknown>,
  loadCredentials: vi.fn(),
  loadSealedCredentials: vi.fn(),
}));

vi.mock('@/src/lib/kernel/connector-token-paste', () => ({
  createConnectorTokenPaste: vi.fn((opts: Record<string, unknown>) => {
    capturedOpts.current = opts;
    Object.assign(factoryStub, {
      vaultField: (did: string) => `${opts.id as string}-api-key:${did}`,
      sealApiKey: vi.fn(),
      resolveActiveGrant: vi.fn(),
      requireGrantAndKey: vi.fn(),
      keySealed: vi.fn(),
      keyPending: vi.fn(),
      revokeApiKey: vi.fn(),
      setModelId: vi.fn(),
      loadCredentials,
      loadSealedCredentials,
    });
    return factoryStub;
  }),
}));

import {
  OPENAI_CONNECTOR_DID,
  OPENAI_CHANNEL,
  OPENAI_INFER_SCOPE,
  OPENAI_BASE_URL,
  vaultField,
  loadOpenaiCredentials,
  loadOpenaiSealedCredentials,
} from '../connector';

describeConnectorIdentityContract({
  label: 'OpenAI',
  id: 'openai',
  connectorDid: OPENAI_CONNECTOR_DID,
  channel: OPENAI_CHANNEL,
  inferScope: OPENAI_INFER_SCOPE,
  baseUrl: OPENAI_BASE_URL,
  expectedBaseUrl: 'https://api.openai.com/v1',
  vaultField,
  capturedOpts,
  loadCredentials,
  loadSealedCredentials,
  loadProviderCredentials: loadOpenaiCredentials,
  loadProviderSealedCredentials: loadOpenaiSealedCredentials,
  sampleApiKey: 'sk-SEALED',
});
