/**
 * `consent:write` platform scope (#1817).
 *
 * Gates raising a generic consent request — an app-authed requester must
 * hold this scope before `requireAppAuth(request, { scope: 'consent:write' })`
 * lets it through the raise endpoint. Not owned by a connector: any
 * registered app can be granted it, mirroring `connections:write`.
 */
import { describe, it, expect } from 'vitest';
import { scopeEntry, isKnownScope, isConnectorScope } from '../src/scope-vocabulary';
import { SCOPES, validateScopes } from '../src/scopes';

describe('consent:write platform scope', () => {
  it('is a known, connector-less scope with a consent-screen label', () => {
    expect(isKnownScope('consent:write')).toBe(true);
    const entry = scopeEntry('consent:write');
    expect(entry).toMatchObject({ scope: 'consent:write', connector: null });
    expect(entry && isConnectorScope(entry)).toBe(false);
    expect(entry?.label.length).toBeGreaterThan(0);
  });

  it('is projected into SCOPES and accepted by validateScopes', () => {
    expect(typeof SCOPES['consent:write']).toBe('string');
    expect(validateScopes(['consent:write']).invalid).toEqual([]);
  });
});
