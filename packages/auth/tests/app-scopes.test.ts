import { describe, it, expect } from 'vitest';
import {
  validateProvidedScopes,
  resolveAppScopes,
  validateDependsOn,
  tokenAudiences,
  ownNamespaceScopes,
  approvedScopeCeiling,
  clampToApprovedCeiling,
  scopesForAudience,
} from '../src/app-scopes';
import { validateScopes } from '../src/scopes';
import { SCOPE_VOCABULARY } from '../src/scope-vocabulary';

describe('validateProvidedScopes (#2663)', () => {
  const dykil = { slug: 'dykil' };

  it('accepts well-formed, non-vocabulary scopes in the app\'s slug namespace', () => {
    expect(validateProvidedScopes(['dykil:read', 'dykil:write'], dykil)).toEqual({
      valid: ['dykil:read', 'dykil:write'],
      invalid: [],
    });
  });

  it('accepts a three-segment scope, like the vocabulary\'s own gcp:iam:read', () => {
    expect(validateProvidedScopes(['dykil:survey:export'], dykil).valid).toEqual(['dykil:survey:export']);
  });

  it('dedupes', () => {
    expect(validateProvidedScopes(['dykil:read', 'dykil:read'], dykil).valid).toEqual(['dykil:read']);
  });

  it.each([
    ['no namespace', 'read'],
    ['uppercase', 'Dykil:read'],
    ['whitespace', 'dykil: read'],
    ['empty segment', 'dykil:'],
    ['leading colon', ':read'],
    ['wildcard', 'dykil:*'],
  ])('rejects a malformed scope (%s)', (_label, scope) => {
    expect(validateProvidedScopes([scope], dykil)).toEqual({ valid: [], invalid: [scope] });
  });

  it('rejects non-string entries', () => {
    expect(validateProvidedScopes([42, null, { scope: 'dykil:read' }], dykil).valid).toEqual([]);
  });

  it('treats a non-array as empty', () => {
    expect(validateProvidedScopes(undefined, dykil)).toEqual({ valid: [], invalid: [] });
    expect(validateProvidedScopes('dykil:read', dykil)).toEqual({ valid: [], invalid: [] });
  });

  it('rejects every scope already in the platform vocabulary', () => {
    const all = SCOPE_VOCABULARY.map((e) => e.scope);
    const result = validateProvidedScopes(all, dykil);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toHaveLength(new Set(all).size);
  });

  it('rejects a NEW scope in a namespace the vocabulary owns (media:admin, wallet:drain)', () => {
    expect(validateProvidedScopes(['media:admin', 'wallet:drain'], dykil)).toEqual({
      valid: [],
      invalid: ['media:admin', 'wallet:drain'],
    });
  });

  it('rejects a vocabulary namespace even for an app whose slug IS that namespace', () => {
    expect(validateProvidedScopes(['media:admin'], { slug: 'media' })).toEqual({
      valid: [],
      invalid: ['media:admin'],
    });
  });

  describe('namespaces are reserved by registered slug (#2674)', () => {
    it("requires the scope to be in the app's own slug namespace", () => {
      expect(validateProvidedScopes(['dykil:read', 'links:read'], dykil)).toEqual({
        valid: ['dykil:read'],
        invalid: ['links:read'],
      });
    });

    it("refuses a slug-less app any app-namespaced scope, including another app's (dykil:read)", () => {
      expect(validateProvidedScopes(['dykil:read', 'dykil:write'])).toEqual({
        valid: [],
        invalid: ['dykil:read', 'dykil:write'],
      });
    });

    it.each([[null], [undefined], ['']])('treats a slug of %j as no slug', (slug) => {
      expect(validateProvidedScopes(['dykil:read'], { slug })).toEqual({ valid: [], invalid: ['dykil:read'] });
    });

    it('still allows a slug-less app to declare nothing', () => {
      expect(validateProvidedScopes([])).toEqual({ valid: [], invalid: [] });
    });

    it('does not let one slugged app squat a prefix-sharing namespace', () => {
      expect(validateProvidedScopes(['dykil-pro:read'], dykil).invalid).toEqual(['dykil-pro:read']);
      expect(validateProvidedScopes(['dyk:read'], dykil).invalid).toEqual(['dyk:read']);
    });
  });
});

