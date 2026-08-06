/**
 * MCP discovery tools (#1636) — the node describing itself, read-only.
 *
 * A dispatched cloud agent used to learn the system by grepping source files,
 * which is both expensive and unreliable: source says what one commit intended,
 * not what the running node exposes. These tools serve the three things that
 * actually answer that question — the OpenAPI specs, the scope vocabulary, and
 * the caller's own connector grant state — so an agent starts from fact instead
 * of inference.
 *
 * ## Read-only, and no write counterpart
 * Every tool here is a projection of data the node already publishes or already
 * holds about the caller. Nothing mutates state, and there is deliberately no
 * `discovery:write`: an agent reads to inform the code it writes, then lands that
 * code through git and a PR. The dev kernel is a reference, not a deploy target.
 *
 * ## Two gates, same as every other MCP tool
 *   1. `handleMcpRpc` checks the token carries `discovery:read` (the OAuth gate).
 *   2. Each handler calls `requireDiscoveryGrant(ctx.did)` (the sovereignty gate:
 *      an active `warp` channel_links row, written when the owner publishes their
 *      Warp scope-manifest with the scope enabled).
 *
 * The manifest gate applies even to `imajin_list_api_specs`, whose payload is
 * already public over HTTP. That is on purpose: the value of the gate is that
 * un-toggling the scope closes the *whole* surface in one move, and a surface
 * with one ungated hole is a surface nobody can reason about.
 *
 * Scoping: `imajin_get_scope_manifest` reads `ctx.did` and nothing else, so no
 * tool here can witness another DID's connector state.
 *
 * Template: modelled on tools/warp.ts and tools/connections.ts.
 * RFC-32 federated-growth contract: only this file + tools/index.ts change.
 */
import type { McpTool } from '../types';
import { num, str, json } from './utils';
import { requireDiscoveryGrant, WARP_DISCOVERY_SCOPE } from '@/src/lib/warp/connector';
import { listApiSpecs, readApiSpec, SPEC_MAX_CHARS } from '@/src/lib/kernel/api-specs';
import { readConnectorConnectionStatus } from '@/src/lib/kernel/connector-status';
import { CONNECTOR_REGISTRY } from '@/src/lib/kernel/connector-registry';
import { scopeCatalogue } from '@/src/lib/kernel/scope-projections';
import { MCP_SCOPES } from '../oauth-config';

// ── API specs ─────────────────────────────────────────────────────────────────

const listApiSpecsTool: McpTool = {
  name: 'imajin_list_api_specs',
  requiredScope: WARP_DISCOVERY_SCOPE,
  description:
    'List the OpenAPI specs this Imajin node serves — one per kernel service ' +
    '(auth, media, connections, chat, pay, profile, registry, notify). Returns ' +
    "each spec's service name, the public endpoint serving it, its title and " +
    'version, and the path templates it documents, so you can see what the API ' +
    'actually exposes before reading source. Start here, then call ' +
    'imajin_get_api_spec for the one you need. Requires an active discovery:read ' +
    'grant on the Warp connector.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    await requireDiscoveryGrant(ctx.did);

    const specs = listApiSpecs();
    return json({ count: specs.length, specs });
  },
};

