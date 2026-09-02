/**
 * `usage:emit` / `usage:emitters-manage` platform scopes (#1151).
 *
 * `usage:emit` gates `POST /usage/api/incurred`, the emitter-registry ingest
 * door external adapters use to write into the shared `usage.incurred`
 * stream. `usage:emitters-manage` gates `GET`/`PUT /usage/api/emitters`, the
 * registry itself. Neither is owned by a connector — same shape as
 * `infer:completions` and `infer:usage-read`.
 */
import { describe, it, expect } from 'vitest';
import { scopeEntry, isKnownScope, isConnectorScope, isServiceEligibleScope, serviceEligibleScopes } from '../src/scope-vocabulary';
import { SCOPES, validateScopes } from '../src/scopes';

describe('usage:emit platform scope', () => {
  it('is a known, connector-less scope with a consent-screen label', () => {
    expect(isKnownScope('usage:emit')).toBe(true);
    const entry = scopeEntry('usage:emit');
    expect(entry).toMatchObject({ scope: 'usage:emit', connector: null });
    expect(entry && isConnectorScope(entry)).toBe(false);
    expect(entry?.label.length).toBeGreaterThan(0);
  });

  it('is service-eligible, so an app-service token may carry it', () => {
    const entry = scopeEntry('usage:emit');
    expect(entry && isServiceEligibleScope(entry)).toBe(true);
    expect(serviceEligibleScopes()).toContain('usage:emit');
  });

  it('is projected into SCOPES and accepted by validateScopes', () => {
    expect(typeof SCOPES['usage:emit']).toBe('string');
    expect(validateScopes(['usage:emit']).invalid).toEqual([]);
  });
});

describe('usage:emitters-manage platform scope', () => {
  it('is a known, connector-less scope, distinct from usage:emit', () => {
    expect(isKnownScope('usage:emitters-manage')).toBe(true);
    const entry = scopeEntry('usage:emitters-manage');
    expect(entry).toMatchObject({ scope: 'usage:emitters-manage', connector: null });
    expect(entry && isConnectorScope(entry)).toBe(false);
    expect(entry?.label).not.toEqual(scopeEntry('usage:emit')?.label);
  });

  it('is not service-eligible by default (fail-closed)', () => {
    const entry = scopeEntry('usage:emitters-manage');
    expect(entry && isServiceEligibleScope(entry)).toBe(false);
    expect(serviceEligibleScopes()).not.toContain('usage:emitters-manage');
  });

  it('is projected into SCOPES and accepted by validateScopes', () => {
    expect(typeof SCOPES['usage:emitters-manage']).toBe('string');
    expect(validateScopes(['usage:emitters-manage']).invalid).toEqual([]);
  });
});
