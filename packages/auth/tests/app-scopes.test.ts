import { describe, it, expect } from 'vitest';
import {
  validateProvidedScopes,
  resolveAppScopes,
  validateDependsOn,
  tokenAudiences,
} from '../src/app-scopes';
import { validateScopes } from '../src/scopes';
import { SCOPE_VOCABULARY } from '../src/scope-vocabulary';

describe('validateProvidedScopes (#2663)', () => {
  it('accepts well-formed, non-vocabulary scopes', () => {
    expect(validateProvidedScopes(['dykil:read', 'dykil:write'])).toEqual({
      valid: ['dykil:read', 'dykil:write'],
      invalid: [],
    });
  });

  it('accepts a three-segment scope, like the vocabulary\'s own gcp:iam:read', () => {
    expect(validateProvidedScopes(['dykil:survey:export']).valid).toEqual(['dykil:survey:export']);
  });

  it('dedupes', () => {
    expect(validateProvidedScopes(['dykil:read', 'dykil:read']).valid).toEqual(['dykil:read']);
  });

  it.each([
    ['no namespace', 'read'],
    ['uppercase', 'Dykil:read'],
    ['whitespace', 'dykil: read'],
    ['empty segment', 'dykil:'],
    ['leading colon', ':read'],
    ['wildcard', 'dykil:*'],
  ])('rejects a malformed scope (%s)', (_label, scope) => {
    expect(validateProvidedScopes([scope])).toEqual({ valid: [], invalid: [scope] });
  });

  it('rejects non-string entries', () => {
    expect(validateProvidedScopes([42, null, { scope: 'dykil:read' }]).valid).toEqual([]);
  });

  it('treats a non-array as empty', () => {
    expect(validateProvidedScopes(undefined)).toEqual({ valid: [], invalid: [] });
    expect(validateProvidedScopes('dykil:read')).toEqual({ valid: [], invalid: [] });
  });

  it('rejects every scope already in the platform vocabulary', () => {
    const all = SCOPE_VOCABULARY.map((e) => e.scope);
    const result = validateProvidedScopes(all);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(new Set(all).size);
  });

  it('rejects a NEW scope in a namespace the vocabulary owns (media:admin, wallet:drain)', () => {
    expect(validateProvidedScopes(['media:admin', 'wallet:drain'])).toEqual({
      valid: [],
      invalid: ['media:admin', 'wallet:drain'],
    });
  });

  it("when the app has a slug, requires the scope to be in that slug's namespace", () => {
    expect(validateProvidedScopes(['dykil:read', 'links:read'], { slug: 'dykil' })).toEqual({
      valid: ['dykil:read'],
      invalid: ['links:read'],
    });
  });

  it('does not require a namespace when the app has no slug', () => {
    expect(validateProvidedScopes(['whatever:read'], { slug: null }).valid).toEqual(['whatever:read']);
  });
});

describe('resolveAppScopes (#2663 gap 1)', () => {
  it('keeps vocabulary scopes, as validateScopes() does', () => {
    expect(resolveAppScopes(['media:read', 'profile:read']).valid).toEqual(['media:read', 'profile:read']);
  });

  it("grants the app's own scopes that validateScopes() drops — the dykil bug", () => {
    expect(validateScopes(['dykil:read', 'dykil:write']).valid).toEqual([]);
    expect(resolveAppScopes(['dykil:read', 'dykil:write'], ['dykil:read', 'dykil:write'])).toEqual({
      valid: ['dykil:read', 'dykil:write'],
      invalid: [],
    });
  });

  it("grants both together, in the requested order", () => {
    expect(resolveAppScopes(['dykil:read', 'media:write'], ['dykil:read']).valid).toEqual(['dykil:read', 'media:write']);
  });

  it('drops scopes that are neither in the vocabulary nor declared by the app', () => {
    expect(resolveAppScopes(['dykil:read', 'dykil:admin', 'nope'], ['dykil:read'])).toEqual({
      valid: ['dykil:read'],
      invalid: ['dykil:admin', 'nope'],
    });
  });

  it("does not widen on another app's behalf: no declared scopes means no app scopes", () => {
    expect(resolveAppScopes(['dykil:read'], []).valid).toEqual([]);
    expect(resolveAppScopes(['dykil:read']).valid).toEqual([]);
  });

  it('ignores non-string requests', () => {
    expect(resolveAppScopes([1 as unknown as string], ['dykil:read']).valid).toEqual([]);
  });

  it('dedupes', () => {
    expect(resolveAppScopes(['dykil:read', 'dykil:read'], ['dykil:read']).valid).toEqual(['dykil:read']);
  });
});

