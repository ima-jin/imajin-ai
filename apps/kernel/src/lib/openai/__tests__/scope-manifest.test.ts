/**
 * OpenAI scope-manifest tests (#1927).
 *
 * The identity contract itself — every delegation into scope-manifest-core
 * must carry the OpenAI connector DID and channel — is shared with every
 * other token-paste connector; see `describeScopeManifestIdentityContract` in
 * `src/lib/kernel/__tests__/brain-connector-contract.ts`. Only the
 * provider-specific mock wiring lives here.
 */
import { vi } from 'vitest';
import { describeScopeManifestIdentityContract } from '@/src/lib/kernel/__tests__/brain-connector-contract';

const core = vi.hoisted(() => ({
  buildConnectorManifestContent: vi.fn(() => '---\nkind: scope-manifest\n---\n'),
  findConnectorManifestAsset: vi.fn(async () => null),
  readActiveConnectorScopes: vi.fn(async () => ['openai:infer']),
  syncConnectorConsentGrants: vi.fn(async () => undefined),
  publishConnectorScopeManifest: vi.fn(async () => 'asset_1'),
}));

vi.mock('@/src/lib/kernel/scope-manifest-core', () => core);

vi.mock('../connector', () => ({
  OPENAI_CONNECTOR_DID: 'did:imajin:openai-connector',
  OPENAI_CHANNEL: 'openai',
  openaiKeySealed: vi.fn(),
  openaiKeyPending: vi.fn(),
}));

import {
  OPENAI_SCOPE_DESCRIPTORS,
  VALID_OPENAI_SCOPES,
  buildManifestContent,
  findOpenaiManifestAsset,
  readActiveOpenaiScopes,
  syncConsentGrants,
  publishOpenaiScopeManifest,
} from '../scope-manifest';

describeScopeManifestIdentityContract({
  label: 'OpenAI',
  id: 'openai',
  connectorDid: 'did:imajin:openai-connector',
  channel: 'openai',
  inferScope: 'openai:infer',
  filename: 'openai-scope-manifest.md',
  core,
  scopeDescriptors: OPENAI_SCOPE_DESCRIPTORS,
  validScopes: VALID_OPENAI_SCOPES,
  buildManifestContent,
  findManifestAsset: findOpenaiManifestAsset,
  readActiveScopes: readActiveOpenaiScopes,
  syncConsentGrants,
  publishScopeManifest: publishOpenaiScopeManifest,
});
