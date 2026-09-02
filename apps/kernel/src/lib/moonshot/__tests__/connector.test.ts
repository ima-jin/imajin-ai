/**
 * Moonshot connector wiring tests (#1930).
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
  MOONSHOT_CONNECTOR_DID,
  MOONSHOT_CHANNEL,
  MOONSHOT_INFER_SCOPE,
  MOONSHOT_BASE_URL,
  vaultField,
  loadMoonshotCredentials,
  loadMoonshotSealedCredentials,
} = await import('../connector');

describeConnectorIdentityContract({
  label: 'Moonshot AI',
  id: 'moonshot',
  connectorDid: MOONSHOT_CONNECTOR_DID,
  channel: MOONSHOT_CHANNEL,
  inferScope: MOONSHOT_INFER_SCOPE,
  baseUrl: MOONSHOT_BASE_URL,
  expectedBaseUrl: 'https://api.moonshot.ai/v1',
  vaultField,
  capturedOpts,
  loadCredentials,
  loadSealedCredentials,
  loadProviderCredentials: loadMoonshotCredentials,
  loadProviderSealedCredentials: loadMoonshotSealedCredentials,
  sampleApiKey: 'sk-SEALED',
});
