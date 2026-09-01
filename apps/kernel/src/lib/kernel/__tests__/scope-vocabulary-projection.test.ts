import { describe, it, expect } from 'vitest';
import {
  allScopes,
  isKnownScope,
  scopeEntry,
  scopesForConnector,
  isConnectorScope,
  deriveScopeReleaseTier,
  type ConnectorId,
} from '@imajin/auth/scope-vocabulary';
import { CONNECTOR_REGISTRY, getConnector } from '../connector-registry';
import {
  connectorScopeDescriptors,
  validScopesForConnector,
  connectorUiScopes,
  scopeCatalogue,
  scopeReleaseClass,
  requiresConsentRow,
} from '../scope-projections';
import { MCP_SCOPES, MCP_SCOPE_SET, filterGrantedScopes } from '@/src/lib/mcp/oauth-config';

// ─── #1253 drift guard ────────────────────────────────────────────────────────
//
// A scope string used to have to be declared in five hand-synced places. #1393
// updated four of them and missed `CONNECTOR_REGISTRY` — the list the toggles at
// /auth/connectors/<id> actually render from — so `messages:*` was grantable
// server-side but had no UI affordance, and the gap only surfaced when a user
// hit `insufficient_scope` in prod.
//
// All five are now projections of `SCOPE_VOCABULARY`. These tests assert the
// projections stay faithful, and pin the current scope sets so any vocabulary
// change is visible in review rather than discovered in production.

const CONNECTOR_IDS: readonly ConnectorId[] = ['mcp', 'github', 'discord', 'gemini', 'anthropic', 'xai', 'gcp', 'quickbooks', 'warp', 'stripe'];

// ── Every projection resolves back to the vocabulary ──────────────────────────

describe('every projected scope exists in the vocabulary', () => {
  it('holds for the connector-card registry lists', () => {
    const unknown = CONNECTOR_REGISTRY.flatMap((entry) =>
      entry.scopes.map((s) => s.name).filter((name) => !isKnownScope(name)),
    );
    expect(unknown).toEqual([]);
  });

  it('holds for the MCP OAuth capability ceiling', () => {
    expect(MCP_SCOPES.filter((s) => !isKnownScope(s))).toEqual([]);
  });

  it('holds for every connector manifest descriptor map', () => {
    const unknown = CONNECTOR_IDS.flatMap((id) =>
      Object.keys(connectorScopeDescriptors(id)).filter((name) => !isKnownScope(name)),
    );
    expect(unknown).toEqual([]);
  });

  it('holds for every connector POST validator allowlist', () => {
    const unknown = CONNECTOR_IDS.flatMap((id) =>
      validScopesForConnector(id).filter((name) => !isKnownScope(name)),
    );
    expect(unknown).toEqual([]);
  });
});

// ── Registry ↔ vocabulary agreement ───────────────────────────────────────────

describe('CONNECTOR_REGISTRY agrees with the vocabulary', () => {
  it('registers a known connector id for every entry', () => {
    const known = new Set<string>(CONNECTOR_IDS);
    expect(CONNECTOR_REGISTRY.map((e) => e.id).filter((id) => !known.has(id))).toEqual([]);
  });

  it('has one registry entry per connector id that owns scopes', () => {
    expect([...CONNECTOR_REGISTRY].map((e) => e.id).sort()).toEqual([...CONNECTOR_IDS].sort());
  });

  it('shows every non-never scope its connector owns, and no others', () => {
    for (const id of CONNECTOR_IDS) {
      const expected = scopesForConnector(id)
        .filter((entry) => deriveScopeReleaseTier(entry) !== 'never')
        .map((entry) => entry.scope);
      expect(getConnector(id)?.scopes.map((s) => s.name)).toEqual(expected);
    }
  });

  it('carries the derived release class on each shown scope', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      for (const scope of entry.scopes) {
        expect(scope.releaseClass).toBe(scopeReleaseClass(entry.id as ConnectorId, scope.name));
      }
    }
  });

  it('uses the connector DID and channel the vocabulary declares', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      const owned = scopesForConnector(entry.id as ConnectorId);
      expect(owned.length).toBeGreaterThan(0);
      expect(entry.channel).toBe(entry.id);
    }
  });

  it('hides never-class scopes from the UI list', () => {
    const shown = CONNECTOR_REGISTRY.flatMap((e) => e.scopes.map((s) => s.name));
    expect(shown).not.toContain('github:actions');
  });
});

