/**
 * OpenRouter connector wiring tests (#2188).
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

const openrouterConnectorModule = await import('../connector');
const {
  OPENROUTER_CONNECTOR_DID,
  OPENROUTER_CHANNEL,
  OPENROUTER_INFER_SCOPE,
  OPENROUTER_BASE_URL,
  vaultField,
  loadOpenrouterCredentials,
  loadOpenrouterSealedCredentials,
} = openrouterConnectorModule;

// Direct, literal it() with a literal expect() on the helper's return value
// (see expectNoRawKeyLeak's doc comment) so Sonar S2699 recognizes this file
// as containing a real assertion.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () => {
  expect(expectNoRawKeyLeak(openrouterConnectorModule)).toEqual([]);
});

describeConnectorIdentityContract({
  label: 'OpenRouter',
  id: 'openrouter',
  connectorDid: OPENROUTER_CONNECTOR_DID,
  channel: OPENROUTER_CHANNEL,
  inferScope: OPENROUTER_INFER_SCOPE,
  baseUrl: OPENROUTER_BASE_URL,
  expectedBaseUrl: 'https://openrouter.ai/api/v1',
  vaultField,
  capturedOpts,
  loadCredentials,
  loadSealedCredentials,
  loadProviderCredentials: loadOpenrouterCredentials,
  loadProviderSealedCredentials: loadOpenrouterSealedCredentials,
  sampleApiKey: 'sk-or-SEALED',
});
