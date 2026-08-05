import { describe, it, expect } from 'vitest';
import { deriveReleaseTier, FAIR_RELEASE_TIERS } from '@imajin/fair';
import {
  SCOPE_VOCABULARY,
  CONNECTOR_DIDS,
  CONNECTOR_CHANNELS,
  isConnectorScope,
  deriveScopeReleaseTier,
  viewerForScope,
  uiLabelForScope,
  manifestLabelForScope,
  scopeEntry,
  isKnownScope,
  scopesForConnector,
  scopesForSurface,
  allScopes,
  type ConnectorId,
  type ConnectorScopeEntry,
} from '../src/scope-vocabulary';
import { SCOPES, validateScopes } from '../src/scopes';

const CONNECTOR_IDS: readonly ConnectorId[] = ['mcp', 'github', 'discord', 'gemini', 'quickbooks', 'warp'];

const connectorEntries = SCOPE_VOCABULARY.filter(isConnectorScope);

// ── Structural invariants ─────────────────────────────────────────────────────

describe('SCOPE_VOCABULARY structure', () => {
  it('has no duplicate scope strings', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of SCOPE_VOCABULARY) {
      if (seen.has(entry.scope)) duplicates.push(entry.scope);
      seen.add(entry.scope);
    }
    expect(duplicates).toEqual([]);
  });

  it('gives every entry a non-empty consent label', () => {
    const unlabelled = SCOPE_VOCABULARY.filter((e) => e.label.trim().length === 0);
    expect(unlabelled).toEqual([]);
  });

  it('uses `surface:verb`-shaped scope strings', () => {
    const malformed = SCOPE_VOCABULARY.map((e) => e.scope).filter((s) => !/^[a-z]+:[a-z-]+$/.test(s));
    expect(malformed).toEqual([]);
  });

  it('only references known connector ids', () => {
    const known = new Set<string>(CONNECTOR_IDS);
    const unknown = connectorEntries.map((e) => e.connector).filter((c) => !known.has(c));
    expect(unknown).toEqual([]);
  });

  it('gives every connector-owned scope a verb and surface for its manifest descriptor', () => {
    const incomplete = connectorEntries
      .filter((e) => e.verb.trim().length === 0 || e.surface.trim().length === 0)
      .map((e) => e.scope);
    expect(incomplete).toEqual([]);
  });

  it('declares a DID and channel for every connector id', () => {
    for (const id of CONNECTOR_IDS) {
      expect(CONNECTOR_DIDS[id]).toMatch(/^did:imajin:[a-z-]+$/);
      expect(CONNECTOR_CHANNELS[id]).toBe(id);
    }
  });

  it('gives every connector id at least one owned scope', () => {
    const empty = CONNECTOR_IDS.filter((id) => scopesForConnector(id).length === 0);
    expect(empty).toEqual([]);
  });
});

// ── The #1196 2×2 ─────────────────────────────────────────────────────────────

describe('deriveScopeReleaseTier', () => {
  const quadrants = [
    { disclosesOthers: false, sensitive: false, expected: 'silent' },
    { disclosesOthers: true, sensitive: false, expected: 'on-consent' },
    { disclosesOthers: false, sensitive: true, expected: 'owner-only' },
    { disclosesOthers: true, sensitive: true, expected: 'never' },
  ] as const;

  function entryFor(classification: { disclosesOthers: boolean; sensitive: boolean }): ConnectorScopeEntry {
    return {
      scope: 'test:scope',
      label: 'test',
      connector: 'mcp',
      verb: 'read',
      surface: 'test',
      classification,
    };
  }

  it.each(quadrants)(
    'maps disclosesOthers=$disclosesOthers sensitive=$sensitive to $expected',
    ({ disclosesOthers, sensitive, expected }) => {
      expect(deriveScopeReleaseTier(entryFor({ disclosesOthers, sensitive }))).toBe(expected);
    },
  );

  /**
   * The vocabulary keeps its own copy of the 2×2 so it can stay dependency-free
   * and client-safe (see the module header). This pins that copy to the
   * canonical disclosure engine so the two can never silently diverge.
   */
  it.each(quadrants)(
    'agrees with @imajin/fair deriveReleaseTier for disclosesOthers=$disclosesOthers sensitive=$sensitive',
    ({ disclosesOthers, sensitive }) => {
      expect(deriveScopeReleaseTier(entryFor({ disclosesOthers, sensitive }))).toBe(
        deriveReleaseTier({ disclosesOthers, sensitive }),
      );
    },
  );

  it('only ever produces tiers @imajin/fair recognises', () => {
    for (const entry of connectorEntries) {
      expect(FAIR_RELEASE_TIERS).toContain(deriveScopeReleaseTier(entry));
    }
  });

  it('lets an override only tighten, never loosen', () => {
    const rank = { silent: 0, 'on-consent': 1, 'owner-only': 2, never: 3 } as const;
    for (const entry of connectorEntries) {
      if (!entry.releaseOverride) continue;
      const derived = deriveReleaseTier(entry.classification);
      expect(
        rank[entry.releaseOverride],
        `${entry.scope} override ${entry.releaseOverride} must be >= derived ${derived}`,
      ).toBeGreaterThanOrEqual(rank[derived]);
    }
  });
});