// ── Pinned scope sets ─────────────────────────────────────────────────────────

describe('pinned scope sets (change these deliberately)', () => {
  it('pins the MCP connector card toggles', () => {
    expect(connectorUiScopes('mcp').map((s) => s.name)).toEqual([
      'media:read',
      'media:write',
      'media:share',
      'connections:read',
      'messages:read',
      'messages:write',
      // #1679 — re-homed from the Warp card, which could not grant it without a
      // sealed Agent key.
      'discovery:read',
      'inference:read',
      'inference:write',
      // #1730 — corpus proxy tools.
      'corpus:read',
      'corpus:write',
    ]);
  });

  it('pins the GitHub connector card toggles', () => {
    expect(connectorUiScopes('github').map((s) => s.name)).toEqual([
      'github:read',
      'github:write',
      'github:org',
    ]);
  });

  it('pins the Discord connector card toggles', () => {
    expect(connectorUiScopes('discord').map((s) => s.name)).toEqual(['discord:post', 'discord:read']);
  });

  it('pins the Gemini connector card toggles', () => {
    expect(connectorUiScopes('gemini').map((s) => s.name)).toEqual(['gemini:infer']);
  });

  it('pins the Anthropic connector card toggles', () => {
    expect(connectorUiScopes('anthropic').map((s) => s.name)).toEqual(['anthropic:infer']);
  });

  it('pins the xAI connector card toggles', () => {
    expect(connectorUiScopes('xai').map((s) => s.name)).toEqual(['xai:infer']);
  });

  it('pins the Google Cloud connector card toggles', () => {
    expect(connectorUiScopes('gcp').map((s) => s.name)).toEqual([
      'gcp:iam:read',
      'gcp:vertex:invoke',
      'gcp:project:read',
    ]);
  });

  it('pins the QuickBooks connector card toggles', () => {
    expect(connectorUiScopes('quickbooks').map((s) => s.name)).toEqual([
      'quickbooks:read',
      'quickbooks:write',
    ]);
  });

  it('pins the Warp connector card toggles', () => {
    expect(connectorUiScopes('warp').map((s) => s.name)).toEqual(['warp:dispatch']);
  });

  it('pins the Stripe connector card toggles', () => {
    expect(connectorUiScopes('stripe').map((s) => s.name)).toEqual(['stripe:events']);
  });

  /**
   * #1679: the flag the card reads to decide whether a toggle may be offered
   * before the credential step. Pinned as a set because a wrong `true` here
   * hands out a toggle for a scope that cannot work without a sealed key.
   */
  it('pins which card toggles are credential-free', () => {
    const credentialFree = CONNECTOR_REGISTRY.flatMap((entry) =>
      entry.scopes.filter((scope) => scope.credentialFree).map((scope) => scope.name),
    );
    // #1730 — corpus proxy tools spend no sealed credential either.
    expect(credentialFree).toEqual(['discovery:read', 'corpus:read', 'corpus:write']);
  });

  /**
   * This list is published as `scopes_supported` in the OAuth discovery docs,
   * so both membership AND order are externally visible.
   */
  it('pins the MCP OAuth capability ceiling, in order', () => {
    expect([...MCP_SCOPES]).toEqual([
      'media:read',
      'media:write',
      'media:share',
      'connections:read',
      'messages:read',
      'messages:write',
      'github:read',
      'github:write',
      'github:org',
      'github:actions',
      'warp:dispatch',
      'discovery:read',
      'inference:read',
      'inference:write',
      // #1730 — corpus proxy tools.
      'corpus:read',
      'corpus:write',
    ]);
  });
});

// ── Regressions ───────────────────────────────────────────────────────────────

