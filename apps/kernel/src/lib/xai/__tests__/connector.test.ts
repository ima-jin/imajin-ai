/**
 * xAI connector wiring tests (#1924).
 *
 * The custody mechanics and the identity contract itself are shared with
 * every other token-paste connector — see `describeConnectorIdentityContract`
 * in `src/lib/kernel/__tests__/brain-connector-contract.ts` (#1927). Only the
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
  XAI_CONNECTOR_DID,
  XAI_CHANNEL,
  XAI_INFER_SCOPE,
  XAI_BASE_URL,
  vaultField,
  loadXaiCredentials,
  loadXaiSealedCredentials,
} from '../connector';

describeConnectorIdentityContract({
  label: 'xAI',
  id: 'xai',
  connectorDid: XAI_CONNECTOR_DID,
  channel: XAI_CHANNEL,
  inferScope: XAI_INFER_SCOPE,
  baseUrl: XAI_BASE_URL,
  expectedBaseUrl: 'https://api.x.ai/v1',
  vaultField,
  capturedOpts,
  loadCredentials,
  loadSealedCredentials,
  loadProviderCredentials: loadXaiCredentials,
  loadProviderSealedCredentials: loadXaiSealedCredentials,
  sampleApiKey: 'xai-SEALED',
});
