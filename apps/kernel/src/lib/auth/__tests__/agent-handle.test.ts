import { describe, expect, it } from 'vitest';
import { agentHandleError, agentHandlePrefix, agentSuffixError, composeAgentHandle } from '../agent-handle';

describe('agent handle rules', () => {
  it.each([null, undefined, ''])('preserves unprefixed behavior for owner handle %s', owner => {
    expect(agentHandlePrefix(owner)).toBe('');
    expect(composeAgentHandle(owner, 'travel')).toBe('travel');
    expect(agentSuffixError(owner, 'travel')).toBeNull();
    expect(agentSuffixError(owner, '')).toBe('handle is required');
    expect(agentSuffixError(owner, 'ab')).toBe('Handle must be 3-64 characters');
  });

  it.each(['ryan', 'artifact'])('shares base/suffix rules for owner %s', owner => {
    const prefix = `${owner}-jin`;
    expect(agentHandlePrefix(owner)).toBe(prefix);
    for (const suffix of ['', 'x', 'travel', 'a_b-2']) {
      const full = suffix ? `${prefix}-${suffix}` : prefix;
      expect(composeAgentHandle(owner, suffix)).toBe(full);
      expect(agentSuffixError(owner, suffix)).toBeNull();
      expect(agentHandleError(full, owner)).toBeNull();
    }
    for (const suffix of [prefix, `${prefix}-x`, `${prefix}x`]) {
      expect(agentSuffixError(owner, suffix)).toContain('Enter only the optional suffix');
    }
    for (const full of ['travel', `${prefix}-`, `${prefix}x`, 'another-jin']) {
      expect(agentHandleError(full, owner)).toContain(`Handle must be @${prefix} or`);
    }
  });

  it.each([undefined, null, 123, '', false])('rejects missing/non-string handle %s', handle => {
    expect(agentHandleError(handle)).toBe('handle is required');
  });

  it.each(['Ryan-jin', 'ryan-jin-!', 'ryan-jin-a b', 'ryan-jin-💛'])('rejects invalid characters: %s', handle => {
    expect(agentHandleError(handle, 'ryan')).toContain('lowercase letters');
  });

  it('applies length to the full handle including long owner prefixes', () => {
    expect(agentSuffixError('ryan', 'x'.repeat(55))).toBeNull();
    expect(agentSuffixError('ryan', 'x'.repeat(56))).toBe('Handle must be 3-64 characters');
    expect(agentSuffixError('a'.repeat(60), '')).toBeNull();
    expect(agentSuffixError('a'.repeat(61), '')).toBe('Handle must be 3-64 characters');
    expect(agentHandleError('ab')).toBe('Handle must be 3-64 characters');
  });
});
