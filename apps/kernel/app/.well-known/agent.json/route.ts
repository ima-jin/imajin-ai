import { NextResponse } from 'next/server';
import { SERVICES } from '@imajin/config';
import { getMcpIssuer } from '@/src/lib/mcp/oauth-config';
import { nodeUrl } from '@/src/lib/http/node-url';

/**
 * /.well-known/agent.json — Agent Card (RFC-32 / epic #965, issue #966).
 *
 * Describes this Imajin node to a stranger's agent. Auto-generated from:
 *   - SERVICES manifest (@imajin/config) → skills
 *   - RELAY_DID env var                  → federation status
 *   - MCP_PUBLIC_URL env var             → MCP endpoint
 *   - nodeUrl()                          → node URL
 *
 * ADVERTISE ONLY WHAT RESOLVES (#1614). This card is the front door for cold
 * agent contact, so every URL in it must be reachable. The A2A protocol block
 * was removed because `/api/a2a/tasks` has no route handler — a stranger doing
 * everything right (apex → card → taskEndpoint) got a Next.js 404 instead of an
 * auth challenge. Re-add `protocols.a2a` in the same commit that ships the
 * endpoint, not before.
 *
 * Spec: https://google.github.io/A2A/specification/
 */

// nodeUrl() reads a runtime (non-NEXT_PUBLIC_) env var, which a statically
// rendered handler would bake at build time. Cache-Control still bounds the cost.
export const dynamic = 'force-dynamic';

/** Map kernel/core services to A2A skill objects. Infrastructure and meta services are excluded. */
function buildSkills() {
  return SERVICES
    .filter((s) => s.visibility !== 'internal' && s.category !== 'infrastructure' && s.category !== 'meta')
    .map((s) => ({
      id: s.name,
      name: s.label,
      description: s.description,
      tags: [s.category, s.tier],
      inputModes: ['text'],
      outputModes: ['text', 'json'],
    }));
}

/** Wire schemes supported by this node, inferred from env. */
function detectWireSchemes(): string[] {
  const schemes: string[] = [];
  if (process.env.STRIPE_SECRET_KEY) schemes.push('stripe');
  if (process.env.MJNX_ENABLED === 'true') schemes.push('mjnx');
  if (process.env.X402_ENABLED === 'true') schemes.push('usdc-base');
  // Always include the base scheme — every node speaks HTTP 402
  if (schemes.length === 0) schemes.push('stripe');
  return schemes;
}

export function GET() {
  const node = nodeUrl();

  const isFederated = !!process.env.RELAY_DID;
  const mcpEndpoint = `${getMcpIssuer()}/mcp`;

  const card = {
    /** A2A Agent Card schema version */
    schemaVersion: '0.2',

    name: 'imajin-node',
    description: 'Imajin node — sovereign identity, attribution, and settlement',
    url: node,
    version: '1.0.0',

    /**
     * These describe A2A task-lifecycle behaviour. With no A2A task system on
     * this node, all three are false — claiming otherwise is the same class of
     * dishonesty as advertising the dead taskEndpoint (#1614).
     */
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },

    /**
     * Authentication schemes supported:
     *   did-imajin — native DID-based auth (RFC-27)
     *   oauth2     — MCP OAuth 2.1 (RFC 8414 / 9728)
     */
    authentication: {
      schemes: ['did-imajin', 'oauth2'],
      oauth2: {
        authorizationUrl: `${getMcpIssuer()}/oauth/authorize`,
        tokenUrl: `${getMcpIssuer()}/oauth/token`,
        discoveryUrl: `${getMcpIssuer()}/.well-known/oauth-authorization-server`,
      },
    },

    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'json'],

    /**
     * Protocol surfaces this node actually speaks. MCP only — see the
     * advertise-only-what-resolves note above before adding to this list.
     */
    protocols: {
      mcp: { version: '2025-03-26', endpoint: mcpEndpoint },
    },

    /** Settlement wire schemes available on this node */
    settlement: {
      http402: true,
      wireSchemes: detectWireSchemes(),
      fairPolicyUrl: `${node}/.well-known/fair-policy.json`,
    },

    /** DFOS federation status */
    federation: {
      enabled: isFederated,
      ...(isFederated && { relayDid: process.env.RELAY_DID }),
      dfosEndpoint: `${node}/registry/relay/.well-known/dfos-relay`,
    },

    skills: buildSkills(),
  };

  return NextResponse.json(card, {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
  });
}
