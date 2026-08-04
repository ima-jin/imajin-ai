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
 * - Ingestion patterns: 'oauth' (GitHub, QuickBooks) | 'token-paste' (Discord) | 'static-secret' (#1439, delegation-grant sealed API keys)
 * - statusEndpoint: null = backend not yet implemented (#1355, #1356)
 *
 * Scope lists are DERIVED (#1253): `scopes` on each entry is projected from the
 * declarative vocabulary in `packages/auth/src/scope-vocabulary.ts` by
 * `connectorUiScopes()`. Do NOT hand-write them here — that is precisely how
 * #1393 shipped `messages:*` to prod with no toggle to grant it: the scope was
 * declared everywhere else and missed in this file, which is the list the
 * toggles at /auth/connectors/<id> actually render from.
 *
 * Scope release classes (#1196 consent 2×2):
 *   silent     — freely projectable; materialises on manifest publish
 *   on-consent — materialises only when a consent_grants row exists
 *   owner-only — never released to a third party; the owner grants it explicitly
 *   never      — structural drop; never materialises (omitted from the UI list)
 */
import { connectorUiScopes } from './scope-projections';

/** How the connector ingests credentials. */
export type IngestionPattern = 'oauth' | 'token-paste' | 'native' | 'static-secret';

// Release class and per-scope shape now live in ./scope-projections alongside
// the derivation, and are re-exported here so existing importers (the connector
// card, ConnectorDetail) keep working unchanged. The local import is separate
// because a re-export alone does not bring the name into this module's scope,
// and `ConnectorEntry.scopes` below refers to it.
export type { ReleaseClass, ConnectorScope } from './scope-projections';
import type { ConnectorScope } from './scope-projections';

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
   * Grantable scopes, in display order. Derived via `connectorUiScopes()`, which
   * drops `never`-class scopes (e.g. `github:actions`) since they can never
   * materialise and a permanently-dead toggle only confuses people.
   */
  scopes: ConnectorScope[];
  /**
   * Route for the scope-manifest status GET endpoint.
   * `null` for future connectors whose backend is not yet implemented.
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
  /**
   * POST route that disconnects the connector — purges sealed credentials,
   * revokes the channel_links grant, and publishes a bus event.
   * `null` for connectors that do not yet implement disconnect (e.g. native, pending).
   */
  disconnectRoute: string | null;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const CONNECTOR_REGISTRY: readonly ConnectorEntry[] = [
  {
    id: 'mcp',
    name: 'Claude / MCP',
    description: 'Grant Claude Desktop access to your media, connections, and other Imajin capabilities.',
    icon: '🤖',
    ingestionPattern: 'native',
    channel: 'mcp',
    connectorDid: 'did:imajin:mcp-connector',
    scopes: connectorUiScopes('mcp'),
    statusEndpoint: '/mcp/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: null,
    disconnectRoute: null,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Read and write GitHub issues, PRs, and comments on your behalf.',
    icon: '🐙',
    ingestionPattern: 'oauth',
    channel: 'github',
    connectorDid: 'did:imajin:github-connector',
    scopes: connectorUiScopes('github'),
    statusEndpoint: '/github/api/scope-manifest',
    backendPending: false,
    connectRoute: '/github/api/connect',
    configureRoute: '/github/api/configure',
    tokenRoute: null,
    disconnectRoute: '/github/api/disconnect',
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Post messages and read channels via a Discord Bot Token.',
    icon: '🎮',
    ingestionPattern: 'token-paste',
    channel: 'discord',
    connectorDid: 'did:imajin:discord-connector',
    scopes: connectorUiScopes('discord'),
    statusEndpoint: '/discord/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: '/discord/api/token',
    disconnectRoute: '/discord/api/disconnect',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Seal your own Gemini API key per-DID so inference uses your credential instead of the global env var.',
    icon: '✨',
    ingestionPattern: 'token-paste',
    channel: 'gemini',
    connectorDid: 'did:imajin:gemini-connector',
    scopes: connectorUiScopes('gemini'),
    statusEndpoint: '/gemini/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: '/gemini/api/token',
    disconnectRoute: null,
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    description: 'Read and write QuickBooks Online invoices via OAuth2.',
    icon: '📒',
    ingestionPattern: 'oauth',
    channel: 'quickbooks',
    connectorDid: 'did:imajin:quickbooks-connector',
    scopes: connectorUiScopes('quickbooks'),
    statusEndpoint: '/quickbooks/api/scope-manifest',
    backendPending: false,
    connectRoute: '/quickbooks/api/connect',
    configureRoute: '/quickbooks/api/configure',
    tokenRoute: null,
    disconnectRoute: '/quickbooks/api/disconnect',
  },
  {
    id: 'warp',
    name: 'Warp Cloud Agents',
    description: 'Seal your own Warp Agent key per-DID so cloud agents you dispatch run under your credential, not a shared one.',
    icon: '🛰️',
    ingestionPattern: 'static-secret',
    channel: 'warp',
    connectorDid: 'did:imajin:warp-connector',
    scopes: connectorUiScopes('warp'),
    statusEndpoint: '/warp/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: '/warp/api/seal',
    // Same endpoint as tokenRoute: the static-secret factory serves POST (seal)
    // and DELETE (revoke the delegation grant) from one route.
    disconnectRoute: '/warp/api/seal',
  },
] as const;

/** Look up a connector entry by its id. Returns undefined for unknown ids. */
export function getConnector(id: string): ConnectorEntry | undefined {
  return CONNECTOR_REGISTRY.find((c) => c.id === id);
}
