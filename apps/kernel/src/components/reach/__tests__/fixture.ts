import type { ReachCard } from '@/src/lib/auth/reach-discovery';

export const card: ReachCard = {
  schemaVersion: '0.1',
  principalDid: 'did:imajin:public-person',
  handle: 'alex',
  name: 'Alex',
  url: 'https://node.example/.well-known/agent/alex',
  instructionsUrl: 'https://node.example/alex/reach',
  reach: {
    endpoint: 'https://node.example/auth/api/agents/did%3Aimajin%3Apublic-person/reach',
    protocol: 'imajin-agent-reach/0.1',
    description: 'Public Reach',
    topics: ['community'],
  },
  authentication: {
    schemes: ['reach-bearer', 'did-imajin'],
    tiers: [
      { id: 'anonymous', description: 'Discovery only', transports: ['mcp', 'openapi'] },
      { id: 'reach-bearer', description: 'Caller bearer', transports: ['mcp', 'openapi'] },
      { id: 'did-imajin', description: 'Signed requests', transports: ['signed'] },
    ],
  },
  onboarding: {
    flow: 'knock',
    endpoint: 'https://node.example/reach/alex/knock',
    flowDocument: 'https://node.example/.well-known/flows/knock',
    description: 'Obtain your own bearer',
  },
  transports: [
    {
      id: 'mcp', endpoint: 'https://node.example/reach/alex/mcp',
      protocol: 'mcp', authentication: ['reach-bearer'],
      discovery: 'https://node.example/.well-known/oauth-protected-resource/reach/alex/mcp',
      tools: ['reach_card', 'reach_ask', 'reach_send', 'reach_status'],
    },
    { id: 'openapi', endpoint: 'https://node.example/reach/alex/openapi.json', protocol: 'openapi', authentication: ['reach-bearer'] },
    { id: 'signed', endpoint: 'https://node.example/auth/api/agents/did%3Aimajin%3Apublic-person/reach', protocol: 'imajin-agent-reach/0.1', authentication: ['did-imajin'] },
  ],
};
