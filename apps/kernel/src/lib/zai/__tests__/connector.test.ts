/**
 * Z.ai connector wiring tests (#1931).
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

// Direct, literal it() (see expectNoRawKeyLeak's doc comment) so this file
// itself is recognized by Sonar S2187 as containing test cases.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () =>
  expectNoRawKeyLeak(zaiConnectorModule));

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