describe('#1393 regression — messages:* is grantable end-to-end', () => {
  it.each(['messages:read', 'messages:write'])('exposes %s in every MCP projection', (scope) => {
    // 1. base vocabulary
    expect(isKnownScope(scope)).toBe(true);
    // 2. OAuth capability ceiling
    expect(MCP_SCOPE_SET.has(scope)).toBe(true);
    expect(filterGrantedScopes(scope)).toEqual([scope]);
    // 3. manifest descriptors + POST validator
    expect(Object.keys(connectorScopeDescriptors('mcp'))).toContain(scope);
    expect(validScopesForConnector('mcp')).toContain(scope);
    // 4. the UI toggle list — the projection #1393 missed
    expect(getConnector('mcp')?.scopes.map((s) => s.name)).toContain(scope);
  });
});

describe('#1253 regression — gemini:infer is a first-class vocabulary member', () => {
  it('is declared in the vocabulary, so validateScopes no longer rejects it', () => {
    expect(isKnownScope('gemini:infer')).toBe(true);
  });

  it('derives owner-only from the 2×2 instead of a hardcoded on-consent stub', () => {
    expect(scopeReleaseClass('gemini', 'gemini:infer')).toBe('owner-only');
    expect(getConnector('gemini')?.scopes[0].releaseClass).toBe('owner-only');
  });

  it('still records a consent row when the owner grants it', () => {
    expect(requiresConsentRow('gemini', 'gemini:infer')).toBe(true);
  });
});

// ── Descriptor projection fidelity ────────────────────────────────────────────

describe('manifest descriptors preserve their signed shape', () => {
  it('emits release.release only for scopes that override the 2×2', () => {
    for (const id of CONNECTOR_IDS) {
      const descriptors = connectorScopeDescriptors(id);
      for (const [scope, descriptor] of Object.entries(descriptors)) {
        const entry = scopeEntry(scope);
        if (!entry || !isConnectorScope(entry)) throw new Error(`${scope} missing from vocabulary`);
        if (entry.releaseOverride) {
          expect(descriptor.release.release).toBe(entry.releaseOverride);
        } else {
          expect(descriptor.release).not.toHaveProperty('release');
        }
      }
    }
  });

  it('emits release.viewer only for consent-barriered scopes', () => {
    for (const id of CONNECTOR_IDS) {
      for (const [scope, descriptor] of Object.entries(connectorScopeDescriptors(id))) {
        const tier = scopeReleaseClass(id, scope);
        if (tier === 'on-consent' || tier === 'owner-only') {
          expect(descriptor.release.viewer).toBeDefined();
        } else {
          expect(descriptor.release).not.toHaveProperty('viewer');
        }
      }
    }
  });

  it('mirrors the 2×2 classification onto the descriptor', () => {
    for (const id of CONNECTOR_IDS) {
      for (const entry of scopesForConnector(id)) {
        const descriptor = connectorScopeDescriptors(id)[entry.scope];
        expect(descriptor.release.discloses_others).toBe(entry.classification.disclosesOthers);
        expect(descriptor.release.sensitive).toBe(entry.classification.sensitive);
        expect(descriptor.verb).toBe(entry.verb);
        expect(descriptor.surface).toBe(entry.surface);
      }
    }
  });
});

// ── Byte-for-byte parity with the pre-#1253 hand-written descriptors ──────────
//
// The descriptor maps feed `buildConnectorManifestContent`, whose output is a
// SIGNED asset. If derivation changed any field, every existing owner's manifest
// would be rewritten on their next publish. These are the exact literals that
// lived in the five connector wrappers before #1253, copied verbatim from
// origin/main; `toEqual` therefore proves the migration is a pure refactor.
//
// `messages:*` is included for MCP because those descriptors already existed on
// main — the #1393 gap was the UI list, not the descriptors.

const MCP_DID = 'did:imajin:mcp-connector';
const GITHUB_DID = 'did:imajin:github-connector';
const DISCORD_DID = 'did:imajin:discord-connector';
const GEMINI_DID = 'did:imajin:gemini-connector';
const ANTHROPIC_DID = 'did:imajin:anthropic-connector';
const XAI_DID = 'did:imajin:xai-connector';
const GCP_DID = 'did:imajin:gcp-connector';
const QUICKBOOKS_DID = 'did:imajin:quickbooks-connector';
const WARP_DID = 'did:imajin:warp-connector';
const STRIPE_DID = 'did:imajin:stripe-connector';

