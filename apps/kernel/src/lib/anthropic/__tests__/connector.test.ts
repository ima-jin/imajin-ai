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
import {
  mockConnectorVaultAndDb,
  describeConnectorCredentialLifecycleContract,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const mocks = mockConnectorVaultAndDb();

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
} = await import('../connector');

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
