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

// Direct, literal assertion (rather than only delegating to the shared
// contract below) so this file itself is recognized as containing test
// cases. See the module doc comment on brain-connector-contract.ts: the
// contract's own it()/describe() calls live in that shared file, not here.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () => {
  const suspiciousExports = Object.keys(zaiConnectorModule).filter((name) =>
    /rawkey|exportkey|getkey|returnkey|plaintext/i.test(name),
  );
  expect(suspiciousExports).toEqual([]);
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
