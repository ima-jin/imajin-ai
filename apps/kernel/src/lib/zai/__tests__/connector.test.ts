/**
 * Z.ai connector wiring tests (#1931).
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

const zaiConnectorModule = await import('../connector');
const {
  ZAI_CONNECTOR_DID,
  ZAI_CHANNEL,
  ZAI_INFER_SCOPE,
  ZAI_BASE_URL,
  vaultField,
  loadZaiCredentials,
  loadZaiSealedCredentials,
} = zaiConnectorModule;

// Direct, literal it() with a literal expect() on the helper's return value
// (see expectNoRawKeyLeak's doc comment) so Sonar S2699 recognizes this file
// as containing a real assertion.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () => {
  expect(expectNoRawKeyLeak(zaiConnectorModule)).toEqual([]);
});

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
