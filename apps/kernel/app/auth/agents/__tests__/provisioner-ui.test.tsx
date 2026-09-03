// @vitest-environment jsdom
/**
 * Envelope provisioner UI additions on the Agent View pane (#1933):
 * provision badges, the "Provision agent" wizard, per-agent envelope/grant
 * detail, revoke, Open-in-chat, and local-bundle download. Mirrors
 * `page.test.tsx`'s fixture/fetch-mocking conventions for the pre-existing
 * grants view.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@imajin/config', () => ({
  buildPublicUrlAbsolute: () => 'https://kernel.test',
}));

import AgentsPage from '../page';

const OWNER = 'did:imajin:ryan';
const AGENT_DID = 'did:imajin:travel-agent';

interface ProvisionFixture {
  id: string;
  servingDid: string;
  agentDid: string | null;
  handle: string;
  displayName: string | null;
  harness: 'nanoclaw' | 'openclaw';
  placement: 'hosted' | 'local';
  model: { provider: string; via: string };
  scopes: string[];
  status: string;
  steps: { step: string; status: 'ok' | 'error'; at: string; error?: string }[];
  envelopeManifest: { files: { relativePath: string }[]; manualSteps: string[] } | null;
  grantId: string | null;
  createdAt: string;
  revokedAt: string | null;
}

function provision(overrides: Partial<ProvisionFixture> = {}): ProvisionFixture {
  return {
    id: 'prov_1',
    servingDid: OWNER,
    agentDid: AGENT_DID,
    handle: 'travel-agent-abc123',
    displayName: 'Travel Agent',
    harness: 'nanoclaw',
    placement: 'hosted',
    model: { provider: 'anthropic:claude', via: 'kernel-passthrough' },
    scopes: ['messages:write'],
    status: 'awaiting_boot',
    steps: [{ step: 'mint_identity', status: 'ok', at: '2026-08-01T00:00:00.000Z' }],
    envelopeManifest: { files: [{ relativePath: 'envelope/SOUL.md' }], manualSteps: ['Copy the channel adapter'] },
    grantId: 'grant_1',
    createdAt: '2026-08-01T00:00:00.000Z',
    revokedAt: null,
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
  grants: unknown[];
  hasLegacyMembership: boolean;
}

function agent(overrides: Partial<AgentFixture> = {}): AgentFixture {
  return {
    did: AGENT_DID,
    handle: 'travel-agent',
    displayName: 'Travel Agent',
    name: 'Travel Agent',
    createdAt: '2026-08-01T00:00:00.000Z',
    tier: 'preliminary',
    status: 'offline',
    role: 'owner',
    isExternal: false,
    externalDid: null,
    grants: [],
    hasLegacyMembership: false,
    ...overrides,
  };
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(agents: AgentFixture[], provisions: ProvisionFixture[], overrides: Partial<Record<string, FetchImpl>> = {}) {
  const spy = vi.fn(async (rawUrl: string, init?: RequestInit) => {
    const url = String(rawUrl);
    const method = init?.method ?? 'GET';
    for (const [suffix, impl] of Object.entries(overrides)) {
      if (url.includes(suffix) && impl) return impl(url, init);
    }
    if (url.endsWith('/auth/api/agents') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ agents }) } as unknown as Response;
    }
    if (url.endsWith('/auth/api/session')) {
      return { ok: true, status: 200, json: async () => ({ did: OWNER, handle: 'ryan' }) } as unknown as Response;
    }
    if (url.endsWith('/auth/api/knock/pending')) {
      return { ok: true, status: 200, json: async () => ({ knocks: [] }) } as unknown as Response;
    }
    if (url.endsWith('/auth/api/agents/provision') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ provisions }) } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function renderAgentsPage(agents: AgentFixture[], provisions: ProvisionFixture[] = [], overrides?: Parameters<typeof installFetch>[2]) {
  const spy = installFetch(agents, provisions, overrides);
  render(<AgentsPage />);
  await waitFor(() => expect(screen.queryByText('Loading agents…')).toBeNull());
  return spy;
}

beforeEach(() => {
  // jsdom does not implement createObjectURL/revokeObjectURL — stub them for the bundle-download path.
  if (!('createObjectURL' in URL)) {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(), writable: true, configurable: true });
  }
  if (!('revokeObjectURL' in URL)) {
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true, configurable: true });
  }
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('provision badges on the agent card', () => {
  it('renders harness, placement, and status for a provisioned agent', async () => {
    await renderAgentsPage([agent()], [provision()]);

    expect(screen.getByText(/nanoclaw · hosted · awaiting boot/)).toBeDefined();
  });

  it('renders no provision badge for an agent without a provision record', async () => {
    await renderAgentsPage([agent()], []);

    expect(screen.queryByText(/awaiting boot/)).toBeNull();
  });
});

describe('per-agent provision detail panel', () => {
  it('shows envelope manifest files and manual steps once expanded', async () => {
    await renderAgentsPage([agent()], [provision()]);

    fireEvent.click(screen.getByRole('button', { name: 'Show detail' }));

    expect(screen.getByText('envelope/SOUL.md')).toBeDefined();
    expect(screen.getByText('Copy the channel adapter')).toBeDefined();
    expect(screen.getByText(/mint_identity/)).toBeDefined();
  });

  it('surfaces the failed step error inline for a failed provision', async () => {
    await renderAgentsPage([agent()], [
      provision({
        status: 'failed',
        steps: [
          { step: 'mint_identity', status: 'ok', at: '2026-08-01T00:00:00.000Z' },
          { step: 'issue_grants', status: 'error', at: '2026-08-01T00:01:00.000Z', error: 'Unknown capabilities: bogus' },
        ],
      }),
    ]);

    expect(screen.getByText(/issue_grants: Unknown capabilities: bogus/)).toBeDefined();
  });

  it('links Open in chat to /chat/start?did=<agentDid>', async () => {
    await renderAgentsPage([agent()], [provision()]);

    const link = screen.getByRole('link', { name: 'Open in chat' }) as HTMLAnchorElement;
    expect(link.href).toContain('/start?did=' + encodeURIComponent(AGENT_DID));
  });

  it('only shows a Download bundle button for local placements', async () => {
    await renderAgentsPage([agent()], [provision({ placement: 'local', status: 'envelope_rendered' })]);
    expect(screen.getByRole('button', { name: 'Download bundle' })).toBeDefined();
  });

  it('does not show a Download bundle button for hosted placements', async () => {
    await renderAgentsPage([agent()], [provision({ placement: 'hosted' })]);
    expect(screen.queryByRole('button', { name: 'Download bundle' })).toBeNull();
  });

  it('hides Revoke/Open-in-chat/Download-bundle controls once the provision is revoked', async () => {
    await renderAgentsPage([agent()], [provision({ status: 'revoked', revokedAt: '2026-08-02T00:00:00.000Z', placement: 'local' })]);

    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open in chat' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download bundle' })).toBeNull();
  });
});

describe('revoking a provision', () => {
  it('calls DELETE /auth/api/agents/provision/:id and refreshes', async () => {
    const spy = await renderAgentsPage([agent()], [provision()], {
      '/auth/api/agents/provision/prov_1': async (_url, init) => {
        if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({ revoked: true }) } as unknown as Response;
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('/auth/api/agents/provision/prov_1'),
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(await screen.findByText('Provision revoked.')).toBeDefined();
  });

  it('shows the server error message when revoke fails', async () => {
    await renderAgentsPage([agent()], [provision()], {
      '/auth/api/agents/provision/prov_1': async (_url, init) => {
        if (init?.method === 'DELETE') {
          return { ok: false, status: 403, json: async () => ({ error: 'Only the owning DID may revoke this provision' }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('Only the owning DID may revoke this provision')).toBeDefined();
  });

  it('shows a network error message when the revoke fetch throws', async () => {
    await renderAgentsPage([agent()], [provision()], {
      '/auth/api/agents/provision/prov_1': async (_url, init) => {
        if (init?.method === 'DELETE') throw new Error('network down');
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeDefined();
  });
});

describe('downloading a local-placement bundle', () => {
  it('fetches the bundle and triggers a blob download', async () => {
    const spy = await renderAgentsPage([agent()], [provision({ placement: 'local', status: 'envelope_rendered' })], {
      '/bundle': async () => ({
        ok: true,
        status: 200,
        json: async () => ({ harness: 'nanoclaw', files: [{ relativePath: 'envelope/SOUL.md', content: 'hi' }], manualSteps: [] }),
      } as unknown as Response),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download bundle' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('/auth/api/agents/provision/prov_1/bundle'), expect.anything()),
    );
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('shows an error message when the bundle request fails', async () => {
    await renderAgentsPage([agent()], [provision({ placement: 'local', status: 'envelope_rendered' })], {
      '/bundle': async () => ({ ok: false, status: 400, json: async () => ({ error: "Only placement: 'local' provisions have a downloadable bundle" }) } as unknown as Response),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download bundle' }));

    expect(await screen.findByText(/downloadable bundle/)).toBeDefined();
  });

  it('shows a network error message when the bundle fetch throws', async () => {
    await renderAgentsPage([agent()], [provision({ placement: 'local', status: 'envelope_rendered' })], {
      '/bundle': async () => {
        throw new Error('network down');
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download bundle' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeDefined();
  });
});

describe('Provision agent wizard', () => {
  it('opens and closes via the header button and Cancel', async () => {
    await renderAgentsPage([], []);

    fireEvent.click(screen.getByRole('button', { name: '+ Provision Agent' }));
    expect(screen.getByText('Provision new agent')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Provision new agent')).toBeNull();
  });

  it('disables Provision until a name is entered, and disables the OpenClaw harness option', async () => {
    await renderAgentsPage([], []);
    fireEvent.click(screen.getByRole('button', { name: '+ Provision Agent' }));

    expect(screen.getByRole('button', { name: 'Provision' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'OpenClaw (coming soon)' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Travel Agent' } });
    expect(screen.getByRole('button', { name: 'Provision' })).toHaveProperty('disabled', false);
  });

  it('submits the wizard selections to POST /auth/api/agents/provision', async () => {
    const spy = await renderAgentsPage([], [], {
      '/auth/api/agents/provision': async (url, init) => {
        if (init?.method === 'POST') {
          return { ok: true, status: 201, json: async () => ({ provision: provision({ status: 'awaiting_boot' }) }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ provisions: [] }) } as unknown as Response;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Provision Agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Travel Agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Local (download bundle)' }));
    fireEvent.click(screen.getByRole('button', { name: 'messages:write' }));
    fireEvent.click(screen.getByRole('button', { name: 'Provision' }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('/auth/api/agents/provision'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            servingDid: OWNER,
            name: 'Travel Agent',
            harness: 'nanoclaw',
            placement: 'local',
            scopes: ['messages:write'],
            model: { provider: 'anthropic:claude' },
          }),
        }),
      ),
    );
    expect(await screen.findByText('Agent provisioned.')).toBeDefined();
  });

  it('shows a failure status message when the created provision itself failed', async () => {
    await renderAgentsPage([], [], {
      '/auth/api/agents/provision': async (_url, init) => {
        if (init?.method === 'POST') {
          return { ok: true, status: 201, json: async () => ({ provision: provision({ status: 'failed' }) }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ provisions: [] }) } as unknown as Response;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Provision Agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Travel Agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Provision' }));

    expect(await screen.findByText('Provisioning failed — see step detail below.')).toBeDefined();
  });

  it('surfaces a server-side validation error from the provision endpoint', async () => {
    await renderAgentsPage([], [], {
      '/auth/api/agents/provision': async (_url, init) => {
        if (init?.method === 'POST') {
          return { ok: false, status: 400, json: async () => ({ error: 'Unknown grant capabilities requested: bogus:scope' }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({ provisions: [] }) } as unknown as Response;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Provision Agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Travel Agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Provision' }));

    expect(await screen.findByText('Unknown grant capabilities requested: bogus:scope')).toBeDefined();
  });

  it('shows a network error message when the provision-create fetch throws', async () => {
    await renderAgentsPage([], [], {
      '/auth/api/agents/provision': async (_url, init) => {
        if (init?.method === 'POST') throw new Error('network down');
        return { ok: true, status: 200, json: async () => ({ provisions: [] }) } as unknown as Response;
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Provision Agent' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Travel Agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Provision' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeDefined();
  });
});