describe('derived descriptors match the pre-#1253 literals exactly', () => {
  it('mcp', () => {
    expect(connectorScopeDescriptors('mcp')).toEqual({
      'media:read': { verb: 'read', surface: 'media', label: 'Read your media assets', release: { discloses_others: false, sensitive: false } },
      'media:write': { verb: 'write', surface: 'media', label: 'Create and update your media assets', release: { discloses_others: false, sensitive: false, release: 'on-consent', viewer: MCP_DID } },
      'media:share': { verb: 'write', surface: 'media-access', label: "Grant or revoke other people's access to your assets", release: { discloses_others: true, sensitive: false, viewer: MCP_DID } },
      'connections:read': { verb: 'read', surface: 'connections', label: 'Read your trust-graph connections', release: { discloses_others: false, sensitive: false } },
      'messages:read': { verb: 'read', surface: 'messages', label: 'List your conversations and read their messages', release: { discloses_others: false, sensitive: false } },
      'messages:write': { verb: 'write', surface: 'messages', label: 'Send messages in your conversations on your behalf', release: { discloses_others: false, sensitive: false, release: 'on-consent', viewer: MCP_DID } },
      // #1636/#1679 — the descriptor is byte-identical to the one the Warp
      // manifest carried; only the connector that publishes it changed. Owners
      // who had it on their Warp manifest re-toggle it here once.
      'discovery:read': { verb: 'read', surface: 'discovery', label: 'Read the node API specs, scope vocabulary, and your connector status', release: { discloses_others: false, sensitive: false } },
      // #1298 — new descriptors, not migrated literals.
      'inference:read': { verb: 'read', surface: 'inference', label: 'Read inference session status and attestations', release: { discloses_others: false, sensitive: false } },
      'inference:write': { verb: 'write', surface: 'inference', label: 'Trigger the inference pipeline and sign attestations on your behalf', release: { discloses_others: false, sensitive: true, viewer: MCP_DID } },
      // #1730 — corpus proxy tools.
      'corpus:read': { verb: 'read', surface: 'corpus', label: 'Read and search your corpus', release: { discloses_others: false, sensitive: false } },
      'corpus:write': { verb: 'write', surface: 'corpus', label: 'Load and sync your corpus sources', release: { discloses_others: false, sensitive: false, release: 'on-consent', viewer: MCP_DID } },
    });
  });

  it('github', () => {
    expect(connectorScopeDescriptors('github')).toEqual({
      'github:read': { verb: 'read', surface: 'repos', label: 'Read your own repos, issues and PRs', release: { discloses_others: false, sensitive: false } },
      'github:write': { verb: 'write', surface: 'issues', label: 'Open and comment on issues & PRs on your repos', release: { discloses_others: false, sensitive: false, release: 'on-consent', viewer: GITHUB_DID } },
      'github:org': { verb: 'write', surface: 'org', label: 'Act on repos owned by an org or other people', release: { discloses_others: true, sensitive: false, viewer: GITHUB_DID } },
      'github:actions': { verb: 'execute', surface: 'actions', label: 'Trigger Actions / deploy / spend CI minutes', release: { discloses_others: true, sensitive: true } },
    });
  });

  it('discord', () => {
    expect(connectorScopeDescriptors('discord')).toEqual({
      'discord:post': { verb: 'post', surface: 'channels', label: 'Post messages to Discord channels', release: { discloses_others: true, sensitive: false, viewer: DISCORD_DID } },
      'discord:read': { verb: 'read', surface: 'channels', label: 'Read messages from Discord channels', release: { discloses_others: true, sensitive: false, viewer: DISCORD_DID } },
    });
  });

  it('gemini', () => {
    expect(connectorScopeDescriptors('gemini')).toEqual({
      'gemini:infer': { verb: 'infer', surface: 'gemini-api', label: 'Use your Gemini API key for inference', release: { discloses_others: false, sensitive: true, viewer: GEMINI_DID } },
    });
  });

  // #1621 — new descriptor, not a migrated literal. Mirrors Gemini's shape
  // because it is the same kind of credential under the same 2×2 quadrant.
  it('anthropic', () => {
    expect(connectorScopeDescriptors('anthropic')).toEqual({
      'anthropic:infer': { verb: 'infer', surface: 'anthropic-api', label: 'Use your Anthropic API key for inference', release: { discloses_others: false, sensitive: true, viewer: ANTHROPIC_DID } },
    });
  });

  // #1924 — new descriptor, not a migrated literal. Same SELF_SENSITIVE
  // quadrant as gemini:infer / anthropic:infer: the owner's own key is spent on
  // every Grok call and never released to a third party.
  it('xai', () => {
    expect(connectorScopeDescriptors('xai')).toEqual({
      'xai:infer': { verb: 'infer', surface: 'xai-api', label: 'Use your xAI API key for inference', release: { discloses_others: false, sensitive: true, viewer: XAI_DID } },
    });
  });

  // #1317 — new descriptors. The verb carries the GCP surface (`vertex:invoke`)
  // because one service-account key spans several products, and `surface` names
  // the wire they are all reached over.
  it('gcp', () => {
    expect(connectorScopeDescriptors('gcp')).toEqual({
      'gcp:iam:read': { verb: 'iam:read', surface: 'gcp-api', label: 'Read IAM policies and service accounts', release: { discloses_others: false, sensitive: true, viewer: GCP_DID } },
      'gcp:vertex:invoke': { verb: 'vertex:invoke', surface: 'gcp-api', label: 'Invoke Vertex AI / Gemini models', release: { discloses_others: false, sensitive: true, viewer: GCP_DID } },
      'gcp:project:read': { verb: 'project:read', surface: 'gcp-api', label: 'Read GCP project metadata', release: { discloses_others: false, sensitive: true, viewer: GCP_DID } },
    });
  });

  it('quickbooks', () => {
    expect(connectorScopeDescriptors('quickbooks')).toEqual({
      'quickbooks:read': { verb: 'read', surface: 'invoices', label: 'Read your QuickBooks invoices', release: { discloses_others: false, sensitive: false } },
      'quickbooks:write': { verb: 'write', surface: 'invoices', label: 'Create QuickBooks invoices', release: { discloses_others: true, sensitive: false, viewer: QUICKBOOKS_DID } },
    });
  });

  // #1785 — new descriptor, not a migrated literal. Same SELF_SENSITIVE
  // quadrant as gemini:infer/warp:dispatch: the owner's own restricted key is
  // what makes the events exist, and they are never released to a third party.
  it('stripe', () => {
    expect(connectorScopeDescriptors('stripe')).toEqual({
      'stripe:events': { verb: 'events', surface: 'payments', label: 'Publish your own Stripe payment events onto the bus', release: { discloses_others: false, sensitive: true, viewer: STRIPE_DID } },
    });
  });
});

