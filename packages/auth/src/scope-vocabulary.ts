/**
 * Declarative scope vocabulary — the single source of truth (#1253).
 *
 * Before this module, adding one connector scope meant editing five hand-synced
 * lists: `SCOPES`, `MCP_SCOPES`, the connector's `*_SCOPE_DESCRIPTORS`, the
 * `CONNECTOR_REGISTRY` UI list, and the connector's `*ScopeReleaseClass()`
 * copy. Miss one and it still typechecks, still ships, and fails silently in
 * prod — which is exactly what happened to `messages:*` in #1393: the scope
 * existed server-side but never rendered a toggle, so nobody could grant it.
 *
 * Everything is now a projection of the table below:
 *   SCOPES / validateScopes()          → ./scopes.ts
 *   MCP_SCOPES (OAuth ceiling)         → apps/kernel/src/lib/mcp/oauth-config.ts
 *   *_SCOPE_DESCRIPTORS, VALID_*_SCOPES→ apps/kernel/src/lib/kernel/scope-projections.ts
 *   CONNECTOR_REGISTRY[].scopes (UI)   → apps/kernel/src/lib/kernel/connector-registry.ts
 *
 * Adding a scope is ONE edit: append an entry here.
 *
 * IMPORTANT: this module must stay dependency-free and client-safe (no imports
 * at all, no `node:` builtins, no DB). It is imported by client components via
 * the `@imajin/auth/scope-vocabulary` subpath so they never pull the
 * server-heavy `@imajin/auth` index into a browser bundle.
 *
 * Refs: #1253 (this) · #1196 (consent 2×2) · #1184 (grantable ≠ granted) ·
 *       #1393 (the prod miss this prevents) · #517 (same idea, attestation types)
 */

// ── Identity ──────────────────────────────────────────────────────────────────

/** Connectors that can own scopes. */
export type ConnectorId = 'mcp' | 'github' | 'discord' | 'gemini' | 'anthropic' | 'quickbooks' | 'warp';

/**
 * Capability surfaces that can *carry* a scope in an access token.
 *
 * Distinct from ownership: `github:read` is owned by the GitHub connector but
 * is legitimately carried by MCP tokens, so it is `connector: 'github'` with
 * `surfaces: ['mcp']`.
 */
export type CapabilitySurface = 'mcp';

/** Connector app DIDs — the only place these strings are declared. */
export const CONNECTOR_DIDS: Readonly<Record<ConnectorId, string>> = {
  mcp: 'did:imajin:mcp-connector',
  github: 'did:imajin:github-connector',
  discord: 'did:imajin:discord-connector',
  gemini: 'did:imajin:gemini-connector',
  anthropic: 'did:imajin:anthropic-connector',
  quickbooks: 'did:imajin:quickbooks-connector',
  warp: 'did:imajin:warp-connector',
};

/** Channel label used in `auth.channel_links`. Currently always the id. */
export const CONNECTOR_CHANNELS: Readonly<Record<ConnectorId, string>> = {
  mcp: 'mcp',
  github: 'github',
  discord: 'discord',
  gemini: 'gemini',
  anthropic: 'anthropic',
  quickbooks: 'quickbooks',
  warp: 'warp',
};

// ── Release tiers (#1196 consent 2×2) ─────────────────────────────────────────

/**
 * Release tier, mirroring `FairReleaseTier` in `@imajin/fair`.
 *
 *   silent     — freely projectable; materialises on manifest publish
 *   on-consent — materialises only when a consent_grants row exists
 *   owner-only — never released to a third party; the owner must grant it
 *   never      — structural drop; can never materialise
 */
export type ScopeReleaseTier = 'silent' | 'on-consent' | 'owner-only' | 'never';

/**
 * Tiers usable as an explicit override. `silent` is excluded on purpose: an
 * override may only ever *tighten* what the 2×2 derives, never loosen it.
 */
export type ScopeReleaseOverride = Exclude<ScopeReleaseTier, 'silent'>;

/** The two axes of the #1196 2×2. */
export interface ScopeClassification {
  /** True when exercising the scope exposes data about people other than the owner. */
  disclosesOthers: boolean;
  /** True when the scope touches credential-grade or otherwise sensitive material. */
  sensitive: boolean;
}