// ── Derived viewer + labels ───────────────────────────────────────────────────

describe('viewerForScope', () => {
  it('names the owning connector for consent-barriered scopes', () => {
    for (const entry of connectorEntries) {
      const tier = deriveScopeReleaseTier(entry);
      if (tier === 'on-consent' || tier === 'owner-only') {
        expect(viewerForScope(entry)).toBe(CONNECTOR_DIDS[entry.connector]);
      } else {
        expect(viewerForScope(entry)).toBeUndefined();
      }
    }
  });
});

describe('label fallbacks', () => {
  it('falls back manifest label to the consent label', () => {
    const gemini = scopeEntry('gemini:infer');
    expect(gemini && isConnectorScope(gemini)).toBe(true);
    expect(manifestLabelForScope(gemini as ConnectorScopeEntry)).toBe(
      'Use your Gemini API key for inference',
    );
  });

  it('falls back ui label to the manifest label', () => {
    const mediaRead = scopeEntry('media:read') as ConnectorScopeEntry;
    expect(manifestLabelForScope(mediaRead)).toBe('Read your media assets');
    expect(uiLabelForScope(mediaRead)).toBe('Read your media assets');
  });

  it('keeps all three labels distinct where the surfaces genuinely differ', () => {
    const githubRead = scopeEntry('github:read') as ConnectorScopeEntry;
    expect(githubRead.label).toBe('Read your repos, issues and PRs on GitHub');
    expect(manifestLabelForScope(githubRead)).toBe('Read your own repos, issues and PRs');
    expect(uiLabelForScope(githubRead)).toBe('Read your repos, issues and PRs');
  });
});

// ── Lookups ───────────────────────────────────────────────────────────────────

describe('lookups', () => {
  it('resolves known scopes and rejects unknown ones', () => {
    expect(scopeEntry('media:read')?.scope).toBe('media:read');
    expect(scopeEntry('nope:nope')).toBeUndefined();
    expect(isKnownScope('media:read')).toBe(true);
    expect(isKnownScope('nope:nope')).toBe(false);
  });

  it('returns surface scopes in vocabulary order', () => {
    const mcpCeiling = scopesForSurface('mcp');
    const order = allScopes();
    const indices = mcpCeiling.map((s) => order.indexOf(s as never));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

// ── SCOPES projection ─────────────────────────────────────────────────────────

describe('SCOPES is a faithful projection', () => {
  it('has exactly one key per vocabulary entry, in vocabulary order', () => {
    expect(Object.keys(SCOPES)).toEqual(SCOPE_VOCABULARY.map((e) => e.scope));
  });

  it('maps each scope to its consent label', () => {
    for (const entry of SCOPE_VOCABULARY) {
      expect(SCOPES[entry.scope]).toBe(entry.label);
    }
  });

  it('accepts every vocabulary scope through validateScopes', () => {
    const { valid, invalid } = validateScopes([...allScopes()]);
    expect(invalid).toEqual([]);
    expect(valid).toHaveLength(SCOPE_VOCABULARY.length);
  });

  it('still rejects unknown scopes (closed vocabulary, no naming drift)', () => {
    const { valid, invalid } = validateScopes(['media:read', 'media:destroy']);
    expect(valid).toEqual(['media:read']);
    expect(invalid).toEqual(['media:destroy']);
  });

  /**
   * Regression for #1253: gemini:infer was declared in the connector registry
   * and the Gemini descriptors but never added to SCOPES, so validateScopes()
   * rejected it and the consent screens had no label to show.
   */
  it('includes gemini:infer', () => {
    expect(SCOPES['gemini:infer']).toBe('Use your Gemini API key for inference');
    expect(validateScopes(['gemini:infer']).invalid).toEqual([]);
  });

  it('includes connectors:read-status as an app-registration scope, not a connector grant', () => {
    const entry = scopeEntry('connectors:read-status');
    expect(entry).toMatchObject({
      scope: 'connectors:read-status',
      connector: null,
      label: 'Read your connector connection status',
    });
    expect(entry && isConnectorScope(entry)).toBe(false);
    expect(validateScopes(['connectors:read-status']).invalid).toEqual([]);
  });
});
