import { describe, it, expect } from 'vitest';
import { deriveReleaseTier, FAIR_RELEASE_TIERS } from '@imajin/fair';
import {
  SCOPE_VOCABULARY,
  CONNECTOR_DIDS,
  CONNECTOR_CHANNELS,
  isConnectorScope,
  isCredentialFreeScope,
  isServiceEligibleScope,
  serviceEligibleScopes,
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
  type Scope,
} from '../src/scope-vocabulary';
import { SCOPES, validateScopes } from '../src/scopes';

const CONNECTOR_IDS: readonly ConnectorId[] = ['mcp', 'github', 'discord', 'gemini', 'anthropic', 'xai', 'openai', 'moonshot', 'zai', 'gcp', 'quickbooks', 'warp', 'stripe'];

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

  /**
   * Two segments is the norm. The optional third exists for connectors whose
   * provider is itself a family of surfaces rather than one API: `gcp:*` (#1317)
   * names the GCP surface in the middle (`gcp:vertex:invoke`), because a single
   * `gcp:invoke` would say nothing about what the sealed service-account key is
   * being unsealed for. The guard stays closed on casing and separators either
   * way — this widens the shape, not the character set.
   */
  it('uses `surface:verb`-shaped scope strings, with an optional third segment', () => {
    const malformed = SCOPE_VOCABULARY.map((e) => e.scope).filter((s) => !/^[a-z]+:[a-z-]+(:[a-z-]+)?$/.test(s));
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

  /**
   * #1621: the second brain a DID can seal. Classified exactly like
   * gemini:infer — the owner's own credential, consumed per call, released to
   * nobody — so it must derive owner-only rather than on-consent.
   */
  it('includes anthropic:infer as an owner-only connector scope', () => {
    expect(SCOPES['anthropic:infer']).toBe('Use your Anthropic API key for inference');
    expect(validateScopes(['anthropic:infer']).invalid).toEqual([]);

    const entry = scopeEntry('anthropic:infer') as ConnectorScopeEntry;
    expect(entry.connector).toBe('anthropic');
    expect(deriveScopeReleaseTier(entry)).toBe('owner-only');
    expect(viewerForScope(entry)).toBe(CONNECTOR_DIDS.anthropic);
  });

  /**
   * #1924/#1927/#1930/#1931: the third through sixth brains a DID can seal —
   * xAI, OpenAI, Moonshot AI (Kimi), and Z.ai (GLM) — net-new providers the
   * #1922 passthrough validates in that order (Grok → OpenAI → Gemini →
   * +Kimi, Anthropic last; Z.ai is capability-completion, no current spend).
   * All four are OpenAI-compatible and sit in the same quadrant as
   * gemini:infer/anthropic:infer, so each must derive owner-only and name its
   * own connector as the sole viewer. Collapsed into one parameterized case
   * (rather than a hand-copied `it()` pair per provider, which is exactly the
   * same-shape-different-literal block SonarCloud's duplication detector
   * flagged once a third provider joined — #1930) since the assertions are
   * identical across all four. None is on the MCP capability ceiling yet: the
   * passthrough (#1922 Phase 2) is not built, so no MCP tool can spend any of
   * these keys.
   */
  it.each([
    ['xai:infer', 'xai', 'xAI', 'xai-api'],
    ['openai:infer', 'openai', 'OpenAI', 'openai-api'],
    ['moonshot:infer', 'moonshot', 'Moonshot', 'moonshot-api'],
    ['zai:infer', 'zai', 'Z.ai', 'zai-api'],
  ] satisfies Array<[Scope, ConnectorId, string, string]>)(
    'includes %s as an owner-only connector scope, off the MCP ceiling',
    (scope, id, label, surface) => {
      expect(SCOPES[scope]).toBe(`Use your ${label} API key for inference`);
      expect(validateScopes([scope]).invalid).toEqual([]);

      const entry = scopeEntry(scope) as ConnectorScopeEntry;
      expect(entry.connector).toBe(id);
      expect(entry.surface).toBe(surface);
      expect(deriveScopeReleaseTier(entry)).toBe('owner-only');
      expect(viewerForScope(entry)).toBe(CONNECTOR_DIDS[id]);

      expect(scopesForSurface('mcp')).not.toContain(scope);
    },
  );

  /**
   * #1317: Stage 1 of the Google Cloud connector. A service-account key is broad,
   * so the vocabulary opens exactly three narrow scopes against it rather than a
   * single `gcp:*`. All three sit in the same 2×2 quadrant as `gemini:infer` —
   * the owner's own credential, consumed per call, released to nobody.
   */
  it('includes the three Stage 1 GCP scopes as owner-only connector scopes', () => {
    const expected = {
      'gcp:iam:read': 'Read IAM policies and service accounts',
      'gcp:vertex:invoke': 'Invoke Vertex AI / Gemini models',
      'gcp:project:read': 'Read GCP project metadata',
    } as const;

    expect(scopesForConnector('gcp').map((e) => e.scope)).toEqual(Object.keys(expected));

    for (const [scope, label] of Object.entries(expected)) {
      expect(SCOPES[scope]).toBe(label);
      expect(validateScopes([scope]).invalid).toEqual([]);

      const entry = scopeEntry(scope) as ConnectorScopeEntry;
      expect(entry.connector).toBe('gcp');
      expect(entry.surface).toBe('gcp-api');
      expect(deriveScopeReleaseTier(entry)).toBe('owner-only');
      expect(viewerForScope(entry)).toBe(CONNECTOR_DIDS.gcp);
    }
  });

  /**
   * Stage 2 builds MCP tools on top of these, but Stage 1 deliberately does not
   * put them on the MCP capability ceiling: an MCP token cannot carry a scope
   * whose tools do not exist yet.
   */
  it('keeps the GCP scopes off the MCP capability ceiling in Stage 1', () => {
    for (const scope of ['gcp:iam:read', 'gcp:vertex:invoke', 'gcp:project:read']) {
      expect(scopesForSurface('mcp')).not.toContain(scope);
    }
  });

  /**
   * #1636: the read-only discovery surface. Classified SELF_ONLY — public API
   * specs plus the owner's own connector state, nothing credential-grade — so it
   * must derive `silent` rather than inheriting a consent barrier.
   *
   * #1679 re-homed it from `warp` onto `mcp`. Everything else about it is
   * unchanged, deliberately: same scope string, same labels, same tier, same
   * place on the MCP capability ceiling.
   */
  it('includes discovery:read as a silent MCP-owned scope carried by MCP tokens', () => {
    expect(SCOPES['discovery:read']).toBe(
      'Read Imajin API specs, the scope vocabulary, and your connector status',
    );
    expect(validateScopes(['discovery:read']).invalid).toEqual([]);

    const entry = scopeEntry('discovery:read') as ConnectorScopeEntry;
    expect(entry.connector).toBe('mcp');
    expect(entry.verb).toBe('read');
    expect(entry.surface).toBe('discovery');
    expect(deriveScopeReleaseTier(entry)).toBe('silent');
    // A silent scope has no named viewer: there is no consent barrier to name one
    // behind.
    expect(viewerForScope(entry)).toBeUndefined();
    expect(scopesForSurface('mcp')).toContain('discovery:read');
  });

  /**
   * #1679: the whole point of the move. A scope that unseals nothing must not be
   * owned by a connector whose card demands a credential first — that is what
   * made a read-only grant unreachable without a Warp Agent key.
   */
  it('leaves the Warp connector owning only what spends the sealed key', () => {
    expect(scopesForConnector('warp').map((e) => e.scope)).toEqual(['warp:dispatch']);
  });

  it('marks discovery:read and the corpus scopes credential-free, and nothing that spends a key', () => {
    const credentialFree = connectorEntries
      .filter(isCredentialFreeScope)
      .map((e) => e.scope);
    // #1730 — corpus proxy tools spend no external credential either: the
    // kernel proxies to the internal corpus service, not a sealed third-party key.
    expect(credentialFree).toEqual(['discovery:read', 'corpus:read', 'corpus:write']);

    // Fail-closed default: an entry that says nothing is assumed to spend the
    // connector's credential.
    expect(isCredentialFreeScope(scopeEntry('warp:dispatch') as ConnectorScopeEntry)).toBe(false);
    expect(isCredentialFreeScope(scopeEntry('github:read') as ConnectorScopeEntry)).toBe(false);
  });

  /**
   * A credential-free scope on a connector that ingests one is exactly the #1679
   * bug: the card gates its toggles behind the credential step, so the grant is
   * unreachable without a key its holder will never use. Native connectors have
   * no credential step, so they are the only safe home.
   */
  it('keeps credential-free scopes off connectors that ingest a credential', () => {
    const CREDENTIAL_FREE_CONNECTORS = new Set<ConnectorId>(['mcp']);
    const stranded = connectorEntries
      .filter(isCredentialFreeScope)
      .filter((e) => !CREDENTIAL_FREE_CONNECTORS.has(e.connector))
      .map((e) => `${e.scope} on ${e.connector}`);
    expect(stranded).toEqual([]);
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

// ── serviceEligible fence (#1803, flipped for supply:read by xprize#70) ────────

describe('serviceEligible fence', () => {
  it('defaults every entry other than supply:read to service-ineligible (fail-closed)', () => {
    // #1803 landed the fence with no scope flipped on. catalyst-power/xprize#70
    // is the one signed-off flip: `supply:read` is now service-eligible because
    // the per-lot channel_links gate (#1806) makes every app-token lot read
    // consent-backed regardless of token shape. Every other scope nobody has
    // explicitly signed off on must stay out of a session-less service token.
    expect(serviceEligibleScopes()).toEqual(['supply:read']);
    for (const entry of SCOPE_VOCABULARY) {
      if (entry.scope === 'supply:read') continue;
      expect(isServiceEligibleScope(entry)).toBe(false);
    }
  });

  it('flips supply:read service-eligible (xprize#70) while keeping supply:write ineligible', () => {
    // xprize#70: the owner-signed-off flip step. supply:write is a distinct,
    // deliberately untouched scope — this change is one scope, not the pair.
    expect(isServiceEligibleScope(scopeEntry('supply:read')!)).toBe(true);
    expect(isServiceEligibleScope(scopeEntry('supply:write')!)).toBe(false);
    expect(serviceEligibleScopes()).toContain('supply:read');
    expect(serviceEligibleScopes()).not.toContain('supply:write');
  });
});
