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

function installFetch(agents: AgentFixture[], overrides: Partial<Record<string, FetchImpl>> = {}, delegator = {
  did: 'did:imajin:ryan', name: 'Ryan', isOrganization: false, actorDid: 'did:imajin:ryan',
}) {
  const spy = vi.fn(async (rawUrl: string, init?: RequestInit) => {
    const url = String(rawUrl);
    if (url.endsWith('/auth/api/agents') && (!init || !init.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ agents, delegator }) } as unknown as Response;
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

describe('org delegator context (#2997)', () => {
  const orgDid = `did:imajin:org-${'a'.repeat(64)}`;
  const actorDid = 'did:imajin:human-owner';

  it('names the org and full DID as delegator, separately from the authenticated human', async () => {
    installFetch([], {}, { did: orgDid, name: 'Agrifortress', isOrganization: true, actorDid });
    render(<AgentsPage />);
    const context = await screen.findByRole('region', { name: 'Grant delegator' });
    expect(within(context).getByText('Issuing grants as organization — Agrifortress')).toBeDefined();
    expect(within(context).getByText(orgDid).className).toContain('font-mono');
    expect(within(context).getByText(actorDid)).toBeDefined();
    expect(within(context).getByText(orgDid).className).toContain('break-all');
    expect(screen.queryByText(/Issuing grants as your personal identity/)).toBeNull();
  });

  it('keeps personal grants clearly labeled when no org is selected', async () => {
    await renderAgentsPage([]);
    expect(screen.getByText('Issuing grants as your personal identity — Ryan')).toBeDefined();
    expect(screen.queryByText(/Issuing grants as organization/)).toBeNull();
  });
  it('shows an auth-context failure and disables direct issuance when the agents read is denied', async () => {
    const spy = installFetch([]);
    spy.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) } as Response);
    render(<AgentsPage />);
    expect(await screen.findByText('Failed to load grant delegator. Check your auth service access.')).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Grant delegator' })).toBeNull();
    const button = screen.getByRole('button', { name: '+ Add capability to agent' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('issues to an agent DID with no agent list, knock or membership and without trusting a client delegator field', async () => {
    const spy = installFetch([], {}, { did: orgDid, name: 'Agrifortress', isOrganization: true, actorDid });
    render(<AgentsPage />);
    await screen.findByRole('region', { name: 'Grant delegator' });
    fireEvent.change(screen.getByLabelText('Agent DID'), { target: { value: EXTERNAL_AGENT } });
    fireEvent.change(screen.getByLabelText('Capabilities'), { target: { value: 'messages:write, intros:propose' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add capability to agent' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/auth/api/grants', expect.objectContaining({
      method: 'POST', credentials: 'include',
      body: JSON.stringify({ agentDid: EXTERNAL_AGENT, capabilities: ['messages:write', 'intros:propose'], audience: { type: 'all' } }),
    })));
  });

  it('renders the full agent DID and grant delegator with the human in history', async () => {
    const longAgentDid = `did:imajin:agent-${'b'.repeat(64)}`;
    await renderAgentsPage([agent({ did: longAgentDid, grants: [grant({
      delegatorDid: orgDid,
      history: [{ event: 'issued', capability: null, actorDid, createdAt: '2026-08-01T00:00:00.000Z' }],
    })] })]);
    expect(screen.getByText(longAgentDid).className).toContain('break-all');
    fireEvent.click(screen.getByRole('button', { name: 'Show detail' }));
    expect(screen.getByText(orgDid)).toBeDefined();
    expect(screen.getByText(actorDid)).toBeDefined();
    expect(screen.getByText(/Human actor:/)).toBeDefined();
  });

  it('provisions for the selected org DID rather than the human session DID', async () => {
    const spy = installFetch([], {}, { did: orgDid, name: 'Agrifortress', isOrganization: true, actorDid });
    render(<AgentsPage />);
    await screen.findByRole('region', { name: 'Grant delegator' });
    fireEvent.click(screen.getByRole('button', { name: '+ Provision Agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Org assistant' } });
    fireEvent.click(screen.getByRole('button', { name: 'Provision' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/auth/api/agents/provision', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        servingDid: orgDid, name: 'Org assistant', harness: 'nanoclaw',
        placement: 'hosted', scopes: [], model: { provider: 'anthropic:claude' },
      }),
    })));
  });
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

    const revokedChip = screen.getAllByText('intros:propose').find((el) => el.tagName === 'SPAN');
    expect(revokedChip?.className).toContain('line-through');
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
  it('offers a 30-day choice, previews its expiry and shows the returned expiry after renewal', async () => {
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    const spy = await renderAgentsPage([agent()], {
      '/auth/api/grants/grant_1/renew': async () => Response.json({ grant: { grantId: 'grant_1', expiresAt } }),
    });
    const select = screen.getByLabelText('Renewal lease for grant_1');
    expect(select.className).toContain('max-w-full');
    expect(select.className).toContain('min-h-11');
    fireEvent.change(select, { target: { value: String(30 * 86400000) } });
    const preview = screen.getByText(/Renew until:/).querySelector('time')!;
    expect(Math.abs(Date.parse(preview.dateTime) - Date.parse(expiresAt))).toBeLessThan(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Renew' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/auth/api/grants/grant_1/renew', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ttlMs: 30 * 86400000 }),
    })));
    expect(await screen.findByText(/Grant renewed. New expiry:/)).toBeDefined();
  });

  it('defaults to keeping the last renewed lease and omits ttlMs when unchanged', async () => {
    const lastRenewed = new Date(Date.now() - 86400000).toISOString();
    const expiresAt = new Date(Date.parse(lastRenewed) + 7 * 86400000).toISOString();
    const spy = await renderAgentsPage([agent({ grants: [grant({
      expiresAt, history: [{ event: 'renewed', capability: null, actorDid: 'did:imajin:ryan', createdAt: lastRenewed }],
    })] })]);
    expect((screen.getByLabelText('Renewal lease for grant_1') as HTMLSelectElement).value).toBe('');
    const preview = screen.getByText(/Renew until:/).querySelector('time')!;
    expect(Math.abs(Date.parse(preview.dateTime) - Date.now() - 7 * 86400000)).toBeLessThan(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Renew' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/auth/api/grants/grant_1/renew', expect.objectContaining({ body: '{}' })));
  });

  it('clamps the default preview to 30 days for legacy overlong grants', async () => {
    await renderAgentsPage([agent({ grants: [grant({
      issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
    })] })]);
    const preview = screen.getByText(/Renew until:/).querySelector('time')!;
    expect(Math.abs(Date.parse(preview.dateTime) - Date.now() - 30 * 86400000)).toBeLessThan(1000);
  });

  it.each(['active', 'revoked'] as const)('warns only for an active critical capability (%s)', async status => {
    await renderAgentsPage([agent({ grants: [grant({
      expiresAt: new Date(Date.now() + 2 * 3600000).toISOString(),
      capabilities: [{ capability: 'operator:approvals', status, revokedAt: null }],
    })] })]);
    expect(screen.queryByText(/Operator approvals expires in 2h/) !== null).toBe(status === 'active');
  });
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

