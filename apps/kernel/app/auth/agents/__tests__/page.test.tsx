// @vitest-environment jsdom
/**
 * AgentsPage grants view (#1887).
 *
 * `/auth/agents` re-renders from grants: per-agent capability chips,
 * audience, expiry, status, and revoke/renew controls, with local and
 * external agents sharing one list. These tests pin the rendering contract
 * against GET /auth/api/agents's enriched shape rather than the old
 * membership-only response.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@imajin/config', () => ({
  buildPublicUrlAbsolute: () => 'https://kernel.test',
}));

import AgentsPage from '../page';

const LOCAL_AGENT = 'did:imajin:jin';
const EXTERNAL_AGENT = 'did:imajin:boardy-agent';

interface GrantFixture {
  grantId: string;
  agentDid: string;
  delegatorDid: string;
  audience: { type: 'all' } | { type: 'dids'; values: string[] };
  onBehalfOf: string[];
  issuedAt: string;
  expiresAt: string;
  status: 'active' | 'expiring' | 'expired' | 'revoked';
  revokedAt: string | null;
  lastUsedAt: string | null;
  capabilities: { capability: string; status: 'active' | 'revoked'; revokedAt: string | null }[];
  history: { event: string; capability: string | null; actorDid: string; createdAt: string }[];
}

function grant(overrides: Partial<GrantFixture> = {}): GrantFixture {
  return {
    grantId: 'grant_1',
    agentDid: LOCAL_AGENT,
    delegatorDid: 'did:imajin:ryan',
    audience: { type: 'all' },
    onBehalfOf: [],
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    revokedAt: null,
    lastUsedAt: null,
    capabilities: [{ capability: 'messages:write', status: 'active', revokedAt: null }],
    history: [{ event: 'issued', capability: null, actorDid: 'did:imajin:ryan', createdAt: '2026-08-01T00:00:00.000Z' }],
    ...overrides,
  };
}

interface AgentFixture {
  did: string;
  handle: string | null;
  displayName: string | null;
  name: string | null;
  createdAt: string | null;
  tier: string;
  status: 'online' | 'offline';
  role: string;
  isExternal: boolean;
  externalDid: string | null;
  grants: GrantFixture[];
  hasLegacyMembership: boolean;
}

function agent(overrides: Partial<AgentFixture> = {}): AgentFixture {
  return {
    did: LOCAL_AGENT,
    handle: 'jin',
    displayName: 'Jin',
    name: 'Jin',
    createdAt: '2026-07-01T00:00:00.000Z',
    tier: 'preliminary',
    status: 'offline',
    role: 'owner',
    isExternal: false,
    externalDid: null,
    grants: [grant()],
    hasLegacyMembership: false,
    ...overrides,
  };
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(agents: AgentFixture[], overrides: Partial<Record<string, FetchImpl>> = {}) {
  const spy = vi.fn(async (rawUrl: string, init?: RequestInit) => {
    const url = String(rawUrl);
    if (url.endsWith('/auth/api/agents') && (!init || !init.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ agents }) } as unknown as Response;
    }
    if (url.endsWith('/auth/api/session')) {
      return { ok: true, status: 200, json: async () => ({ did: 'did:imajin:ryan', handle: 'ryan' }) } as unknown as Response;
    }
    if (url.endsWith('/auth/api/knock/pending')) {
      return { ok: true, status: 200, json: async () => ({ knocks: [] }) } as unknown as Response;
    }
    for (const [suffix, impl] of Object.entries(overrides)) {
      if (url.includes(suffix) && impl) return impl(url, init);
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function renderAgentsPage(agents: AgentFixture[], overrides?: Parameters<typeof installFetch>[1]) {
  const spy = installFetch(agents, overrides);
  render(<AgentsPage />);
  await waitFor(() => expect(screen.queryByText('Loading agents…')).toBeNull());
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('grants-view read surface (#1887)', () => {
  it('renders capability chips, audience, and grant status for an agent', async () => {
    await renderAgentsPage([agent({ grants: [grant({ audience: { type: 'all' } })] })]);

    expect(screen.getByText('Jin')).toBeDefined();
    expect(screen.getByText('messages:write')).toBeDefined();
    expect(screen.getByText('active')).toBeDefined();
    expect(screen.getByText('grant_1')).toBeDefined();
  });

  it('shows issuedAt, expiry, and lastUsedAt once the detail is expanded', async () => {
    await renderAgentsPage([
      agent({ grants: [grant({ lastUsedAt: '2026-08-20T10:00:00.000Z' })] }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Show detail' }));

    expect(screen.getByText(/Issued:/)).toBeDefined();
    expect(screen.getByText(/Expiry:/)).toBeDefined();
    expect(screen.getByText(/Last used:/)).toBeDefined();
  });

  it('renders never for lastUsedAt when the grant has not been introspected yet', async () => {
    await renderAgentsPage([agent({ grants: [grant({ lastUsedAt: null })] })]);

    fireEvent.click(screen.getByRole('button', { name: 'Show detail' }));

    expect(screen.getByText('never')).toBeDefined();
  });

  it('renders the grant lifecycle history entries', async () => {
    await renderAgentsPage([
      agent({
        grants: [
          grant({
            history: [
              { event: 'issued', capability: null, actorDid: 'did:imajin:ryan', createdAt: '2026-08-01T00:00:00.000Z' },
              { event: 'capability_revoked', capability: 'messages:write', actorDid: 'did:imajin:ryan', createdAt: '2026-08-10T00:00:00.000Z' },
            ],
          }),
        ],
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Show detail' }));

    expect(screen.getAllByText(/Issued/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Capability revoked \(messages:write\)/)).toBeDefined();
  });

  it('keeps a revoked grant visible in the list with a revoked badge — the record does not disappear', async () => {
    await renderAgentsPage([
      agent({
        grants: [grant({ grantId: 'grant_revoked', status: 'revoked', revokedAt: '2026-08-15T00:00:00.000Z' })],
      }),
    ]);

    expect(screen.getByText('grant_revoked')).toBeDefined();
    expect(screen.getByText('revoked')).toBeDefined();
  });

  it('shows a strikethrough chip for a revoked capability while the grant remains active', async () => {
    await renderAgentsPage([
      agent({
        grants: [
          grant({
            capabilities: [
              { capability: 'messages:write', status: 'active', revokedAt: null },
              { capability: 'intros:propose', status: 'revoked', revokedAt: '2026-08-10T00:00:00.000Z' },
            ],
          }),
        ],
      }),
    ]);

    const revokedChip = screen.getByText('intros:propose');
    expect(revokedChip.className).toContain('line-through');
  });

  it('does not offer a per-capability revoke control on an already-revoked grant', async () => {
    await renderAgentsPage([agent({ grants: [grant({ status: 'revoked' })] })]);

    expect(screen.queryByTitle('Revoke messages:write')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
  });
});

describe('sibling topology: local and external agents in one list', () => {
  it('badges a local agent and an external agent distinctly in the same list', async () => {
    await renderAgentsPage([
      agent({ did: LOCAL_AGENT, displayName: 'Jin', isExternal: false }),
      agent({
        did: EXTERNAL_AGENT,
        displayName: 'Boardy',
        role: 'grant',
        isExternal: true,
        externalDid: 'did:web:boardy.ai',
        grants: [grant({ grantId: 'grant_2', agentDid: EXTERNAL_AGENT })],
      }),
    ]);

    expect(screen.getByText('Jin')).toBeDefined();
    expect(screen.getByText('Boardy')).toBeDefined();
    expect(screen.getAllByText('local')).toHaveLength(1);
    expect(screen.getAllByText('external')).toHaveLength(1);
    expect(screen.getByText('did:web:boardy.ai')).toBeDefined();
  });

  it('flags an agent still relying on the #1887 legacy membership fallback', async () => {
    await renderAgentsPage([agent({ grants: [], hasLegacyMembership: true })]);

    expect(screen.getByText('legacy fallback')).toBeDefined();
    expect(screen.getByText(/currently authorized only via the legacy membership fallback/)).toBeDefined();
  });
});

describe('grant controls call the #1882 grants endpoints', () => {
  it.each([
    [
      'revokes a single capability via DELETE /auth/api/grants/:grantId/capabilities/:capability',
      () => screen.getByTitle('Revoke messages:write'),
      '/auth/api/grants/grant_1/capabilities/messages%3Awrite',
      'DELETE',
    ],
    [
      'revokes the whole grant via DELETE /auth/api/grants/:grantId',
      () => screen.getByRole('button', { name: 'Revoke all' }),
      '/auth/api/grants/grant_1',
      'DELETE',
    ],
    [
      'renews the grant via POST /auth/api/grants/:grantId/renew',
      () => screen.getByRole('button', { name: 'Renew' }),
      '/auth/api/grants/grant_1/renew',
      'POST',
    ],
  ] as const)('%s', async (_description, getControl, expectedUrl, expectedMethod) => {
    const spy = await renderAgentsPage([agent()]);

    fireEvent.click(getControl());

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining(expectedUrl),
        expect.objectContaining({ method: expectedMethod }),
      ),
    );
  });
});

describe('no grants yet', () => {
  it('shows an empty-state message for an agent with zero grants and no legacy fallback', async () => {
    await renderAgentsPage([agent({ grants: [], hasLegacyMembership: false })]);

    const card = screen.getByText('Jin').closest('div.space-y-3') as HTMLElement;
    expect(within(card).getByText('No grants issued yet.')).toBeDefined();
  });
});
