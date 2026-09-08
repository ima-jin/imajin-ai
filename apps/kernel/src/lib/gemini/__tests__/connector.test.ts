/**
 * Gemini connector wiring tests (#1432).
 *
 * Gemini predates `createConnectorTokenPaste` (#1621) being extracted into
 * its own factory, so — unlike OpenAI/xAI — this exercises the REAL
 * `resolveActiveGrant` / `sealApiKey` / `loadGeminiCredentials` /
 * `requireGrantAndKey` / `geminiKeySealed` / `geminiKeyPending` /
 * `revokeApiKey` against mocked vault/DB seams, rather than mocking the
 * factory itself. The whole contract — identity, the grant gate, the v1/v2
 * custody split, credential-resolution error handling, and the
 * `channel_links` sweep on disconnect — is shared with every other
 * vault/DB-backed token-paste connector; see
 * `describeConnectorCredentialLifecycleContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mock wiring and sample values live here.
 */
import { it } from 'vitest';
import {
  mockConnectorVaultAndDb,
  describeConnectorCredentialLifecycleContract,
  expectNoRawKeyLeak,
} from '@/src/lib/kernel/__tests__/brain-connector-contract';

const mocks = mockConnectorVaultAndDb();

const geminiConnectorModule = await import('../connector');
const {
  resolveActiveGrant,
  sealApiKey,
  loadGeminiCredentials,
  requireGrantAndKey,
  geminiKeySealed,
  geminiKeyPending,
  vaultField,
  revokeApiKey,
  GEMINI_CONNECTOR_DID,
  GEMINI_INFER_SCOPE,
} = geminiConnectorModule;

// Direct, literal it() (see expectNoRawKeyLeak's doc comment) so this file
// itself is recognized by Sonar S2187 as containing test cases.
it('never exports a function that could hand the raw key back to a caller (#1922 anti-goal)', () =>
  expectNoRawKeyLeak(geminiConnectorModule));

describeConnectorCredentialLifecycleContract({
  label: 'Gemini',
  id: 'gemini',
  connectorDid: GEMINI_CONNECTOR_DID,
  inferScope: GEMINI_INFER_SCOPE,
  vaultField,
  sampleApiKey: 'AIzaSy-REDACTED',
  sampleBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  sampleModelId: 'gemini-2.0-flash',
  resolveActiveGrant,
  sealApiKey,
  loadProviderCredentials: loadGeminiCredentials,
  requireGrantAndKey,
  keySealed: geminiKeySealed,
  keyPending: geminiKeyPending,
  revokeApiKey,
  mocks,
});
