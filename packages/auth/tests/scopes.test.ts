import { describe, it, expect } from 'vitest';
import { validateScopes, SCOPES } from '../src/scopes';

describe('validateScopes', () => {
  it('accepts all known scopes', () => {
    const all = Object.keys(SCOPES);
    const { valid, invalid } = validateScopes(all);
    expect(valid).toEqual(all);
    expect(invalid).toEqual([]);
  });

  it('rejects unknown scopes', () => {
    const { valid, invalid } = validateScopes(['profile:read', 'admin:nuke']);
    expect(valid).toEqual(['profile:read']);
    expect(invalid).toEqual(['admin:nuke']);
  });

  it('handles empty input', () => {
    const { valid, invalid } = validateScopes([]);
    expect(valid).toEqual([]);
    expect(invalid).toEqual([]);
  });

  it('handles all invalid scopes', () => {
    const { valid, invalid } = validateScopes(['foo', 'bar']);
    expect(valid).toEqual([]);
    expect(invalid).toEqual(['foo', 'bar']);
  });
});
