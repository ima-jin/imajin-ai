import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/server — not available outside Next.js runtime.
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { headers?: Record<string, string> }) => ({
      body,
      headers: init?.headers ?? {},
    }),
  },
}));

// Import AFTER mocks are registered
const { GET } = await import('../imajin-onboarding.json/route');

interface Transition {
  from: string;
  to: string;
  trigger: string;
  party: 'agent' | 'human' | 'system';
  endpoint?: string;
  description: string;
}

interface NegativeAssertion {
  id: string;
  atState: string;
  description: string;
}

interface OnboardingDocument {
  version: string;
  flow: string;
  description: string;
  agentCard: string;
  spec: string;
  initialState: string;
  terminalStates: string[];
  states: string[];
  transitions: Transition[];
  negativeAssertions: NegativeAssertion[];
}

function invoke(): OnboardingDocument {
  return (GET() as { body: OnboardingDocument }).body;
}

beforeEach(() => {
  for (const key of ['APP_URL', 'NEXT_PUBLIC_BASE_URL', 'NEXT_PUBLIC_SERVICE_PREFIX', 'NEXT_PUBLIC_DOMAIN']) {
    delete process.env[key];
  }
});

describe('GET /.well-known/imajin-onboarding.json', () => {
  it('serves a well-formed, JSON-parseable document with the expected top-level shape', () => {
    const doc = invoke();
    expect(doc.flow).toBe('knock');
    expect(doc.agentCard).toBe('https://imajin.ai/.well-known/agent.json');
    expect(doc.spec).toBe('https://imajin.ai/auth/api/spec');
    expect(Array.isArray(doc.states)).toBe(true);
    expect(Array.isArray(doc.transitions)).toBe(true);
    expect(Array.isArray(doc.negativeAssertions)).toBe(true);
  });

  it('anchors agentCard/spec URLs to the resolved node origin', () => {
    process.env.NEXT_PUBLIC_SERVICE_PREFIX = 'https://jin.imajin.ai/';
    process.env.NEXT_PUBLIC_DOMAIN = 'imajin.ai';
    const doc = invoke();
    expect(doc.agentCard).toBe('https://jin.imajin.ai/.well-known/agent.json');
    expect(doc.spec).toBe('https://jin.imajin.ai/auth/api/spec');
  });

  it('encodes the full knock -> ... -> revoked_fails state sequence', () => {
    const doc = invoke();
    expect(doc.states).toEqual([
      'knock',
      'pending',
      'accepted',
      'declined',
      'challenge',
      'verify',
      'denied_without_grant',
      'grant',
      'act',
      'attest',
      'revoked_fails',
    ]);
    expect(doc.initialState).toBe('knock');
    expect(doc.terminalStates).toEqual(['declined', 'revoked_fails']);
  });

  it('every transition names which party moves and every from/to state is declared', () => {
    const doc = invoke();
    const stateSet = new Set(doc.states);
    expect(doc.transitions.length).toBeGreaterThan(0);
    for (const transition of doc.transitions) {
      expect(stateSet.has(transition.from)).toBe(true);
      expect(stateSet.has(transition.to)).toBe(true);
      expect(['agent', 'human', 'system']).toContain(transition.party);
      expect(typeof transition.trigger).toBe('string');
      expect(transition.trigger.length).toBeGreaterThan(0);
      expect(typeof transition.description).toBe('string');
      expect(transition.description.length).toBeGreaterThan(0);
    }
  });

  it('reaches every declared state through at least one transition', () => {
    const doc = invoke();
    const reachable = new Set([doc.initialState]);
    for (const transition of doc.transitions) reachable.add(transition.to);
    for (const state of doc.states) {
      expect(reachable.has(state)).toBe(true);
    }
  });

  it('asserts a pre-grant action MUST fail', () => {
    const doc = invoke();
    const assertion = doc.negativeAssertions.find((a) => a.id === 'pre-grant-action-must-fail');
    expect(assertion).toBeDefined();
    expect(assertion?.atState).toBe('denied_without_grant');
    expect(assertion?.description).toMatch(/MUST/);
  });

  it('asserts a post-revoke action MUST fail', () => {
    const doc = invoke();
    const assertion = doc.negativeAssertions.find((a) => a.id === 'post-revoke-action-must-fail');
    expect(assertion).toBeDefined();
    expect(assertion?.atState).toBe('revoked_fails');
    expect(assertion?.description).toMatch(/MUST/);
  });

  it('includes the human accept/decline branch out of pending', () => {
    const doc = invoke();
    const accept = doc.transitions.find((t) => t.from === 'pending' && t.to === 'accepted');
    const decline = doc.transitions.find((t) => t.from === 'pending' && t.to === 'declined');
    expect(accept?.party).toBe('human');
    expect(decline?.party).toBe('human');
  });

  it('response headers include CORS and cache-control', () => {
    const response = GET() as { headers: Record<string, string> };
    expect(response.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(response.headers['Cache-Control']).toMatch(/max-age/);
  });
});
