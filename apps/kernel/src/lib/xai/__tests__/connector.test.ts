/**
 * xAI connector wiring tests (#1924).
 *
 * The custody mechanics, the identity contract, and the mock-setup
 * boilerplate are all shared with every other token-paste connector — see
 * `mockConnectorTokenPasteFactory` and `describeConnectorIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts` (#1927).
 */
import {
  mockConnectorTokenPasteFactory,
  describeConnectorIdentityContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, loadCredentials, loadSealedCredentials } = mockConnectorTokenPasteFactory();

const {
  XAI_CONNECTOR_DID,
  XAI_CHANNEL,
  XAI_INFER_SCOPE,
  XAI_BASE_URL,
  vaultField,
  loadXaiCredentials,
  loadXaiSealedCredentials,
} = await import('../connector');

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
