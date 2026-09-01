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
import {
  connectorUiScopes,
  type ConnectorId,
  type ConnectorScope,
  type ReleaseClass,
} from './scope-projections';

/** How the connector ingests credentials. */
export type IngestionPattern = 'oauth' | 'token-paste' | 'native' | 'static-secret';

// Release class and per-scope shape live in ./scope-projections alongside the
// derivation, and are re-exported here (from the single import above, rather
// than a second `from './scope-projections'` clause) so existing importers
// (the connector card, ConnectorDetail) keep working unchanged.
export type { ReleaseClass, ConnectorScope };

/**
 * Per-connector copy for the credential-paste step (#1604).
 *
 * The generic `CredentialPasteConnectorCard` renders identically for every
 * paste-style connector; only these strings differ ("Bot Token" vs "API key").
 * Declaring them here is what makes adding a paste-style connector a registry
 * entry rather than a new component plus a dispatcher line.
 */
export interface CredentialUiCopy {
  /** Step heading, e.g. `'Bot Token'`. Also used for the sealed-state label. */
  label: string;
  /** Input placeholder, e.g. `'Discord Bot Token'`. */
  placeholder: string;
  /** Help text under the input — say where the credential comes from. */
  hint: string;
}

/**
 * One non-secret configuration value on a connector card (#1632).
 *
 * Distinct from `credentialUi`, which describes the *credential* step: a setting
 * is a plain preference that is safe to read back and display, so the card renders
 * it as a text input showing the current value rather than a write-only password
 * field.
 */
export interface ConnectorSettingField {
  /**
   * Field name, used verbatim as both the JSON key on the settings route and the
   * property read back from its GET response, e.g. `'environmentId'`.
   */
  key: string;
  /** Section heading, e.g. `'Default Environment'`. */
  label: string;
  /** Input placeholder — ideally an example value. */
  placeholder: string;
  /** Help text under the input: what this changes, and what unset means. */
  hint: string;
}

/**
 * A connector's non-secret settings section, if it has one (#1632).
 *
 * Declared here rather than branched on in the card for the same reason the rest
 * of this registry exists: #1604 shipped two connectors whose backends were live
 * but whose UI said "Coming soon", because rendering was keyed off connector id
 * instead of derived from data. A settings section any connector can opt into by
 * adding a registry entry cannot repeat that.
 */
