import { describe, it, expect } from 'vitest';
import {
  GRANT_SCOPE_REGISTRY,
  GRANT_SCOPE_GRAMMAR,
  isKnownGrantScope,
  grantScopeEntry,
  allGrantScopes,
  validateGrantCapabilities,
  eventTypesForGrantScopes,
  ATTEST_DELEGATION_PREFIX,
  buildAttestDelegationCapability,
  parseAttestDelegationCapability,
} from '../src/grant-scopes';

const MCP_PROMOTED_SCOPES = [
  'media:read', 'media:write', 'media:share',
  'connections:read',
  'messages:read', 'messages:write',
  'github:read', 'github:write', 'github:org', 'github:actions',
  'warp:dispatch',
  'discovery:read',
  'inference:read', 'inference:write',
  'corpus:read', 'corpus:write',
];

// #2059 adds 'operator:approvals' as a 4th kernel extension, alongside the
// original 3 from #1882; #2204 adds 'usage:read' as a 5th (the auditor
// chain-view capability); #2251 adds 'agent:reach' as a 6th (per-principal
// agent-reach authority); #2358 adds 'loops:publish' as a 7th (publisher
// authorization for the loop registry rail).
const KERNEL_EXTENSION_SCOPES = [
  'intros:propose',
  'events:read',
  'contacts:read',
  'operator:approvals',
  'usage:read',
  'agent:reach',
  'loops:publish',
];

describe('GRANT_SCOPE_REGISTRY structure', () => {
  it('promotes exactly the 16 named MCP scopes plus the kernel extensions (#1882, #2059, #2204, #2251, #2358)', () => {
    expect(MCP_PROMOTED_SCOPES).toHaveLength(16);
    expect(allGrantScopes()).toEqual([...MCP_PROMOTED_SCOPES, ...KERNEL_EXTENSION_SCOPES]);
  });

  it('has no duplicate scope strings', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of GRANT_SCOPE_REGISTRY) {
      if (seen.has(entry.scope)) duplicates.push(entry.scope);
      seen.add(entry.scope);
    }
    expect(duplicates).toEqual([]);
  });

  it('uses `domain:verb`-shaped scope strings', () => {
    const malformed = GRANT_SCOPE_REGISTRY.map((e) => e.scope).filter((s) => !GRANT_SCOPE_GRAMMAR.test(s));
    expect(malformed).toEqual([]);
  });

  it('rejects a scope string that encodes a resource (no third segment, no wildcard)', () => {
    expect(GRANT_SCOPE_GRAMMAR.test('messages:write:did:imajin:xyz')).toBe(false);
    expect(GRANT_SCOPE_GRAMMAR.test('messages:*')).toBe(false);
    expect(GRANT_SCOPE_GRAMMAR.test('*:*')).toBe(false);
  });

  it('gives every entry an array (possibly empty) of entitled event types for #1884', () => {
    for (const entry of GRANT_SCOPE_REGISTRY) {
      expect(Array.isArray(entry.eventTypes)).toBe(true);
    }
  });

  it('tags each entry with its origin', () => {
    for (const scope of MCP_PROMOTED_SCOPES) {
      expect(grantScopeEntry(scope)?.origin).toBe('mcp');
    }
    for (const scope of KERNEL_EXTENSION_SCOPES) {
      expect(grantScopeEntry(scope)?.origin).toBe('kernel');
    }
  });
});

describe('isKnownGrantScope / grantScopeEntry', () => {
  it('resolves known scopes and rejects unknown ones', () => {
    expect(isKnownGrantScope('messages:write')).toBe(true);
    expect(isKnownGrantScope('messages:destroy')).toBe(false);
    expect(grantScopeEntry('messages:write')?.scope).toBe('messages:write');
    expect(grantScopeEntry('nope:nope')).toBeUndefined();
  });

  it('is a closed vocabulary: scopes outside the registry are never valid, even if grammatically well-formed', () => {
    expect(GRANT_SCOPE_GRAMMAR.test('supply:read')).toBe(true);
    expect(isKnownGrantScope('supply:read')).toBe(false);
  });
});

