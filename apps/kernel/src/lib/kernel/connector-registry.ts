/**
 * Static connector registry (#1354).
 *
 * Single source of truth for the connectors the platform supports. The
 * Connectors page (`/connections/connectors`) is registry-driven: adding a
 * new connector is a registry entry + its backend routes, NOT a page rewrite.
 *
 * IMPORTANT: this file must remain client-safe (no node: imports, no DB, no
 * vault) so it can be imported by both server routes and client components.
 *
 * Resolution from #1354 pre-implementation review:
 * - Registry shape: static TypeScript object (consistent with GITHUB_SCOPE_DESCRIPTORS)
 * - Ingestion patterns: 'oauth' (GitHub, QuickBooks) | 'token-paste' (Discord)
 * - statusEndpoint: null = backend not yet implemented (#1355, #1356)
 *
 * Scope release classes (#1196 consent 2×2):
 *   silent    — freely projectable; materialises on manifest publish
 *   on-consent — materialises only when a consent_grants row exists
 *   never      — structural drop; never materialises
 */

/** How the connector ingests credentials. */
export type IngestionPattern = 'oauth' | 'token-paste';

/** Release class from the #1196 consent 2×2. */
export type ReleaseClass = 'silent' | 'on-consent' | 'never';

/** One grantable scope for a connector. */
export interface ConnectorScope {
  /** Scope identifier, e.g. `github:read`. */
  name: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Release tier — determines if this scope materialises immediately or needs consent. */
  releaseClass: ReleaseClass;
}

/**
 * A single connector in the registry. All fields are optional-friendly to let
 * entries with `backendPending: true` omit routes they don't have yet.
 */
export interface ConnectorEntry {
  /** Stable lowercase id, e.g. `'github'`. */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  /** Short description of what this connector enables. */
  description: string;
  /** Emoji icon for the connector card. */
  icon: string;
  /** Credential ingestion pattern declared by this connector. */
  ingestionPattern: IngestionPattern;
  /** Channel label used in `auth.channel_links`, e.g. `'github'`. */
  channel: string;
  /** Connector app DID, e.g. `'did:imajin:github-connector'`. */
  connectorDid: string;
  /**
   * Grantable scopes, in display order. Omit scopes with `never` release class
   * (e.g. `github:actions`) — they can never materialise and are confusing to show.
   */
  scopes: ConnectorScope[];
  /**
   * Route for the scope-manifest status GET endpoint.
   * `null` when the backend publish path is not yet implemented (#1355, #1356).
   */
  statusEndpoint: string | null;
  /**
   * True when the backend for this connector (scope-manifest route + credential
   * ingestion) is not yet implemented. The Connectors page renders these rows
   * as "backend pending" without making API calls.
   */
  backendPending: boolean;
  /**
   * For OAuth connectors: the route that starts the OAuth2 authorize redirect.
   * The UI navigates (GET) to this URL in the browser.
   */
  connectRoute: string | null;
  /**
   * For OAuth connectors: the POST route for sealing the OAuth App config
   * (clientId, clientSecret, redirectUri).
   */
  configureRoute: string | null;
  /**
   * For token-paste connectors (Pattern B): the POST route for sealing the
   * credential token in-app. `null` for OAuth connectors.
   */
  tokenRoute: string | null;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const CONNECTOR_REGISTRY: readonly ConnectorEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read and write GitHub issues, PRs, and comments on your behalf.',
    icon: '🐙',
    ingestionPattern: 'oauth',
    channel: 'github',
    connectorDid: 'did:imajin:github-connector',
    scopes: [
      {
        name: 'github:read',
        label: 'Read your repos, issues and PRs',
        releaseClass: 'silent',
      },
      {
        name: 'github:write',
        label: 'Create issues and comments on your repos',
        releaseClass: 'on-consent',
      },
      {
        name: 'github:org',
        label: 'Act on repos owned by an org or other people',
        releaseClass: 'on-consent',
      },
    ],
    statusEndpoint: '/github/api/scope-manifest',
    backendPending: false,
    connectRoute: '/github/api/connect',
    configureRoute: '/github/api/configure',
    tokenRoute: null,
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Post messages and read channels via a Discord Bot Token.',
    icon: '🎮',
    ingestionPattern: 'token-paste',
    channel: 'discord',
    connectorDid: 'did:imajin:discord-connector',
    scopes: [
      {
        name: 'discord:post',
        label: 'Post messages to Discord channels',
        releaseClass: 'on-consent',
      },
      {
        name: 'discord:read',
        label: 'Read messages from Discord channels',
        releaseClass: 'on-consent',
      },
    ],
    statusEndpoint: '/discord/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: '/discord/api/token',
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    description: 'Read and write QuickBooks Online invoices via OAuth2.',
    icon: '📒',
    ingestionPattern: 'oauth',
    channel: 'quickbooks',
    connectorDid: 'did:imajin:quickbooks-connector',
    scopes: [
      {
        name: 'quickbooks:read',
        label: 'Read your QuickBooks invoices',
        releaseClass: 'silent',
      },
      {
        name: 'quickbooks:write',
        label: 'Create QuickBooks invoices',
        releaseClass: 'on-consent',
      },
    ],
    statusEndpoint: '/quickbooks/api/scope-manifest',
    backendPending: false,
    connectRoute: '/quickbooks/api/connect',
    configureRoute: '/quickbooks/api/configure',
    tokenRoute: null,
  },
] as const;

/** Look up a connector entry by its id. Returns undefined for unknown ids. */
export function getConnector(id: string): ConnectorEntry | undefined {
  return CONNECTOR_REGISTRY.find((c) => c.id === id);
}
