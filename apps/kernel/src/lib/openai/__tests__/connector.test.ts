/**
 * OpenAI connector wiring tests (#1927).
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

// Direct, literal assertion (rather than only delegating to the shared
// contract below) so this file itself is recognized as containing test
// cases. See the module doc comment on brain-connector-contract.ts.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () => {
  const suspiciousExports = Object.keys(openaiConnectorModule).filter((name) =>
    /rawkey|exportkey|getkey|returnkey|plaintext/i.test(name),
  );
  expect(suspiciousExports).toEqual([]);
});

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