describe('validateGrantCapabilities', () => {
  it('splits known and unknown capabilities', () => {
    const { valid, invalid } = validateGrantCapabilities(['messages:write', 'intros:propose', 'bogus:scope']);
    expect(valid).toEqual(['messages:write', 'intros:propose']);
    expect(invalid).toEqual(['bogus:scope']);
  });

  it('accepts every registry scope', () => {
    const { valid, invalid } = validateGrantCapabilities(allGrantScopes());
    expect(invalid).toEqual([]);
    expect(valid).toHaveLength(GRANT_SCOPE_REGISTRY.length);
  });
});

describe('eventTypesForGrantScopes', () => {
  it('unions and dedupes event types across capabilities', () => {
    const eventTypes = eventTypesForGrantScopes(['inference:read', 'inference:write']);
    expect(eventTypes).toEqual(['attestation.created']);
  });

  it('ignores unknown capabilities rather than throwing', () => {
    expect(eventTypesForGrantScopes(['bogus:scope'])).toEqual([]);
  });

  it('returns an empty array for capabilities with no declared event feed', () => {
    expect(eventTypesForGrantScopes(['discovery:read', 'corpus:read'])).toEqual([]);
  });

  it('ignores an attest:<appId>:<type> capability (no event feed for app-delegated attestations)', () => {
    expect(eventTypesForGrantScopes([buildAttestDelegationCapability('app_dykil123', 'survey_response')])).toEqual([]);
  });
});

// #2394 — app-delegated attestation capabilities: attest:<appId>:<type>.
describe('buildAttestDelegationCapability / parseAttestDelegationCapability', () => {
  it('round-trips a simple appId + built-in type', () => {
    const capability = buildAttestDelegationCapability('app_dykil123', 'vouch.given');
    expect(capability).toBe('attest:app_dykil123:vouch.given');
    expect(parseAttestDelegationCapability(capability)).toEqual({ appId: 'app_dykil123', attestationType: 'vouch.given' });
  });

  it('round-trips a registered handle/local_name type (contains a slash)', () => {
    const capability = buildAttestDelegationCapability('app_dykil123', 'dykil/survey_response');
    expect(parseAttestDelegationCapability(capability)).toEqual({ appId: 'app_dykil123', attestationType: 'dykil/survey_response' });
  });

  it('round-trips an underscore-bearing platform type (e.g. intro-funnel-shaped)', () => {
    const capability = buildAttestDelegationCapability('app_dykil123', 'intro_proposed');
    expect(parseAttestDelegationCapability(capability)).toEqual({ appId: 'app_dykil123', attestationType: 'intro_proposed' });
  });

  it('is namespaced under the ATTEST_DELEGATION_PREFIX constant', () => {
    expect(buildAttestDelegationCapability('app_x', 'y')).toBe(`${ATTEST_DELEGATION_PREFIX}app_x:y`);
  });

  it('rejects a string with no attest: prefix', () => {
    expect(parseAttestDelegationCapability('messages:write')).toBeNull();
  });

  it('rejects a string with the prefix but no second colon', () => {
    expect(parseAttestDelegationCapability('attest:app_dykil123')).toBeNull();
  });

  it('rejects an empty appId', () => {
    expect(parseAttestDelegationCapability('attest::vouch.given')).toBeNull();
  });

  it('rejects an empty attestationType', () => {
    expect(parseAttestDelegationCapability('attest:app_dykil123:')).toBeNull();
  });

  it('rejects an appId with characters outside its grammar (e.g. uppercase or a colon)', () => {
    expect(parseAttestDelegationCapability('attest:App_Dykil:vouch.given')).toBeNull();
  });

  it('never collides with a closed GRANT_SCOPE_REGISTRY entry\'s grammar', () => {
    const capability = buildAttestDelegationCapability('app_dykil123', 'vouch.given');
    expect(GRANT_SCOPE_GRAMMAR.test(capability)).toBe(false);
    expect(isKnownGrantScope(capability)).toBe(false);
  });
});
