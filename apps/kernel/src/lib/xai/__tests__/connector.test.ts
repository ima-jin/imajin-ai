/**
 * xAI connector wiring tests (#1924).
 *
 * The custody mechanics, the identity contract, and the mock-setup
 * boilerplate are all shared with every other token-paste connector — see
 * `mockConnectorTokenPasteFactory` and `describeConnectorIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts` (#1927).
 */
import { it, expect } from 'vitest';
import {
  mockConnectorTokenPasteFactory,
  describeConnectorIdentityContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const { capturedOpts, loadCredentials, loadSealedCredentials } = mockConnectorTokenPasteFactory();

const xaiConnectorModule = await import('../connector');
const {
  XAI_CONNECTOR_DID,
  XAI_CHANNEL,
  XAI_INFER_SCOPE,
  XAI_BASE_URL,
  vaultField,
  loadXaiCredentials,
  loadXaiSealedCredentials,
} = xaiConnectorModule;

// Direct, literal assertion (rather than only delegating to the shared
// contract below) so this file itself is recognized as containing test
// cases. See the module doc comment on brain-connector-contract.ts.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () => {
  const suspiciousExports = Object.keys(xaiConnectorModule).filter((name) =>
    /rawkey|exportkey|getkey|returnkey|plaintext/i.test(name),
  );
  expect(suspiciousExports).toEqual([]);
});

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
