import { NextResponse } from 'next/server';
import { nodeUrl } from '@/src/lib/http/node-url';

/**
 * /.well-known/imajin-onboarding.json — the knock onboarding flow as data,
 * not prose (#1899).
 *
 * The agent card's `onboarding` block tells a stranger's agent where the
 * front door is; this document tells it the whole sequence: every state the
 * relationship can be in, who moves at each transition, and the two
 * negative-test assertions any client integration should be able to
 * demonstrate (a pre-grant action MUST fail; a post-revoke action MUST
 * fail). See RFC #1881 (external-agent primitives), #1882 (delegation
 * grants), and #1883 (the knock lifecycle itself) for the full narrative
 * this document mechanises.
 */

// nodeUrl() reads a runtime (non-NEXT_PUBLIC_) env var, which a statically
// rendered handler would bake at build time. Cache-Control still bounds the cost.
export const dynamic = 'force-dynamic';

type Party = 'agent' | 'human' | 'system';

interface Transition {
  from: string;
  to: string;
  trigger: string;
  /** Which party causes this transition to fire. */
  party: Party;
  /** HTTP method + path of the endpoint that drives this transition, if any. */
  endpoint?: string;
  description: string;
}

interface NegativeAssertion {
  id: string;
  atState: string;
  description: string;
}

const STATES = [
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
] as const;

const TRANSITIONS: Transition[] = [
  {
    from: 'knock',
    to: 'pending',
    trigger: 'knock_submitted',
    party: 'agent',
    endpoint: 'POST /auth/api/knock',
    description: 'A stranger\u2019s agent submits a zero-authority contact request declaring the principal it wants to serve. No identity is minted yet.',
  },
  {
    from: 'pending',
    to: 'accepted',
    trigger: 'human_accepts',
    party: 'human',
    endpoint: 'POST /auth/api/knock/{knockId}/accept',
    description: 'The declared target mints (or reuses) a did:imajin identity for the agent and links it via a connection. Zero grants are issued by this step.',
  },
  {
    from: 'pending',
    to: 'declined',
    trigger: 'human_declines',
    party: 'human',
    endpoint: 'POST /auth/api/knock/{knockId}/decline',
    description: 'The declared target discards the request outright. No identity was ever created, so there is nothing to undo.',
  },
  {
    from: 'accepted',
    to: 'challenge',
    trigger: 'agent_requests_challenge',
    party: 'agent',
    endpoint: 'POST /auth/api/challenge',
    description: 'The newly identified agent requests a signing challenge to authenticate as its own did:imajin identity.',
  },
  {
    from: 'challenge',
    to: 'verify',
    trigger: 'agent_submits_signature',
    party: 'agent',
    endpoint: 'POST /auth/api/authenticate',
    description: 'The agent signs the challenge with its private key and exchanges it for a session/API token.',
  },
  {
    from: 'verify',
    to: 'denied_without_grant',
    trigger: 'agent_attempts_protected_action',
    party: 'agent',
    description: 'A freshly verified identity carries zero authority. Any protected action attempted before a grant exists MUST fail (401/403) \u2014 see negativeAssertions.pre-grant-action-must-fail.',
  },
  {
    from: 'denied_without_grant',
    to: 'grant',
    trigger: 'principal_issues_grant',
    party: 'human',
    endpoint: 'POST /auth/api/grants',
    description: 'The delegator principal \u2014 directly authenticated, never acting under agent delegation \u2014 issues a scoped, time-bounded grant to the agent.',
  },
  {
    from: 'grant',
    to: 'act',
    trigger: 'agent_performs_granted_action',
    party: 'agent',
    description: 'The agent exercises exactly the capabilities named on its grant. Every delegated action is checked at execution time via grant introspection, never a cached decision.',
  },
  {
    from: 'act',
    to: 'attest',
    trigger: 'action_recorded',
    party: 'system',
    description: 'The action is recorded as an attestation \u2014 the durable, signed record of what the agent did under this grant.',
  },
  {
    from: 'attest',
    to: 'revoked_fails',
    trigger: 'principal_revokes_grant',
    party: 'human',
    endpoint: 'DELETE /auth/api/grants/{grantId}',
    description: 'The delegator revokes the grant. Revocation is immediate: the very next introspection check fails closed, so a subsequent action attempt MUST fail \u2014 see negativeAssertions.post-revoke-action-must-fail.',
  },
];

const NEGATIVE_ASSERTIONS: NegativeAssertion[] = [
  {
    id: 'pre-grant-action-must-fail',
    atState: 'denied_without_grant',
    description: 'An agent holding a verified identity but no grant MUST have any capability-gated action rejected (401/403), never silently allowed.',
  },
  {
    id: 'post-revoke-action-must-fail',
    atState: 'revoked_fails',
    description: 'Once a grant is revoked, the next attempt to exercise it MUST fail (401/403). Revocation is checked at execution time, not cached.',
  },
];

export function GET() {
  const node = nodeUrl();

  const document = {
    version: '1.0.0',
    flow: 'knock',
    description: 'The imajin knock onboarding flow, encoded as a state machine: zero-authority contact request \u2192 human accept \u2192 challenge-response authentication \u2192 scoped grant \u2192 action \u2192 attestation \u2192 revocation.',
    agentCard: `${node}/.well-known/agent.json`,
    spec: `${node}/auth/api/spec`,
    initialState: 'knock',
    terminalStates: ['declined', 'revoked_fails'],
    states: STATES,
    transitions: TRANSITIONS,
    negativeAssertions: NEGATIVE_ASSERTIONS,
  };

  return NextResponse.json(document, {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