describe('add-capability control (#2108)', () => {
  it('renders an add-capability control on an active grant, offering only capabilities not already active', async () => {
    await renderAgentsPage([
      agent({ grants: [grant({ capabilities: [{ capability: 'messages:write', status: 'active', revokedAt: null }] })] }),
    ]);

    const select = screen.getByLabelText('Add capability to grant grant_1') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).not.toContain('messages:write');
    expect(optionValues).toContain('intros:propose');
  });

  it('adds a capability via PUT /auth/api/grants/:grantId/capabilities/:capability', async () => {
    const spy = await renderAgentsPage([
      agent({ grants: [grant({ capabilities: [{ capability: 'messages:write', status: 'active', revokedAt: null }] })] })
    ], {
      '/auth/api/grants/grant_1/capabilities': async () => ({ ok: true, status: 200, json: async () => ({ added: true }) } as unknown as Response),
    });

    fireEvent.change(screen.getByLabelText('Add capability to grant grant_1'), { target: { value: 'intros:propose' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add capability' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('/auth/api/grants/grant_1/capabilities/intros%3Apropose'),
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
  });

  it('does not offer an add-capability control on an already-revoked grant', async () => {
    await renderAgentsPage([agent({ grants: [grant({ status: 'revoked' })] })]);

    expect(screen.queryByLabelText('Add capability to grant grant_1')).toBeNull();
  });
});

describe('create-agent form (S9379 focus-on-mount)', () => {
  it('renders the handle input, focusing it on mount, once "+ Create Agent" is clicked', async () => {
    await renderAgentsPage([agent()]);

    fireEvent.click(screen.getByRole('button', { name: '+ Create Agent' }));

    const input = screen.getByLabelText('Handle');
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });
});

describe('no grants yet', () => {
  it('shows an empty-state message for an agent with zero grants and no legacy fallback', async () => {
    await renderAgentsPage([agent({ grants: [], hasLegacyMembership: false })]);

    const card = screen.getByText('Jin').closest('div.space-y-3') as HTMLElement;
    expect(within(card).getByText('No grants issued yet.')).toBeDefined();
  });
});

describe('knock-accepted zero-grant agents (#1894)', () => {
  it('surfaces a connected, zero-grant agent with a distinct badge and the empty-grants message', async () => {
    await renderAgentsPage([
      agent({
        did: EXTERNAL_AGENT,
        displayName: 'Boardy',
        role: 'connected',
        isExternal: true,
        externalDid: 'did:web:boardy.ai',
        grants: [],
        hasLegacyMembership: false,
      }),
    ]);

    expect(screen.getByText('Boardy')).toBeDefined();
    expect(screen.getByText('connected — no capabilities granted')).toBeDefined();
    const card = screen.getByText('Boardy').closest('div.space-y-3') as HTMLElement;
    expect(within(card).getByText('No grants issued yet.')).toBeDefined();
  });

  it('issues the first grant to a connected, zero-grant agent from its card', async () => {
    const spy = await renderAgentsPage(
      [
        agent({
          did: EXTERNAL_AGENT,
          displayName: 'Boardy',
          role: 'connected',
          isExternal: true,
          externalDid: 'did:web:boardy.ai',
          grants: [],
          hasLegacyMembership: false,
        }),
      ],
      {
        '/auth/api/grants': async () => ({ ok: true, status: 201, json: async () => ({ grant: { grantId: 'grant_new' } }) } as unknown as Response),
      },
    );

    fireEvent.change(screen.getByLabelText('Capabilities to grant Boardy'), { target: { value: 'messages:write' } });
    fireEvent.click(screen.getByRole('button', { name: 'Issue grant' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('/auth/api/grants'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ agentDid: EXTERNAL_AGENT, capabilities: ['messages:write'], audience: { type: 'all' } }),
        }),
      ),
    );
  });

  it('rejects issuing a first grant with no capabilities entered', async () => {
    const spy = await renderAgentsPage([
      agent({
        did: EXTERNAL_AGENT,
        displayName: 'Boardy',
        role: 'connected',
        isExternal: true,
        grants: [],
        hasLegacyMembership: false,
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Issue grant' }));

    expect(screen.getByText('Enter at least one capability (e.g. messages:write).')).toBeDefined();
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('/auth/api/grants'), expect.anything());
  });
});
