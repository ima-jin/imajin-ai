import { describe, it, expect } from 'vitest';
import {
  GRANT_SCOPE_REGISTRY,
  GRANT_SCOPE_GRAMMAR,
  isKnownGrantScope,
  grantScopeEntry,
  allGrantScopes,
  validateGrantCapabilities,
  eventTypesForGrantScopes,
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

const KERNEL_EXTENSION_SCOPES = ['intros:propose', 'events:read', 'contacts:read'];

describe('GRANT_SCOPE_REGISTRY structure', () => {
  it('promotes exactly the 16 named MCP scopes plus the 3 kernel extensions (#1882)', () => {
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
});
