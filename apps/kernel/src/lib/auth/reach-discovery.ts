import { eq } from 'drizzle-orm';
import { db, identities } from '@/src/db';
import { nodeUrl } from '@/src/lib/http/node-url';
import { isGateOpen, publishedTopicLabels, readFrontDoorConfig } from '@/src/lib/jin/front-door';

interface ReachIdentity {
  id: string;
  handle: string | null;
  name: string | null;
  metadata: unknown;
}

export interface ReachTransport {
  id: 'mcp' | 'openapi' | 'signed';
  endpoint: string;
  protocol: string;
  authentication: string[];
  discovery?: string;
  tools?: string[];
}

export interface ReachCard {
  schemaVersion: '0.1';
  principalDid: string;
  handle: string | null;
  name: string | null;
  url: string;
  instructionsUrl: string;
  reach: { endpoint: string; protocol: 'imajin-agent-reach/0.1'; description: string; topics?: string[] };
  authentication: {
    schemes: string[];
    tiers: { id: string; description: string; transports: string[] }[];
  };
  onboarding: { flow: 'knock'; endpoint: string; flowDocument: string; description: string };
  transports: ReachTransport[];
}

/** Public projection only: never return metadata, admitted tiers, quotas or delivery rules. */
export function buildReachCard(identity: ReachIdentity, origin: string): ReachCard {
  const id = encodeURIComponent(identity.id);
  const alias = encodeURIComponent(identity.handle ?? identity.id);
  const base = `${origin}/reach/${alias}`;
  const endpoint = `${origin}/auth/api/agents/${id}/reach`;
  const topics = publishedTopicLabels(identity.metadata);
  const transports: ReachTransport[] = [
    {
      id: 'mcp',
      endpoint: `${base}/mcp`,
      protocol: 'mcp',
      authentication: ['anonymous', 'reach-bearer'],
      discovery: `${origin}/.well-known/oauth-protected-resource/reach/${alias}/mcp`,
      tools: ['reach_card', 'reach_ask', 'reach_send', 'reach_status'],
    },
    {
      id: 'openapi',
      endpoint: `${base}/openapi.json`,
      protocol: 'openapi/3.1',
      authentication: ['anonymous', 'reach-bearer', 'did-imajin', 'did-web'],
    },
    {
      id: 'signed',
      endpoint,
      protocol: 'imajin-agent-reach/0.1',
      authentication: ['did-imajin', 'did-web'],
    },
    // A2A extension point (#2594): add its transport only once the card and
    // JSON-RPC binding are live. Never advertise a planned endpoint as usable.
  ];
  return {
    schemaVersion: '0.1',
    principalDid: identity.id,
    handle: identity.handle,
    name: identity.name,
    url: `${origin}/.well-known/agent/${id}`,
    instructionsUrl: `${origin}/${alias}/reach`,
    reach: {
      endpoint,
      protocol: 'imajin-agent-reach/0.1',
      description: 'Signed ask/send under a principal-authored reach gate. A boolean ask never reveals underlying data; delivery and replies remain requester-private. A valid credential and gate admission or an active agent:reach grant are required.',
      ...(topics.length > 0 ? { topics } : {}),
    },
    authentication: {
      schemes: ['did-imajin', 'did-web', 'reach-bearer'],
      // These describe protocol capabilities, NOT this principal's gate policy.
      tiers: [
        { id: 'anonymous', description: 'Public card, specification and MCP discovery/reach_card only. Never ask, send or status.', transports: ['mcp', 'openapi'] },
        { id: 'reach-bearer', description: 'Your own knock-issued, recipient-bound static Authorization: Bearer credential (agent:reach). onBehalfOf is UNVERIFIED. The gate still decides admission.', transports: ['mcp', 'openapi'] },
        { id: 'did-imajin', description: 'Ed25519 signed reach transcript from a did:imajin identity; gate admission or an active agent:reach delegation grant is required.', transports: ['signed', 'openapi'] },
        { id: 'did-web', description: 'Ed25519 signed reach transcript with publicKey verified against the requester’s did:web document; the same gate applies.', transports: ['signed', 'openapi'] },
      ],
    },
    onboarding: {
      flow: 'knock',
      endpoint: `${base}/knock`,
      flowDocument: `${origin}/.well-known/imajin-onboarding.json`,
      description: 'Static-header clients obtain their own recipient-bound reach bearer from this knock endpoint. No recipient login, hand-issued token or per-agent acceptance is needed. A gate admitting soft-tier clients is required. Save the bearer once, never share or log it.',
    },
    transports,
  };
}

/** The same eligibility boundary is used by DID documents, the JSON card and the public page. */
export async function resolveReachDiscovery(id: string): Promise<ReachCard | null> {
  let alias: string;
  try {
    alias = decodeURIComponent(id).replace(/^@/, '');
  } catch {
    return null;
  }
  if (!alias) return null;
  const column = alias.startsWith('did:') ? identities.id : identities.handle;
  const [identity] = await db.select({
    id: identities.id, handle: identities.handle, name: identities.name, metadata: identities.metadata,
    scope: identities.scope, subtype: identities.subtype, suspendedAt: identities.suspendedAt,
  }).from(identities).where(eq(column, alias)).limit(1);
  if (!identity || identity.scope !== 'actor' || identity.subtype !== 'human' || identity.suspendedAt) return null;
  const config = await readFrontDoorConfig(identity.id);
  if (!config || !isGateOpen(config)) return null;
  return buildReachCard(identity, nodeUrl());
}
