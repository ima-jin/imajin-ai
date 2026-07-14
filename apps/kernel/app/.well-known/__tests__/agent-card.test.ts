import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SERVICES } from '@imajin/config';

// Mock next/server — not available outside Next.js runtime
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { headers?: Record<string, string> }) => ({
      body,
      headers: init?.headers ?? {},
    }),
  },
}));

// Mock oauth-config to keep test hermetic
vi.mock('@/src/lib/mcp/oauth-config', () => ({
  MCP_ISSUER: 'https://mcp.test.example',
}));

// Import AFTER mocks are registered
const { GET } = await import('../agent.json/route');

type AgentCard = {
  schemaVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  authentication: { schemes: string[]; oauth2: { authorizationUrl: string; tokenUrl: string; discoveryUrl: string } };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  protocols: { a2a: { version: string; taskEndpoint: string }; mcp: { version: string; endpoint: string } };
  settlement: { http402: boolean; wireSchemes: string[]; fairPolicyUrl: string };
  federation: { enabled: boolean; relayDid?: string; dfosEndpoint: string };
  skills: Array<{ id: string; name: string; description: string; tags: string[]; inputModes: string[]; outputModes: string[] }>;
};

function invoke(env: Record<string, string> = {}): AgentCard {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const response = GET() as { body: AgentCard };
  for (const [k] of Object.entries(env)) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
  return response.body;
}

describe('GET /.well-known/agent.json', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_DOMAIN;
    delete process.env.NEXT_PUBLIC_SERVICE_PREFIX;
    delete process.env.RELAY_DID;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.MJNX_ENABLED;
    delete process.env.X402_ENABLED;
  });

  it('returns required A2A Agent Card fields', () => {
    const card = invoke();
    expect(card.schemaVersion).toBe('0.2');
    expect(card.name).toBe('imajin-node');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities).toMatchObject({ streaming: false, pushNotifications: true, stateTransitionHistory: true });
    expect(card.defaultInputModes).toContain('text');
    expect(card.defaultOutputModes).toContain('json');
  });

  it('builds node URL from env vars', () => {
    const card = invoke({ NEXT_PUBLIC_DOMAIN: 'mynode.example', NEXT_PUBLIC_SERVICE_PREFIX: 'https://' });
    expect(card.url).toBe('https://mynode.example');
  });

  it('defaults node URL to https://imajin.ai when env vars are absent', () => {
    const card = invoke();
    expect(card.url).toBe('https://imajin.ai');
  });

  it('includes MCP endpoint from mock MCP_ISSUER', () => {
    const card = invoke();
    expect(card.protocols.mcp.endpoint).toBe('https://mcp.test.example/mcp');
    expect(card.authentication.oauth2.authorizationUrl).toContain('https://mcp.test.example');
  });

  it('federation.enabled is false when RELAY_DID is unset', () => {
    const card = invoke();
    expect(card.federation.enabled).toBe(false);
    expect(card.federation.relayDid).toBeUndefined();
  });

  it('federation.enabled is true and relayDid is set when RELAY_DID is present', () => {
    const card = invoke({ RELAY_DID: 'did:imajin:test-relay' });
    expect(card.federation.enabled).toBe(true);
    expect(card.federation.relayDid).toBe('did:imajin:test-relay');
  });

  it('falls back to stripe when no payment env vars are set', () => {
    const card = invoke();
    expect(card.settlement.wireSchemes).toContain('stripe');
  });

  it('detects mjnx and usdc-base wire schemes from env', () => {
    const card = invoke({ MJNX_ENABLED: 'true', X402_ENABLED: 'true' });
    expect(card.settlement.wireSchemes).toContain('mjnx');
    expect(card.settlement.wireSchemes).toContain('usdc-base');
  });

  it('skills are derived from SERVICES — no internal or meta services included', () => {
    const card = invoke();
    const skillIds = card.skills.map((s) => s.id);

    const expectedExcluded = SERVICES
      .filter((s) => s.visibility === 'internal' || s.category === 'infrastructure' || s.category === 'meta')
      .map((s) => s.name);

    for (const excluded of expectedExcluded) {
      expect(skillIds).not.toContain(excluded);
    }
  });

  it('skills include core kernel services', () => {
    const card = invoke();
    const skillIds = new Set(card.skills.map((s) => s.id));
    expect(skillIds.has('registry')).toBe(true);
    expect(skillIds.has('media')).toBe(true);
    expect(skillIds.has('events')).toBe(true);
  });

  it('each skill has required A2A fields', () => {
    const card = invoke();
    for (const skill of card.skills) {
      expect(skill).toHaveProperty('id');
      expect(skill).toHaveProperty('name');
      expect(skill).toHaveProperty('description');
      expect(skill.inputModes).toContain('text');
      expect(skill.outputModes).toContain('json');
    }
  });

  it('response headers include CORS and cache-control', () => {
    const response = GET() as { headers: Record<string, string> };
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(response.headers['Cache-Control']).toMatch(/max-age/);
  });
});
