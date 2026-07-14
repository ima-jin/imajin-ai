import { NextResponse } from 'next/server';
import { SERVICES } from '@imajin/config';
import { MCP_ISSUER } from '@/src/lib/mcp/oauth-config';

/**
 * /.well-known/agent.json — A2A Agent Card (RFC-32 / epic #965, issue #966).
 *
 * Describes this Imajin node as an A2A-compliant agent. Auto-generated from:
 *   - SERVICES manifest (@imajin/config) → skills
 *   - RELAY_DID env var               → federation status
 *   - MCP_PUBLIC_URL env var           → MCP endpoint
 *   - NEXT_PUBLIC_DOMAIN env var       → node URL
 *
 * Spec: https://google.github.io/A2A/specification/
 */

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
  const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
  const protocol = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
  const nodeUrl = `${protocol}${domain}`;

  const isFederated = !!process.env.RELAY_DID;
  const mcpEndpoint = `${MCP_ISSUER}/mcp`;

  const card = {
    /** A2A Agent Card schema version */
    schemaVersion: '0.2',

    name: 'imajin-node',
    description: 'Imajin node — sovereign identity, attribution, and settlement',
    url: nodeUrl,
    version: '1.0.0',

    capabilities: {
      streaming: false,
      pushNotifications: true,
      stateTransitionHistory: true,
    },

    /**
     * Authentication schemes supported:
     *   did-imajin — native DID-based auth (RFC-27)
     *   oauth2     — MCP OAuth 2.1 (RFC 8414 / 9728)
     */
    authentication: {
      schemes: ['did-imajin', 'oauth2'],
      oauth2: {
        authorizationUrl: `${MCP_ISSUER}/oauth/authorize`,
        tokenUrl: `${MCP_ISSUER}/oauth/token`,
        discoveryUrl: `${MCP_ISSUER}/.well-known/oauth-authorization-server`,
      },
    },

    defaultInputModes: ['text'],
    defaultOutputModes: ['text', 'json'],

    /** Protocol surfaces this node speaks */
    protocols: {
      a2a: { version: '0.2', taskEndpoint: `${nodeUrl}/api/a2a/tasks` },
      mcp: { version: '2025-03-26', endpoint: mcpEndpoint },
    },

    /** Settlement wire schemes available on this node */
    settlement: {
      http402: true,
      wireSchemes: detectWireSchemes(),
      fairPolicyUrl: `${nodeUrl}/.well-known/fair-policy.json`,
    },

    /** DFOS federation status */
    federation: {
      enabled: isFederated,
      ...(isFederated && { relayDid: process.env.RELAY_DID }),
      dfosEndpoint: `${nodeUrl}/registry/relay/.well-known/dfos-relay`,
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