// ── Entry shapes ──────────────────────────────────────────────────────────────

interface BaseScopeEntry {
  /** The scope string, e.g. `media:read`. Unique across the vocabulary. */
  scope: string;
  /**
   * Consent-screen label — what `SCOPES` maps to, shown at /auth/authorize
   * and /auth/apps. Written from the *user's* point of view.
   */
  label: string;
  /** Capability surfaces whose tokens may carry this scope. */
  surfaces?: readonly CapabilitySurface[];
}

/**
 * A platform scope with no owning connector: granted to registered apps through
 * the OAuth consent screen, never through a connector scope-manifest.
 */
export interface PlatformScopeEntry extends BaseScopeEntry {
  connector: null;
}

/**
 * A connector-owned scope. Appears in that connector's signed scope-manifest,
 * in its POST validator, and as a toggle on its connector card.
 */
export interface ConnectorScopeEntry extends BaseScopeEntry {
  connector: ConnectorId;
  /** Manifest descriptor `verb`, e.g. `read` / `write` / `execute`. */
  verb: string;
  /** Manifest descriptor `surface`, e.g. `media` / `repos`. */
  surface: string;
  /**
   * Label written into the signed scope-manifest asset. Defaults to `label`.
   *
   * Kept separate because manifest bytes are signed: changing this text
   * rewrites every existing owner's manifest on their next publish.
   */
  manifestLabel?: string;
  /** Label on the connector card. Defaults to `manifestLabel ?? label`. */
  uiLabel?: string;
  /** The #1196 2×2 inputs. */
  classification: ScopeClassification;
  /**
   * Explicit tier that overrides the 2×2 derivation. Only ever used to
   * *tighten* — e.g. `media:write` is not disclosing and not sensitive (so the
   * 2×2 says `silent`) but we still demand explicit consent.
   */
  releaseOverride?: ScopeReleaseOverride;
}

export type ScopeVocabularyEntry = PlatformScopeEntry | ConnectorScopeEntry;

// ── The four #1196 quadrants, named ────────────────────────────────────────
//
// Naming the quadrants means a reader sees the *meaning* of a classification
// rather than having to apply the 2×2 to a pair of booleans. The derived tier is
// noted on each; `deriveScopeReleaseTier` is what actually computes it.

/** Owner's own data, nothing sensitive → `silent`. */
const SELF_ONLY: ScopeClassification = { disclosesOthers: false, sensitive: false };
/** Exposes other people → `on-consent`. */
const TOUCHES_OTHERS: ScopeClassification = { disclosesOthers: true, sensitive: false };
/** Owner's own credential-grade material → `owner-only`. */
const SELF_SENSITIVE: ScopeClassification = { disclosesOthers: false, sensitive: true };
/** Both axes → `never`: a structural drop, hidden from the UI. */
const TOUCHES_OTHERS_SENSITIVE: ScopeClassification = { disclosesOthers: true, sensitive: true };

/** Carried by MCP access tokens (the capability ceiling, not a grant). */
const MCP_TOKENS: readonly CapabilitySurface[] = ['mcp'];

// ── The vocabulary ────────────────────────────────────────────────────────

/**
 * THE source of truth — one row per scope.
 *
 * Order matters: it determines consent-screen ordering, `scopes_supported` in
 * the OAuth discovery docs, and connector-card toggle order. Append rather than
 * reorder unless you mean to change those.
 *
 * Rows are deliberately dense so the table reads as a table. Connector rows put
 * machine-readable facts on the first line and human-facing prose on the second:
 *   line 1 — scope, owning connector, manifest verb/surface, classification, surfaces
 *   line 2 — consent label, and the manifest/UI labels where they differ
 */