const getApiSpecTool: McpTool = {
  name: 'imajin_get_api_spec',
  requiredScope: WARP_DISCOVERY_SCOPE,
  description:
    'Read one service\'s OpenAPI spec source as YAML — the authoritative ' +
    'description of its routes, parameters, and responses. Returns ' +
    '{ service, endpoint, content, contentType, truncated }; content is capped ' +
    'and truncated is true when it was cut. Use imajin_list_api_specs first to ' +
    'see which services have a spec. Requires an active discovery:read grant on ' +
    'the Warp connector.',
  inputSchema: {
    type: 'object',
    properties: {
      service: {
        type: 'string',
        description: 'Service name from imajin_list_api_specs, e.g. "auth" or "media"',
      },
      max_chars: {
        type: 'number',
        description:
          `Optional cap on the spec text returned, in characters (defaults to ${SPEC_MAX_CHARS}). ` +
          'Lower it when you only need the head of a large spec.',
      },
    },
    required: ['service'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const service = str(args, 'service');
    if (service === undefined) throw new Error('service is required');

    await requireDiscoveryGrant(ctx.did);

    const maxChars = num(args, 'max_chars');
    const spec = readApiSpec(service, maxChars === undefined ? {} : { maxChars });
    if (spec === null) {
      // Named rather than silently empty: an agent that mistyped a service should
      // learn that, not conclude the API has no spec.
      throw new Error(
        `unknown_spec: no API spec for '${service}' — call imajin_list_api_specs for the catalogue`,
      );
    }

    return json(spec);
  },
};

// ── Scope vocabulary ──────────────────────────────────────────────────────────

const listScopesTool: McpTool = {
  name: 'imajin_list_scopes',
  requiredScope: WARP_DISCOVERY_SCOPE,
  description:
    'Read the declarative scope vocabulary: every scope this node recognises, its ' +
    'consent label, the connector that owns it (null for platform scopes granted ' +
    'via the OAuth consent screen), its release tier (silent / on-consent / ' +
    'owner-only / never), and whether an MCP access token may carry it. Also ' +
    'returns the MCP capability ceiling and the scopes your own token currently ' +
    'holds — read this before assuming a capability exists or guessing why a call ' +
    'returned insufficient_scope. Requires an active discovery:read grant on the ' +
    'Warp connector.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    await requireDiscoveryGrant(ctx.did);

    const scopes = scopeCatalogue();
    return json({
      count: scopes.length,
      scopes,
      mcpCeiling: [...MCP_SCOPES],
      // The scopes on THIS token, so a denial can be diagnosed in one call
      // instead of by trial and error against every tool.
      tokenScopes: [...ctx.scopes].sort(),
    });
  },
};

// ── Connector status ──────────────────────────────────────────────────────────

/**
 * The connector registry as the discovery surface reports it.
 *
 * Route fields (`tokenRoute`, `connectRoute`, …) are omitted deliberately: they
 * describe how a *human* attaches a credential in the browser, and an agent that
 * treats them as callable is about to try to seal a credential it should never
 * hold. What it needs is the identity of the connector and what it can grant.
 */
function connectorCatalogue() {
  return CONNECTOR_REGISTRY.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    ingestionPattern: entry.ingestionPattern,
    channel: entry.channel,
    connectorDid: entry.connectorDid,
    statusEndpoint: entry.statusEndpoint,
    grantableScopes: entry.scopes.map((scope) => ({
      name: scope.name,
      label: scope.label,
      releaseClass: scope.releaseClass,
    })),
  }));
}

const getScopeManifestTool: McpTool = {
  name: 'imajin_get_scope_manifest',
  requiredScope: WARP_DISCOVERY_SCOPE,
  description:
    'Read your own connector state: for every connector, whether it is connected ' +
    'and which of its scopes are active for you right now, alongside what each ' +
    'connector can grant and the scope-manifest endpoint that grants it. This is ' +
    'the "what am I actually allowed to do" call — the active scopes come from ' +
    'live channel_links rows, so they reflect your published scope-manifests ' +
    'rather than what the code hopes is granted. Only your own DID is visible; no ' +
    'credentials or connector config are ever returned. Requires an active ' +
    'discovery:read grant on the Warp connector.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(_args, ctx) {
    await requireDiscoveryGrant(ctx.did);

    const statuses = await readConnectorConnectionStatus(ctx.did);
    return json({
      did: ctx.did,
      tokenScopes: [...ctx.scopes].sort(),
      connectors: connectorCatalogue(),
      status: statuses,
    });
  },
};

export const discoveryTools: McpTool[] = [
  listApiSpecsTool,
  getApiSpecTool,
  listScopesTool,
  getScopeManifestTool,
];