describe('validateDependsOn (#2663)', () => {
  it('accepts a media dependency', () => {
    expect(validateDependsOn([{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] }])).toEqual({
      valid: [{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] }],
      invalid: [],
    });
  });

  it('accepts a host with a port and normalises case/whitespace', () => {
    expect(validateDependsOn([{ aud: '  Localhost:3000 ', scopes: ['media:read'] }]).valid).toEqual([
      { aud: 'localhost:3000', scopes: ['media:read'] },
    ]);
  });

  it('merges duplicate audiences and dedupes their scopes', () => {
    expect(
      validateDependsOn([
        { aud: 'jin.imajin.ai', scopes: ['media:read'] },
        { aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] },
      ]).valid,
    ).toEqual([{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] }]);
  });

  it('returns an empty list for a non-array', () => {
    expect(validateDependsOn(undefined)).toEqual({ valid: [], invalid: [] });
    expect(validateDependsOn({ aud: 'jin.imajin.ai', scopes: ['media:read'] })).toEqual({ valid: [], invalid: [] });
  });

  it.each([
    ['missing aud', { scopes: ['media:read'] }],
    ['empty aud', { aud: '', scopes: ['media:read'] }],
    ['aud with a scheme', { aud: 'https://jin.imajin.ai', scopes: ['media:read'] }],
    ['aud with a path', { aud: 'jin.imajin.ai/media', scopes: ['media:read'] }],
    ['aud with whitespace inside', { aud: 'jin imajin.ai', scopes: ['media:read'] }],
    ['no scopes', { aud: 'jin.imajin.ai', scopes: [] }],
    ['scopes not an array', { aud: 'jin.imajin.ai', scopes: 'media:read' }],
    ['a scope outside the vocabulary', { aud: 'jin.imajin.ai', scopes: ['media:read', 'media:admin'] }],
    ['a non-string scope', { aud: 'jin.imajin.ai', scopes: [1] }],
  ])('rejects an entry with %s', (_label, entry) => {
    const result = validateDependsOn([entry]);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(1);
  });

  it('rejects non-object entries', () => {
    expect(validateDependsOn(['jin.imajin.ai', null, 7]).valid).toEqual([]);
  });

  it('keeps the valid entries when others are invalid, and reports the bad ones', () => {
    const result = validateDependsOn([
      { aud: 'jin.imajin.ai', scopes: ['media:read'] },
      { aud: 'bad host', scopes: ['media:read'] },
    ]);
    expect(result.valid).toEqual([{ aud: 'jin.imajin.ai', scopes: ['media:read'] }]);
    expect(result.invalid).toEqual(['bad host']);
  });
});

describe('tokenAudiences (#2663 gap 2)', () => {
  it('puts the primary audience first, then the dependencies', () => {
    expect(tokenAudiences('dykil.imajin.ai', ['jin.imajin.ai'])).toEqual(['dykil.imajin.ai', 'jin.imajin.ai']);
  });

  it('is just the primary audience with no dependencies', () => {
    expect(tokenAudiences('dykil.imajin.ai', [])).toEqual(['dykil.imajin.ai']);
  });

  it('never repeats an audience', () => {
    expect(tokenAudiences('a', ['b', 'a', 'b'])).toEqual(['a', 'b']);
  });
});