describe('ownNamespaceScopes (#2674)', () => {
  it('keeps only the scopes in the slug namespace', () => {
    expect(ownNamespaceScopes(['dykil:read', 'links:read', 'dykil:write'], 'dykil')).toEqual(['dykil:read', 'dykil:write']);
  });

  it('returns nothing for a slug-less row, so a legacy squatted dykil:read is not honoured', () => {
    expect(ownNamespaceScopes(['dykil:read'], null)).toEqual([]);
    expect(ownNamespaceScopes(['dykil:read'], undefined)).toEqual([]);
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

describe('approvedScopeCeiling / clampToApprovedCeiling (#2674)', () => {
  const dependsOn = [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }];

  it('is the union of requested, provided, and approved-dependency scopes', () => {
    const ceiling = approvedScopeCeiling({ requestedScopes: ['profile:read'], providesScopes: ['dykil:read'], dependsOn });
    expect([...ceiling].sort((a, b) => a.localeCompare(b))).toEqual(['dykil:read', 'media:read', 'profile:read']);
  });

  it('tolerates null/absent fields', () => {
    expect(approvedScopeCeiling({ requestedScopes: null, providesScopes: null, dependsOn: null }).size).toBe(0);
    expect(approvedScopeCeiling({}).size).toBe(0);
  });

  it('drops every scope outside the ceiling for a third-party app', () => {
    const app = { tier: 'third_party', requestedScopes: ['profile:read'], providesScopes: [], dependsOn: [] };
    expect(clampToApprovedCeiling(['profile:read', 'media:write', 'wallet:write'], app)).toEqual(['profile:read']);
  });

  it('gives a third-party app with nothing assigned no scopes (an empty list is not "unconstrained")', () => {
    const app = { tier: 'third_party', requestedScopes: [], providesScopes: [], dependsOn: [] };
    expect(clampToApprovedCeiling(['profile:read'], app)).toEqual([]);
  });

  it('treats an unknown tier like third_party', () => {
    expect(clampToApprovedCeiling(['profile:read'], { requestedScopes: [] })).toEqual([]);
  });

  it('leaves a legacy first_party row with nothing assigned (0139 seed) unconstrained', () => {
    const app = { tier: 'first_party', requestedScopes: [], providesScopes: [], dependsOn: [] };
    expect(clampToApprovedCeiling(['profile:read', 'media:write'], app)).toEqual(['profile:read', 'media:write']);
  });

  it('holds a first_party row that HAS an assignment to it', () => {
    const app = { tier: 'first_party', requestedScopes: ['profile:read'], providesScopes: [], dependsOn: [] };
    expect(clampToApprovedCeiling(['profile:read', 'media:write'], app)).toEqual(['profile:read']);
  });

  it('keeps order and does not mutate its input', () => {
    const input = ['media:read', 'dykil:read', 'wallet:write'];
    const app = { tier: 'third_party', providesScopes: ['dykil:read'], dependsOn };
    expect(clampToApprovedCeiling(input, app)).toEqual(['media:read', 'dykil:read']);
    expect(input).toEqual(['media:read', 'dykil:read', 'wallet:write']);
  });
});

describe('scopesForAudience (#2674 per-audience scope binding)', () => {
  const APP = 'dykil.imajin.ai';
  const A = 'a.imajin.ai';
  const B = 'b.imajin.ai';
  const dependsOn = [
    { aud: A, scopes: ['media:read'] },
    { aud: B, scopes: ['events:read'] },
  ];
  const tokenScopes = ['dykil:read', 'media:read', 'events:read'];

  it('honours everything on the token at the primary audience', () => {
    expect(scopesForAudience(APP, APP, tokenScopes, dependsOn)).toEqual(tokenScopes);
  });

  it("honours only dependency A's scopes at A", () => {
    expect(scopesForAudience(A, APP, tokenScopes, dependsOn)).toEqual(['media:read']);
  });

  it("does not honour dependency A's scopes at dependency B", () => {
    const atB = scopesForAudience(B, APP, tokenScopes, dependsOn);
    expect(atB).toEqual(['events:read']);
    expect(atB).not.toContain('media:read');
  });

  it("does not honour the app's own providesScopes at a dependency", () => {
    expect(scopesForAudience(A, APP, tokenScopes, dependsOn)).not.toContain('dykil:read');
  });

  it('honours nothing at a dependency the app no longer lists', () => {
    expect(scopesForAudience(A, APP, tokenScopes, [{ aud: B, scopes: ['events:read'] }])).toEqual([]);
    expect(scopesForAudience(A, APP, tokenScopes, [])).toEqual([]);
  });

  it('never invents a scope the token does not carry', () => {
    expect(scopesForAudience(A, APP, ['dykil:read'], dependsOn)).toEqual([]);
  });

  it('merges the scopes of repeated entries for the same dependency', () => {
    const repeated = [
      { aud: A, scopes: ['media:read'] },
      { aud: A, scopes: ['media:write'] },
    ];
    expect(scopesForAudience(A, APP, ['media:read', 'media:write'], repeated)).toEqual(['media:read', 'media:write']);
  });

  it('returns a copy at the primary audience', () => {
    expect(scopesForAudience(APP, APP, tokenScopes, dependsOn)).not.toBe(tokenScopes);
  });
});
