/**
 * Anthropic connector wiring tests (#1621).
 *
 * Anthropic predates `createConnectorTokenPaste` being extracted into its
 * own factory, so — unlike OpenAI/xAI — this exercises the REAL
 * `resolveActiveGrant` / `sealApiKey` / `loadAnthropicCredentials` /
 * `requireGrantAndKey` / `anthropicKeySealed` / `anthropicKeyPending` /
 * `revokeApiKey` against mocked vault/DB seams, rather than mocking the
 * factory itself. The whole contract is shared with every other vault/DB-backed
 * token-paste connector (Gemini); see `describeConnectorCredentialLifecycleContract`
 * in `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mock wiring and sample values live here.
 */
import { it, expect } from 'vitest';
import {
  mockConnectorVaultAndDb,
  describeConnectorCredentialLifecycleContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const mocks = mockConnectorVaultAndDb();

const anthropicConnectorModule = await import('../connector');
const {
  resolveActiveGrant,
  sealApiKey,
  loadAnthropicCredentials,
  requireGrantAndKey,
  anthropicKeySealed,
  anthropicKeyPending,
  vaultField,
  revokeApiKey,
  ANTHROPIC_CONNECTOR_DID,
  ANTHROPIC_INFER_SCOPE,
} = anthropicConnectorModule;

// Direct, literal assertion (rather than only delegating to the shared
// contract below) so this file itself is recognized as containing test
// cases. See the module doc comment on brain-connector-contract.ts.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () => {
  const suspiciousExports = Object.keys(anthropicConnectorModule).filter((name) =>
    /rawkey|exportkey|getkey|returnkey|plaintext/i.test(name),
  );
  expect(suspiciousExports).toEqual([]);
});

describeConnectorCredentialLifecycleContract({
  label: 'Anthropic',
  id: 'anthropic',
  connectorDid: ANTHROPIC_CONNECTOR_DID,
  inferScope: ANTHROPIC_INFER_SCOPE,
  vaultField,
  sampleApiKey: 'sk-ant-REDACTED',
  sampleBaseUrl: 'https://my-gateway.example/anthropic',
  sampleModelId: 'claude-opus-4-20250514',
  resolveActiveGrant,
  sealApiKey,
  loadProviderCredentials: loadAnthropicCredentials,
  requireGrantAndKey,
  keySealed: anthropicKeySealed,
  keyPending: anthropicKeyPending,
  revokeApiKey,
  mocks,
});