// ── #1428 ─ the Warp connector's descriptor is new, not a migrated literal ─────

describe('#1428 — warp:dispatch projects as an owner-only connector scope', () => {
  it('derives owner-only from the 2×2 (own credential, spawns cloud agents)', () => {
    expect(scopeReleaseClass('warp', 'warp:dispatch')).toBe('owner-only');
    expect(requiresConsentRow('warp', 'warp:dispatch')).toBe(true);
  });

  it('emits the connector as the only viewer of the sealed key', () => {
    expect(connectorScopeDescriptors('warp')['warp:dispatch']).toEqual({
      verb: 'dispatch',
      surface: 'cloud-agents',
      label: 'Dispatch Warp cloud agents under your own credential',
      release: { discloses_others: false, sensitive: true, viewer: WARP_DID },
    });
  });

  it('is carried by MCP tokens so a jin speaking MCP can dispatch', () => {
    expect(MCP_SCOPE_SET.has('warp:dispatch')).toBe(true);
    expect(filterGrantedScopes('warp:dispatch')).toEqual(['warp:dispatch']);
  });

  it('renders a toggle on the connector card', () => {
    expect(getConnector('warp')?.scopes.map((s) => s.name)).toContain('warp:dispatch');
  });
});

// ── #1636 / #1679 ─ the read-only discovery scope, now owned by MCP ──────────