export interface ConnectorSettingsUi {
  /**
   * Route serving `GET` (read current values), `PUT` (store one), and `DELETE`
   * (clear one). Deliberately separate from `tokenRoute`: settings are not
   * credentials, and overloading the seal route's `DELETE` would make it
   * ambiguous between revoking a credential and clearing a preference.
   */
  route: string;
  /** Settings to render, in display order. */
  fields: readonly ConnectorSettingField[];
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
   * `null` for connectors that do not yet implement disconnect (e.g. pending).
   *
   * Static-secret connectors serve seal and revoke from one route, so theirs
   * equals `tokenRoute` and is called with DELETE (see `disconnectMethod`).
   *
   * Native connectors have no credential to purge, so theirs is a revoke-all
   * (#1592): it republishes the scope-manifest empty, which withdraws every
   * grant through the same rail a toggle uses.
   */
  disconnectRoute: string | null;
  /**
   * Credential-step copy for paste-style connectors (`token-paste`,
   * `static-secret`). `null` for patterns with no paste step — native connectors
   * have no credential, and OAuth connectors collect theirs via redirect.
   */
  credentialUi: CredentialUiCopy | null;
  /**
   * Non-secret configuration the card lets the owner edit, or `null` when the
   * connector has nothing to configure beyond its credential and scopes.
   */
  settings: ConnectorSettingsUi | null;
  /**
   * Route backing a dynamic model picker (#1769): `GET` returns
   * `{ models: [{ id, name }], currentModelId }`; `PUT` seals `{ modelId }`.
   * `null` for connectors with no model choice (most of them).
   *
   * Distinct from `settings`, whose fields are plain text inputs the card
   * already knows the shape of — a model list is fetched live from the
   * provider using the owner's own sealed credential, so it needs its own
   * route rather than a `ConnectorSettingField`.
   */
  modelsRoute: string | null;
}

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Shared shape for the token-paste "brain" connectors — the ones whose sealed
 * API key is spent on inference (Gemini, xAI; #1928). They share every field
 * except identity, credential-step copy, and whether they have a model
 * picker: no OAuth step, no settings section, and a disconnect that revokes
 * the delegation grant (#1720) and sweeps channel_links (#1733). Declaring
 * that shape once here is what keeps the next brain connector's registry
 * entry (#1927 OpenAI, #1930 Moonshot, #1931 Z.ai) a same-shape call instead
 * of a ~30-line clone.
 */
function brainConnectorEntry(opts: {
  id: ConnectorId;
  name: string;
  description: string;
  icon: string;
  credentialUi: CredentialUiCopy;
  /** `null` for connectors with no dynamic model picker (#1769). */
  modelsRoute: string | null;
}): ConnectorEntry {
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description,
    icon: opts.icon,
    ingestionPattern: 'token-paste',
    channel: opts.id,
    connectorDid: `did:imajin:${opts.id}-connector`,
    scopes: connectorUiScopes(opts.id),
    statusEndpoint: `/${opts.id}/api/scope-manifest`,
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: `/${opts.id}/api/token`,
    disconnectRoute: `/${opts.id}/api/disconnect`,
    credentialUi: opts.credentialUi,
    settings: null,
    modelsRoute: opts.modelsRoute,
  };
}

/**
 * Gemini's registry entry (#1928): declared once here, referenced by name
 * below, so the array itself keeps the exact literal shape every other
 * entry uses — nothing about `CONNECTOR_REGISTRY`'s own structure changes.
 */
const GEMINI_ENTRY = brainConnectorEntry({
  id: 'gemini',
  name: 'Google Gemini',
  description: 'Seal your own Gemini API key per-DID so inference uses your credential instead of the global env var.',
  icon: '✨',
  credentialUi: {
    label: 'API Key',
    placeholder: 'Gemini API Key',
    hint: 'Key is sealed server-side and never returned. Create one in Google AI Studio → Get API key.',
  },
  // #1769: dynamic model picker — GET lists live models for the sealed key,
  // PUT seals the choice. Replaces the hardcoded `defaultModelId` that went
  // stale when Google retired gemini-2.0-flash (#1764).
  modelsRoute: '/gemini/api/models',
});

/** xAI's registry entry (#1928) — see {@link GEMINI_ENTRY}. */
const XAI_ENTRY = brainConnectorEntry({
  id: 'xai',
  name: 'xAI Grok',
  description: 'Seal your own xAI API key per-DID so Grok inference runs on your credential, not a shared env var.',
  icon: '🚀',
  credentialUi: {
    label: 'API Key',
    placeholder: 'xAI API Key (xai-...)',
    hint: 'Key is sealed server-side and never returned. Create one at console.x.ai → API Keys.',
  },
  // #1924, following #1769: no hardcoded default model. Grok ids turn over
  // fast enough that a baked-in string would go stale the same way
  // gemini-2.0-flash did (#1764), so the owner picks a live one here and it
  // is sealed as `modelId`.
  modelsRoute: '/xai/api/models',
});

export const CONNECTOR_REGISTRY: readonly ConnectorEntry[] = [
  {
    id: 'mcp',
    name: 'Imajin MCP',
    // #1679: the card now also carries `discovery:read`, the credential-free read
    // of the node's own API specs and your connector status. It lives here because
    // this connector needs no credential at all — the toggle is the whole grant.
    description: 'Grant any MCP client access to your media, connections, API specs, and other Imajin capabilities.',
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
    // #1592: native revoke-all. No credential exists to purge, so this route
    // republishes the scope-manifest with an empty scope set — every mcp
    // channel_links row for the caller's DID flips to `revoked`. Without it the
    // only way off MCP was untoggling scopes one at a time.
    disconnectRoute: '/mcp/api/disconnect',
    credentialUi: null,
    settings: null,
    modelsRoute: null,
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
    credentialUi: null,
    settings: null,
    modelsRoute: null,
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
    credentialUi: {
      label: 'Bot Token',
      placeholder: 'Discord Bot Token',
      hint: 'Token is sealed server-side and never returned. Found in Discord Developer Portal → Bot → Token.',
    },
    settings: null,
    modelsRoute: null,
  },
  GEMINI_ENTRY,
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Seal your own Anthropic API key per-DID so inference runs on your credential, not a shared env var.',
    icon: '🧠',
    ingestionPattern: 'token-paste',
    channel: 'anthropic',
    connectorDid: 'did:imajin:anthropic-connector',
    scopes: connectorUiScopes('anthropic'),
    statusEndpoint: '/anthropic/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: '/anthropic/api/token',
    // #1720: revokes the sealed key's delegation grant (kernel.vault_delegation_grants).
    disconnectRoute: '/anthropic/api/disconnect',
    credentialUi: {
      label: 'API Key',
      placeholder: 'Anthropic API Key',
      hint: 'Key is sealed server-side and never returned. Create one in the Anthropic Console → API keys.',
    },
    settings: null,
    modelsRoute: null,
  },
  XAI_ENTRY,
  {
    id: 'gcp',
    name: 'Google Cloud',
    description: 'Connect your GCP service account for Vertex AI inference and cloud operations.',
    icon: '☁️',
    ingestionPattern: 'token-paste',
    channel: 'gcp',
    connectorDid: 'did:imajin:gcp-connector',
    scopes: connectorUiScopes('gcp'),
    statusEndpoint: '/gcp/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: '/gcp/api/token',
    // #1720: revokes the sealed key's delegation grant (kernel.vault_delegation_grants).
    disconnectRoute: '/gcp/api/disconnect',
    // The credential is a whole service-account key JSON rather than an opaque
    // key string, so the copy has to say so — a card labelled "API Key" would have
    // people pasting the client_email and wondering why nothing worked.
    credentialUi: {
      label: 'Service Account Key',
      placeholder: 'GCP service account key JSON',
      hint: 'Paste the whole key JSON. It is sealed server-side and never returned. Create one in Google Cloud Console → IAM & Admin → Service Accounts → Keys.',
    },
    settings: null,
    modelsRoute: null,
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
    credentialUi: null,
    settings: null,
    modelsRoute: null,
  },
  {
    id: 'warp',
    name: 'Warp Cloud Agents',
    // #1679: `discovery:read` moved to the MCP connector, so this card is back to
    // describing exactly one thing — what the sealed Agent key buys. Naming a read
    // surface it no longer grants would send people here for a toggle that is not.
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
    credentialUi: {
      label: 'Agent Key',
      placeholder: 'Warp Agent Key',
      hint: 'Key is sealed server-side and never returned. Revoking here kills dispatch immediately without rotating the key.',
    },
    // #1632: the environment default is stored per-DID, not in an env var, so the
    // card is where it is set. Unset falls back to the node DID's default.
    settings: {
      route: '/warp/api/environment',
      fields: [
        {
          key: 'environmentId',
          label: 'Default Environment',
          placeholder: 'e.g. L2DO7swtN7Ku3G7gVPwziI',
          hint: 'Cloud environment your dispatches use when they name none — a persistent workspace with the repo cloned and dependencies installed. Leave unset to inherit the node default, or run in a bare sandbox if there is none.',
        },
      ],
    },
    modelsRoute: null,
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Bring your own Stripe restricted key so reactors can act on your payment events — no Stripe Connect, no shared platform account.',
    icon: '💳',
    ingestionPattern: 'token-paste',
    channel: 'stripe',
    connectorDid: 'did:imajin:stripe-connector',
    scopes: connectorUiScopes('stripe'),
    statusEndpoint: '/stripe/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: '/stripe/api/token',
    // Deprovisions the self-provisioned webhook endpoint with the owner's own
    // key before revoking the sealed key's delegation grant (#1776 pattern).
    disconnectRoute: '/stripe/api/disconnect',
    credentialUi: {
      label: 'Restricted Key',
      placeholder: 'Stripe Restricted Key (rk_...)',
      hint: 'Key is sealed server-side and never returned. Create a RESTRICTED key (not your full secret key) in the ' +
        'Stripe Dashboard → Developers → API keys → Create restricted key, and grant only: Payments = Write, ' +
        'Webhooks = Write. Leave every other resource — especially Account — at None. Connecting self-provisions a ' +
        'webhook endpoint on your own Stripe account; disconnecting removes it. Rotating your key in the Stripe ' +
        'Dashboard? Just paste the new key here again — reconnecting replaces the webhook endpoint automatically.',
    },
    settings: null,
    modelsRoute: null,
  },
];

/** Look up a connector entry by its id. Returns undefined for unknown ids. */
export function getConnector(id: string): ConnectorEntry | undefined {
  return CONNECTOR_REGISTRY.find((c) => c.id === id);
}