export const SCOPE_VOCABULARY = [
  // ── Platform scopes — no owning connector, granted via the OAuth consent screen
  { scope: 'profile:read', connector: null, label: 'Read your profile information' },
  { scope: 'identity:read', connector: null, label: 'Read your identity and DID' },
  { scope: 'identity:write', connector: null, label: 'Resolve or mint soft identities on your behalf (registry get-or-create)' },
  { scope: 'connectors:read-status', connector: null, label: 'Read your connector connection status' },

  // ── MCP / Claude connector
  { scope: 'media:read', connector: 'mcp', verb: 'read', surface: 'media', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read your media library (files, folders, and metadata)', manifestLabel: 'Read your media assets' },
  // Tightened: writing on someone's behalf always warrants explicit consent.
  { scope: 'media:write', connector: 'mcp', verb: 'write', surface: 'media', classification: SELF_ONLY, surfaces: MCP_TOKENS, releaseOverride: 'on-consent',
    label: 'Create and upload media on your behalf', manifestLabel: 'Create and update your media assets' },
  // Crosses the sovereignty boundary — distinct from media:write.
  { scope: 'media:share', connector: 'mcp', verb: 'write', surface: 'media-access', classification: TOUCHES_OTHERS, surfaces: MCP_TOKENS,
    label: 'Share your media with other people', manifestLabel: "Grant or revoke other people's access to your assets" },

  { scope: 'wallet:read', connector: null, label: 'View your wallet balance and transaction history' },
  { scope: 'wallet:write', connector: null, label: 'Create payments and transfers on your behalf' },

  { scope: 'connections:read', connector: 'mcp', verb: 'read', surface: 'connections', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'View your connections', manifestLabel: 'Read your trust-graph connections' },

  { scope: 'events:read', connector: null, label: 'View events you attend or have created' },
  { scope: 'events:write', connector: null, label: 'Create and manage events on your behalf' },
  { scope: 'supply:read', connector: null, label: 'View your supply-chain lots and their stage history' },
  { scope: 'supply:write', connector: null, label: 'Record supply-chain stages (declare, collect, process, list) on your behalf' },

  { scope: 'messages:read', connector: 'mcp', verb: 'read', surface: 'messages', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read messages in your conversations', manifestLabel: 'List your conversations and read their messages' },
  // Tightened: sends onBehalfOf the human.
  { scope: 'messages:write', connector: 'mcp', verb: 'write', surface: 'messages', classification: SELF_ONLY, surfaces: MCP_TOKENS, releaseOverride: 'on-consent',
    label: 'Send messages on your behalf', manifestLabel: 'Send messages in your conversations on your behalf' },

  { scope: 'attestations:read', connector: null, label: 'View your attestations and reputation' },
  { scope: 'attestations:write', connector: null, label: 'Issue attestations on your behalf' },
  { scope: 'availability:read', connector: null, label: 'View your availability and coordination intents' },
  { scope: 'availability:write', connector: null, label: 'Set and cancel availability intents on your behalf' },
  { scope: 'infer:provide', connector: null, label: 'Provide app-owned inference credentials for delegated inference' },

  // ── QuickBooks connector — invoices are sent to customers, hence write touches others
  { scope: 'quickbooks:read', connector: 'quickbooks', verb: 'read', surface: 'invoices', classification: SELF_ONLY,
    label: 'Read your QuickBooks invoices as supply-chain settlement signals', manifestLabel: 'Read your QuickBooks invoices' },
  { scope: 'quickbooks:write', connector: 'quickbooks', verb: 'write', surface: 'invoices', classification: TOUCHES_OTHERS,
    label: 'Create QuickBooks invoices on your behalf (supply-chain settlement)', manifestLabel: 'Create QuickBooks invoices' },

  // ── GitHub connector
  { scope: 'github:read', connector: 'github', verb: 'read', surface: 'repos', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read your repos, issues and PRs on GitHub', manifestLabel: 'Read your own repos, issues and PRs', uiLabel: 'Read your repos, issues and PRs' },
  { scope: 'github:write', connector: 'github', verb: 'write', surface: 'issues', classification: SELF_ONLY, surfaces: MCP_TOKENS, releaseOverride: 'on-consent',
    label: 'Open and comment on issues & PRs on your GitHub repos', manifestLabel: 'Open and comment on issues & PRs on your repos', uiLabel: 'Create issues and comments on your repos' },
  { scope: 'github:org', connector: 'github', verb: 'write', surface: 'org', classification: TOUCHES_OTHERS, surfaces: MCP_TOKENS,
    label: 'Act on repos owned by an org or other people on GitHub', manifestLabel: 'Act on repos owned by an org or other people' },
  { scope: 'github:actions', connector: 'github', verb: 'execute', surface: 'actions', classification: TOUCHES_OTHERS_SENSITIVE, surfaces: MCP_TOKENS,
    label: 'Trigger GitHub Actions / deploy / spend CI minutes', manifestLabel: 'Trigger Actions / deploy / spend CI minutes' },

  // ── Discord connector — both scopes act on shared channels, so both touch others
  { scope: 'discord:post', connector: 'discord', verb: 'post', surface: 'channels', classification: TOUCHES_OTHERS,
    label: 'Post messages to Discord channels on your behalf', manifestLabel: 'Post messages to Discord channels' },
  { scope: 'discord:read', connector: 'discord', verb: 'read', surface: 'channels', classification: TOUCHES_OTHERS,
    label: 'Read messages from Discord channels on your behalf', manifestLabel: 'Read messages from Discord channels' },

  // ── Gemini connector — was missing from SCOPES entirely before #1253, so
  // validateScopes() rejected it and the consent screens had no label for it.
  // Consumes the owner's own sealed API key → SELF_SENSITIVE → owner-only.
  { scope: 'gemini:infer', connector: 'gemini', verb: 'infer', surface: 'gemini-api', classification: SELF_SENSITIVE,
    label: 'Use your Gemini API key for inference' },

  // ── Anthropic connector (#1621) — the second brain a DID can seal.
  // Same shape as gemini:infer: the owner's own key is consumed on every call
  // and never released to a third party → SELF_SENSITIVE → owner-only.
  { scope: 'anthropic:infer', connector: 'anthropic', verb: 'infer', surface: 'anthropic-api', classification: SELF_SENSITIVE,
    label: 'Use your Anthropic API key for inference' },

  // ── Warp connector (#1428) — per-DID Warp Cloud Agent key.
  // Consumes the owner's own sealed Agent key to spawn cloud agents under their
  // service-account identity → SELF_SENSITIVE → owner-only. Carried by MCP
  // tokens so a `{username}-jin` speaking MCP can dispatch (Wire B), which is
  // the whole point: the credential individuates the dispatch.
  { scope: 'warp:dispatch', connector: 'warp', verb: 'dispatch', surface: 'cloud-agents', classification: SELF_SENSITIVE, surfaces: MCP_TOKENS,
    label: 'Dispatch Warp cloud agents using your sealed Warp Agent key', manifestLabel: 'Dispatch Warp cloud agents under your own credential' },
  // Read-only self-description of the node (#1636): the OpenAPI specs it serves,
  // the scope vocabulary itself, and the caller's OWN connector grant state. A
  // dispatched cloud agent that can read these starts from what the system
  // actually exposes instead of grepping source and guessing, which is where the
  // stale assumptions — and the failed PRs — come from.
  //
  // Owned by the Warp connector because that is who needs it and who it is
  // granted to; carried by MCP tokens because the dev kernel's MCP endpoint is
  // the wire the agent reads over.
  //
  // SELF_ONLY → `silent`: every byte is either already public (the specs) or the
  // owner's own connector state, and nothing here is credential-grade — the
  // sealed keys themselves stay behind `warp:dispatch`. Reads only; there is no
  // write counterpart, by design (writes go through git/PR).
  { scope: 'discovery:read', connector: 'warp', verb: 'read', surface: 'discovery', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read Imajin API specs, the scope vocabulary, and your connector status',
    manifestLabel: 'Read the node API specs, scope vocabulary, and your connector status',
    uiLabel: 'Read API specs, scope vocabulary, and your connector status' },

  // ── MCP inference surface (#1298) — decoupled from media:*
  //
  // The inference MCP tools used to gate on `media:write` / `media:read`, so any
  // agent that could upload a file could also run the intention-inference
  // pipeline and have a supply attestation signed on the owner's behalf. These
  // are MCP-surface scopes, not provider scopes: `gemini:infer` /
  // `anthropic:infer` stay where they are, since those name whose API key gets
  // spent, not who may drive the pipeline.
  //
  // Appended rather than slotted into the MCP block above so the externally
  // visible `scopes_supported` ordering only grows at the tail.
  { scope: 'inference:read', connector: 'mcp', verb: 'read', surface: 'inference', classification: SELF_ONLY, surfaces: MCP_TOKENS,
    label: 'Read inference session results', manifestLabel: 'Read inference session status and attestations' },
  // Signs attestations on the owner's behalf — same quadrant as `gemini:infer`
  // (SELF_SENSITIVE), so the 2×2 derives `owner-only` and publishing it writes a
  // consent row. Deliberately stricter than `media:write`'s on-consent override.
  { scope: 'inference:write', connector: 'mcp', verb: 'write', surface: 'inference', classification: SELF_SENSITIVE, surfaces: MCP_TOKENS,
    label: 'Trigger inference and sign attestations', manifestLabel: 'Trigger the inference pipeline and sign attestations on your behalf' },
] as const satisfies readonly ScopeVocabularyEntry[];

/** Every scope string in the vocabulary, as a literal union. */
export type Scope = (typeof SCOPE_VOCABULARY)[number]['scope'];

/** Widened view for runtime iteration and narrowing. */
const ENTRIES: readonly ScopeVocabularyEntry[] = SCOPE_VOCABULARY;

// ── Derivation ────────────────────────────────────────────────────────────────

/** True for entries owned by a connector (narrows the union). */
export function isConnectorScope(entry: ScopeVocabularyEntry): entry is ConnectorScopeEntry {
  return entry.connector !== null;
}

/**
 * Resolve a scope's release tier from the #1196 2×2, honouring an explicit
 * override. Semantics match `deriveReleaseTier` in `@imajin/fair`; a
 * conformance test pins the two together across all four quadrants.
 */
export function deriveScopeReleaseTier(entry: ConnectorScopeEntry): ScopeReleaseTier {
  if (entry.releaseOverride) return entry.releaseOverride;
  const { disclosesOthers, sensitive } = entry.classification;
  if (!disclosesOthers && !sensitive) return 'silent';
  if (disclosesOthers && !sensitive) return 'on-consent';
  if (!disclosesOthers && sensitive) return 'owner-only';
  return 'never';
}

/**
 * The `viewer` recorded in the manifest release block, or undefined.
 *
 * Derived rather than declared: a viewer is meaningful exactly when the scope
 * is released to the connector under a consent barrier. `silent` scopes need no
 * named viewer, and `never` scopes are never released to anyone.
 */
export function viewerForScope(entry: ConnectorScopeEntry): string | undefined {
  const tier = deriveScopeReleaseTier(entry);
  if (tier === 'on-consent' || tier === 'owner-only') return CONNECTOR_DIDS[entry.connector];
  return undefined;
}

/** Label shown on the connector card. */
export function uiLabelForScope(entry: ConnectorScopeEntry): string {
  return entry.uiLabel ?? entry.manifestLabel ?? entry.label;
}

/** Label written into the signed scope-manifest asset. */
export function manifestLabelForScope(entry: ConnectorScopeEntry): string {
  return entry.manifestLabel ?? entry.label;
}

// ── Lookups ───────────────────────────────────────────────────────────────────

const BY_SCOPE = new Map<string, ScopeVocabularyEntry>(ENTRIES.map((e) => [e.scope, e]));

/** Look up one entry, or undefined for an unknown scope string. */
export function scopeEntry(scope: string): ScopeVocabularyEntry | undefined {
  return BY_SCOPE.get(scope);
}

/** True iff the scope exists in the vocabulary. */
export function isKnownScope(scope: string): scope is Scope {
  return BY_SCOPE.has(scope);
}

/** Every entry owned by `connector`, in vocabulary order. */
export function scopesForConnector(connector: ConnectorId): readonly ConnectorScopeEntry[] {
  return ENTRIES.filter(isConnectorScope).filter((e) => e.connector === connector);
}

/**
 * Every scope string a token for `surface` may carry, in vocabulary order.
 * This is the capability ceiling — not a grant.
 */
export function scopesForSurface(surface: CapabilitySurface): readonly string[] {
  return ENTRIES.filter((e) => e.surfaces?.includes(surface) ?? false).map((e) => e.scope);
}

/** All scope strings, in vocabulary order. */
export function allScopes(): readonly Scope[] {
  return ENTRIES.map((e) => e.scope as Scope);
}