describe('#1636 — discovery:read is grantable end-to-end', () => {
  /**
   * The five-projection walk #1393 taught us to do. A scope that is grantable
   * server-side but has no toggle is worse than a missing scope: it looks like a
   * bug in the caller.
   */
  it('reaches every MCP projection', () => {
    expect(isKnownScope('discovery:read')).toBe(true);
    expect(MCP_SCOPE_SET.has('discovery:read')).toBe(true);
    expect(filterGrantedScopes('discovery:read')).toEqual(['discovery:read']);
    expect(Object.keys(connectorScopeDescriptors('mcp'))).toContain('discovery:read');
    expect(validScopesForConnector('mcp')).toContain('discovery:read');
    expect(getConnector('mcp')?.scopes.map((s) => s.name)).toContain('discovery:read');
  });

  /**
   * `silent`, not `owner-only`: the payload is public specs plus the owner's own
   * connector state. Deriving a consent barrier here would make the low-friction
   * read the scope exists to provide impossible.
   */
  it('derives silent from the 2×2, so it needs no consent row', () => {
    expect(scopeReleaseClass('mcp', 'discovery:read')).toBe('silent');
    expect(requiresConsentRow('mcp', 'discovery:read')).toBe(false);
  });

  it('names no viewer, because a silent scope is released to nobody in particular', () => {
    expect(connectorScopeDescriptors('mcp')['discovery:read']).toEqual({
      verb: 'read',
      surface: 'discovery',
      label: 'Read the node API specs, scope vocabulary, and your connector status',
      release: { discloses_others: false, sensitive: false },
    });
  });

  /**
   * The whole point of splitting it out of `warp:dispatch`: a DID can read what
   * the system exposes without being handed the ability to spend money, and
   * revoking one must not revoke the other.
   */
  it('is independent of warp:dispatch', () => {
    expect(filterGrantedScopes('discovery:read')).not.toContain('warp:dispatch');
    expect(scopeReleaseClass('warp', 'warp:dispatch')).toBe('owner-only');
    expect(scopeReleaseClass('mcp', 'discovery:read')).toBe('silent');
  });
});

describe('#1679 — discovery:read is not gated behind a credential', () => {
  /**
   * The bug: `silent` means "materialises on manifest publish", but the Warp card
   * only publishes once an Agent key is sealed, so the tier promised something
   * the connector could not deliver. The native MCP connector has no credential
   * step at all, which is what makes the promise true again.
   */
  it('is owned by the native connector, not the static-secret one', () => {
    expect(validScopesForConnector('warp')).not.toContain('discovery:read');
    expect(getConnector('warp')?.scopes.map((s) => s.name)).not.toContain('discovery:read');
    expect(getConnector('mcp')?.ingestionPattern).toBe('native');
    expect(getConnector('mcp')?.tokenRoute).toBeNull();
  });

  it('carries the credential-free flag the card reads', () => {
    const scope = getConnector('mcp')?.scopes.find((s) => s.name === 'discovery:read');
    expect(scope?.credentialFree).toBe(true);
    expect(scope?.releaseClass).toBe('silent');
  });

  /**
   * Everything that unseals or spends a credential stays flagged false, so the
   * card keeps gating those behind the credential step.
   */
  it('leaves credential-spending scopes flagged false', () => {
    for (const [connector, scope] of [
      ['warp', 'warp:dispatch'],
      ['github', 'github:read'],
      ['gemini', 'gemini:infer'],
      ['mcp', 'media:read'],
    ] as const) {
      const entry = getConnector(connector)?.scopes.find((s) => s.name === scope);
      expect(entry?.credentialFree, scope).toBe(false);
    }
  });
});

// ── #1298 ─ the inference MCP surface has scopes of its own ───────────────────

