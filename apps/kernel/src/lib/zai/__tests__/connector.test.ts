/**
 * Z.ai connector wiring tests (#1931).
 *
 * The custody mechanics, the identity contract, and the mock-setup
 * boilerplate are all shared with every other token-paste connector — see
 * `mockConnectorTokenPasteFactory` and `describeConnectorIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`.
 */
import {
  mockConnectorTokenPasteFactory,
  describeConnectorIdentityContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, loadCredentials, loadSealedCredentials } = mockConnectorTokenPasteFactory();

const {
  ZAI_CONNECTOR_DID,
  ZAI_CHANNEL,
  ZAI_INFER_SCOPE,
  ZAI_BASE_URL,
  vaultField,
  loadZaiCredentials,
  loadZaiSealedCredentials,
} = await import('../connector');

describeConnectorIdentityContract({
  label: 'Z.ai',
  id: 'zai',
  connectorDid: ZAI_CONNECTOR_DID,
  channel: ZAI_CHANNEL,
  inferScope: ZAI_INFER_SCOPE,
  baseUrl: ZAI_BASE_URL,
  expectedBaseUrl: 'https://api.z.ai/api/paas/v4',
  vaultField,
  capturedOpts,
  loadCredentials,
  loadSealedCredentials,
  loadProviderCredentials: loadZaiCredentials,
  loadProviderSealedCredentials: loadZaiSealedCredentials,
  sampleApiKey: 'sk-SEALED',
});
