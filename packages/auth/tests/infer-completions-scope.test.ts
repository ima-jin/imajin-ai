/**
 * `infer:completions` platform scope (#1925).
 *
 * Gates `POST /infer/v1/chat/completions`, the OpenAI-compatible completions
 * passthrough — an app-authed requester must hold this scope before
 * `requireAppAuth(request, { scope: 'infer:completions' })` lets it through.
 * Not owned by a connector: the passthrough is a kernel route, not a
 * connector card, so there is no manifest toggle to gate — same shape as
 * `infer:provide` and `consent:write`.
 */
import { describe, it, expect } from 'vitest';
import { scopeEntry, isKnownScope, isConnectorScope } from '../src/scope-vocabulary';
import { SCOPES, validateScopes } from '../src/scopes';

describe('infer:completions platform scope', () => {
  it('is a known, connector-less scope with a consent-screen label', () => {
    expect(isKnownScope('infer:completions')).toBe(true);
    const entry = scopeEntry('infer:completions');
    expect(entry).toMatchObject({ scope: 'infer:completions', connector: null });
    expect(entry && isConnectorScope(entry)).toBe(false);
    expect(entry?.label.length).toBeGreaterThan(0);
  });

  it('is distinct from infer:provide', () => {
    expect(isKnownScope('infer:provide')).toBe(true);
    expect(scopeEntry('infer:completions')?.label).not.toEqual(scopeEntry('infer:provide')?.label);
  });

  it('is projected into SCOPES and accepted by validateScopes', () => {
    expect(typeof SCOPES['infer:completions']).toBe('string');
    expect(validateScopes(['infer:completions']).invalid).toEqual([]);
  });
});