describe('#1298 — inference:* is grantable end-to-end and independent of media:*', () => {
  it.each(['inference:read', 'inference:write'])('reaches every MCP projection for %s', (scope) => {
    expect(isKnownScope(scope)).toBe(true);
    expect(MCP_SCOPE_SET.has(scope)).toBe(true);
    expect(filterGrantedScopes(scope)).toEqual([scope]);
    expect(Object.keys(connectorScopeDescriptors('mcp'))).toContain(scope);
    expect(validScopesForConnector('mcp')).toContain(scope);
    expect(getConnector('mcp')?.scopes.map((s) => s.name)).toContain(scope);
  });

  it('leaves inference:read silent — reading your own session needs no consent row', () => {
    expect(scopeReleaseClass('mcp', 'inference:read')).toBe('silent');
    expect(requiresConsentRow('mcp', 'inference:read')).toBe(false);
  });

  /**
   * `owner-only`, the same quadrant as `gemini:infer`: exercising it has an
   * attestation signed on the owner's behalf, which is credential-grade. Stricter
   * than `media:write`, whose on-consent tier is an explicit override.
   */
  it('derives owner-only for inference:write, so publishing it records consent', () => {
    expect(scopeReleaseClass('mcp', 'inference:write')).toBe('owner-only');
    expect(requiresConsentRow('mcp', 'inference:write')).toBe(true);
    expect(connectorScopeDescriptors('mcp')['inference:write'].release.viewer).toBe(MCP_DID);
  });

  /**
   * The point of #1298: granting media no longer grants inference. Each scope
   * survives filtering on its own and drags nothing else along.
   */
  it('does not travel with the media scopes in either direction', () => {
    expect(filterGrantedScopes('media:read media:write')).not.toContain('inference:write');
    expect(filterGrantedScopes('media:read media:write')).not.toContain('inference:read');
    expect(filterGrantedScopes('inference:read inference:write')).toEqual([
      'inference:read',
      'inference:write',
    ]);
  });
});

// ── Discovery catalogue projection (#1636) ───────────────────────────────────

describe('scopeCatalogue', () => {
  it('reports every vocabulary scope, in vocabulary order', () => {
    expect(scopeCatalogue().map((e) => e.scope)).toEqual([...allScopes()]);
  });

  it('carries the derived release class for connector scopes and null for platform ones', () => {
    for (const entry of scopeCatalogue()) {
      if (entry.connector === null) {
        expect(entry.releaseClass, entry.scope).toBeNull();
      } else {
        expect(entry.releaseClass, entry.scope).toBe(scopeReleaseClass(entry.connector, entry.scope));
      }
    }
  });

  it('flags exactly the scopes an MCP token may carry', () => {
    const flagged = scopeCatalogue().filter((e) => e.mcpToken).map((e) => e.scope);
    expect(flagged).toEqual([...MCP_SCOPES]);
  });

  /**
   * Unlike the connector card, the catalogue keeps `never` scopes. A dead toggle
   * confuses a person; an agent is better off knowing the scope exists and can
   * never materialise than concluding it is available.
   */
  it('keeps never-class scopes the connector card hides', () => {
    expect(scopeCatalogue().map((e) => e.scope)).toContain('github:actions');
    expect(scopeCatalogue().find((e) => e.scope === 'github:actions')?.releaseClass).toBe('never');
  });
});

describe('requiresConsentRow', () => {
  it('is true for on-consent and owner-only, false for silent', () => {
    expect(requiresConsentRow('mcp', 'media:read')).toBe(false);
    expect(requiresConsentRow('mcp', 'media:write')).toBe(true);
    expect(requiresConsentRow('mcp', 'media:share')).toBe(true);
    expect(requiresConsentRow('mcp', 'inference:read')).toBe(false);
    expect(requiresConsentRow('mcp', 'inference:write')).toBe(true);
    expect(requiresConsentRow('gemini', 'gemini:infer')).toBe(true);
  });

  it('fails closed for a scope the connector does not own', () => {
    expect(scopeReleaseClass('gemini', 'media:read')).toBe('never');
    expect(requiresConsentRow('gemini', 'media:read')).toBe(false);
  });
});
