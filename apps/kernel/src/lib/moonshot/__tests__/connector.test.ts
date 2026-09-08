/**
 * Moonshot connector wiring tests (#1930).
 *
 * The custody mechanics, the identity contract, and the mock-setup
 * boilerplate are all shared with every other token-paste connector — see
 * `mockConnectorTokenPasteFactory` and `describeConnectorIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`.
 */
import { it, expect } from 'vitest';
import {
  mockConnectorTokenPasteFactory,
  describeConnectorIdentityContract,
  expectNoRawKeyLeak,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, loadCredentials, loadSealedCredentials } = mockConnectorTokenPasteFactory();

const moonshotConnectorModule = await import('../connector');
const {
  MOONSHOT_CONNECTOR_DID,
  MOONSHOT_CHANNEL,
  MOONSHOT_INFER_SCOPE,
  MOONSHOT_BASE_URL,
  vaultField,
  loadMoonshotCredentials,
  loadMoonshotSealedCredentials,
} = moonshotConnectorModule;

// Direct, literal it() with a literal expect() on the helper's return value
// (see expectNoRawKeyLeak's doc comment) so Sonar S2699 recognizes this file
// as containing a real assertion.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () => {
  expect(expectNoRawKeyLeak(moonshotConnectorModule)).toEqual([]);
});

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
