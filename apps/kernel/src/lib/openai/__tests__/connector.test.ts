/**
 * OpenAI connector wiring tests (#1927).
 *
 * The custody mechanics, the identity contract, and the mock-setup
 * boilerplate are all shared with every other token-paste connector — see
 * `mockConnectorTokenPasteFactory` and `describeConnectorIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`.
 */
import { it } from 'vitest';
import {
  mockConnectorTokenPasteFactory,
  describeConnectorIdentityContract,
  expectNoRawKeyLeak,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, loadCredentials, loadSealedCredentials } = mockConnectorTokenPasteFactory();

const openaiConnectorModule = await import('../connector');
const {
  OPENAI_CONNECTOR_DID,
  OPENAI_CHANNEL,
  OPENAI_INFER_SCOPE,
  OPENAI_BASE_URL,
  vaultField,
  loadOpenaiCredentials,
  loadOpenaiSealedCredentials,
} = openaiConnectorModule;

// Direct, literal it() (see expectNoRawKeyLeak's doc comment) so this file
// itself is recognized by Sonar S2187 as containing test cases.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () =>
  expectNoRawKeyLeak(openaiConnectorModule));

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
