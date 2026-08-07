/**
 * Connector scope projections (#1253).
 *
 * Computes every per-connector scope artefact from the one declarative table in
 * `@imajin/auth/scope-vocabulary`:
 *   - `*_SCOPE_DESCRIPTORS` — the manifest descriptor map each connector's
 *     scope-manifest wrapper used to hand-maintain.
 *   - `VALID_*_SCOPES`      — the fail-closed POST validator allowlist.
 *   - release class         — previously a `*ScopeReleaseClass()` function
 *     copy-pasted into all five connector wrappers.
 *   - `ConnectorEntry.scopes` — the connector-card toggle list.
 *
 * These were five independently-maintained lists. #1393 shipped `messages:*`
 * into four of them and missed the fifth, so the scope worked server-side but
 * rendered no toggle and was ungrantable in prod. Deriving them makes that
 * class of bug unrepresentable.
 *
 * IMPORTANT: this module must remain client-safe (no `node:` imports, no DB, no
 * vault) because `connector-registry.ts` and the connector card import it. It
 * deliberately imports the `@imajin/auth/scope-vocabulary` subpath rather than
 * the `@imajin/auth` index, which pulls in DB-backed server code.
 */
import {
  type ConnectorId,
  type ConnectorScopeEntry,
  type ScopeReleaseTier,
  type ScopeReleaseOverride,
  SCOPE_VOCABULARY,
  deriveScopeReleaseTier,
  isConnectorScope,
  isCredentialFreeScope,
  manifestLabelForScope,
  uiLabelForScope,
  scopesForConnector,
  scopesForSurface,
  viewerForScope,
} from '@imajin/auth/scope-vocabulary';

export type { ConnectorId, ScopeReleaseTier };

// ── Manifest descriptors ──────────────────────────────────────────────────────

/**
 * One scope as it appears in a signed connector scope-manifest asset.
 *
 * Field names are snake_case because they are serialised verbatim into the
 * manifest's YAML frontmatter by `buildConnectorManifestContent`.
 */
export interface ConnectorScopeDescriptor {
  verb: string;
  surface: string;
  label: string;
  release: {
    discloses_others: boolean;
    sensitive: boolean;
    release?: ScopeReleaseOverride;
    viewer?: string;
  };
}

/**
 * Project one vocabulary entry into its manifest descriptor.
 *
 * `release` and `viewer` are emitted only when present, because
 * `buildConnectorManifestContent` skips undefined keys and the resulting bytes
 * are signed — adding a key would rewrite every existing owner's manifest.
 */
function toDescriptor(entry: ConnectorScopeEntry): ConnectorScopeDescriptor {
  const release: ConnectorScopeDescriptor['release'] = {
    discloses_others: entry.classification.disclosesOthers,
    sensitive: entry.classification.sensitive,
  };
  if (entry.releaseOverride !== undefined) release.release = entry.releaseOverride;

  const viewer = viewerForScope(entry);
  if (viewer !== undefined) release.viewer = viewer;

  return {
    verb: entry.verb,
    surface: entry.surface,
    label: manifestLabelForScope(entry),
    release,
  };
}

/** The manifest descriptor map for one connector, in vocabulary order. */
export function connectorScopeDescriptors(
  connector: ConnectorId,
): Readonly<Record<string, ConnectorScopeDescriptor>> {
  return Object.fromEntries(
    scopesForConnector(connector).map((entry) => [entry.scope, toDescriptor(entry)]),
  );
}

/** Every scope string this connector's scope-manifest POST accepts. */
export function validScopesForConnector(connector: ConnectorId): string[] {
  return scopesForConnector(connector).map((entry) => entry.scope);
}

// ── Release classification ────────────────────────────────────────────────────

/**
 * Release class for one scope of one connector.
 *
 * Returns `never` for a scope this connector does not own, preserving the
 * fail-closed behaviour of the per-connector functions this replaces.
 */
export function scopeReleaseClass(connector: ConnectorId, scopeName: string): ScopeReleaseTier {
  const entry = scopesForConnector(connector).find((e) => e.scope === scopeName);
  if (!entry) return 'never';
  return deriveScopeReleaseTier(entry);
}

/**
 * True when publishing this scope must also write a `consent_grants` row.
 *
 * Both `on-consent` and `owner-only` sit behind a consent barrier — they differ
 * in who may ever be a viewer, not in whether the owner's grant is recorded.
 * `silent` needs no row and `never` can never materialise.
 */
export function requiresConsentRow(connector: ConnectorId, scopeName: string): boolean {
  const tier = scopeReleaseClass(connector, scopeName);
  return tier === 'on-consent' || tier === 'owner-only';
}

// ── Connector-card UI list ────────────────────────────────────────────────────

/** Release class as surfaced to the connector card. */
export type ReleaseClass = ScopeReleaseTier;

/** One grantable scope as rendered on a connector card. */
export interface ConnectorScope {
  /** Scope identifier, e.g. `github:read`. */
  name: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Release tier — determines whether this scope needs consent to materialise. */
  releaseClass: ReleaseClass;
  /**
   * True when exercising the scope consumes no sealed credential (#1679), so the
   * card may offer its toggle before — or without — the credential step.
   */
  credentialFree: boolean;
}

/**
 * The connector card's toggle list, in vocabulary order.
 *
 * `never` scopes (e.g. `github:actions`) are omitted: they can never
 * materialise, so showing a permanently-dead toggle only confuses people.
 */
export function connectorUiScopes(connector: ConnectorId): ConnectorScope[] {
  return scopesForConnector(connector)
    .map((entry) => ({
      name: entry.scope,
      label: uiLabelForScope(entry),
      releaseClass: deriveScopeReleaseTier(entry),
      credentialFree: isCredentialFreeScope(entry),
    }))
    .filter((scope) => scope.releaseClass !== 'never');
}

// ── Discovery catalogue (#1636) ───────────────────────────────────────────────

/**
 * One scope as reported by the read-only discovery surface.
 *
 * A sixth projection of the same table, and the one an agent reads: it answers
 * "what may I ask for, and what would granting it mean" without the agent having
 * to open `scope-vocabulary.ts` and infer the 2×2 by hand.
 */
export interface ScopeCatalogueEntry {
  /** The scope string, e.g. `media:read`. */
  scope: string;
  /** Consent-screen label, written from the owner's point of view. */
  label: string;
  /** Owning connector, or `null` for a platform scope granted via OAuth consent. */
  connector: ConnectorId | null;
  /**
   * Release tier for connector-owned scopes, or `null` for platform scopes —
   * those carry no #1196 classification, so reporting a tier would invent one.
   */
  releaseClass: ScopeReleaseTier | null;
  /** True when an MCP access token may carry this scope (the capability ceiling). */
  mcpToken: boolean;
}

/**
 * The whole vocabulary, in vocabulary order.
 *
 * Includes `never`-class scopes, unlike {@link connectorUiScopes}: a dead toggle
 * confuses a person, but an agent reading the catalogue is better off knowing the
 * scope exists and can never materialise than concluding it is available.
 */
export function scopeCatalogue(): ScopeCatalogueEntry[] {
  const mcpCeiling = new Set(scopesForSurface('mcp'));

  return SCOPE_VOCABULARY.map((entry) => ({
    scope: entry.scope,
    label: entry.label,
    connector: entry.connector,
    releaseClass: isConnectorScope(entry) ? deriveScopeReleaseTier(entry) : null,
    mcpToken: mcpCeiling.has(entry.scope),
  }));
}
