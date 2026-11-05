// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentIdentityPanel } from '../agent-identity-panel';
import { AgentIdentityCard, type OperatorIdentityCard } from '../agent-identity-card';
import { discoveryInferenceRoutes } from '@/src/lib/inference/self-discovery';

const acting = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
vi.mock('@imajin/ui/server', () => ({ getActingAsHeaders: () => acting.headers }));

const org = 'did:imajin:artifact';
const card: OperatorIdentityCard = {
  name: 'Artifact-Jin',
  identity: { did: 'did:imajin:artifact-jin', handle: 'artifact-jin', kind: 'agent', tier: 'established', actAs: org },
  usableModels: [],
  connectors: [{
    provider: 'anthropic', family: 'anthropic', authority: 'org-held', kind: 'A',
    billedPrincipal: { did: org, handle: 'artifact' }, card: { id: 'held', label: 'Anthropic' },
    configured: false, grantStatus: 'not-evaluated', selectedModels: [], usableModels: [],
    usable: false, selectors: { actingAs: org },
    reason: { code: 'key_not_loaded', message: 'Organization key unavailable' },
    fix: { control: 'Org service keys → Load key', href: '/auth/connectors', actingDid: org },
  }],
};
const body = { principalDid: org, cards: [card] };
function install(value: unknown = body) {
  const mock = vi.fn().mockImplementation(async () => Response.json(value));
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); acting.headers = {}; });

describe('/jin agent identity cards', () => {
  it('renders Artifact-Jin with org-held Anthropic, grant state, live check, grade and a red-row control', async () => {
    const mock = install();
    acting.headers = { 'X-Acting-As': org };
    render(<AgentIdentityPanel />);
    const article = await screen.findByRole('article', { name: 'Identity card for Artifact-Jin' });
    expect(article.textContent).toContain('DID: did:imajin:artifact-jin');
    expect(article.textContent).toContain('Handle: artifact-jin');
    expect(article.textContent).toContain('Kind: agent');
    expect(article.textContent).toContain('Tier: established');
    expect(article.textContent).toContain(`Acts as organization: ${org}`);
    expect(article.textContent).toContain('anthropic · anthropic');
    expect(article.textContent).toContain('Authority / scope: org-held');
    expect(article.textContent).toContain(`Config owner / billed DID: ${org}`);
    expect(article.textContent).toContain('Grant state: not-evaluated');
    expect(article.textContent).toContain('Live check: Unavailable');
    expect(article.textContent).toContain('Grade: Unverified');
    expect(article.querySelector('li')?.className).toContain('border-red-800');
    expect(within(article).getByRole('link', { name: 'Org service keys → Load key' }).getAttribute('href')).toBe('/auth/connectors');
    expect(article.textContent).toContain(`Use acting identity: ${org}`);
    expect(article.textContent).toContain('Host / channels: Unknown');
    expect(article.textContent).toContain('Outbound identity: Unknown');
    expect(article.textContent).toContain('not an agent-signed card');
    expect(article.textContent).not.toContain('Observed live');
    expect(mock).toHaveBeenCalledWith('/infer/v1/self?agents=1', expect.objectContaining({
      credentials: 'include', cache: 'no-store', headers: { 'X-Acting-As': org },
    }));
    expect(mock.mock.calls).toHaveLength(1);
  });
  it('shows configured usability as config evidence, never as observed outbound identity', () => {
    render(<AgentIdentityCard card={{ ...card, connectors: [{
      ...card.connectors[0], configured: true, usable: true, grantStatus: 'not-required', usableModels: ['model-one'],
    }] }} />);
    expect(screen.getByText('From config')).toBeDefined();
    expect(screen.getByText('Usable')).toBeDefined();
    expect(screen.getByText('model-one')).toBeDefined();
    expect(screen.getByText(/Uses another principal/)).toBeDefined();
  });
  it.each(['A', 'C'] as const)('links private-custody org-held route %s to renewal, never delegation-grant', async kind => {
    // Both org-held lanes use private custody. Use the real discovery projection,
    // not a hand-authored repair href; custody field references never reach the UI.
    const connectors = discoveryInferenceRoutes([{
      kind, billedPrincipal: { did: org, handle: 'artifact' },
      card: { id: 'private-held', provider: 'anthropic', label: 'Anthropic', loaded: false },
      selectedModels: [], usable: false, selectors: { actingAs: org },
      reason: { code: 'key_not_loaded', message: 'Organization key unavailable' },
    }], [], { ownerDid: org, caller: { actorDid: card.identity.did, actingAs: org } });
    const mock = install({ ...body, cards: [{ ...card, connectors }] });
    acting.headers = { 'X-Acting-As': org };
    render(<AgentIdentityPanel />);
    const article = await screen.findByRole('article', { name: 'Identity card for Artifact-Jin' });
    const repair = within(article).getByRole('link', { name: 'Renew org-held key' });
    expect(repair.getAttribute('href')).toBe(`/jin/vault/renew?orgDid=${encodeURIComponent(org)}&provider=anthropic`);
    expect(article.textContent).toContain(`Use acting identity: ${org}`);
    expect(within(article).queryByRole('button', { name: /re-?grant|renew/i })).toBeNull();
    expect(within(article).queryByRole('link', { name: /load|replace|re-?grant/i })).toBeNull();
    expect(within(article).getAllByRole('link').every(link =>
      !link.getAttribute('href')?.includes('/api/vault/delegation'))).toBe(true);
    expect(mock.mock.calls.every(([url, init]) =>
      url === '/infer/v1/self?agents=1' && (!init.method || init.method === 'GET'))).toBe(true);
  });
  it('supports metadata-only rows without asserting usable authority', () => {
    render(<AgentIdentityCard card={{ ...card, name: null, identity: { ...card.identity, handle: null, actAs: null }, connectors: [{
      provider: 'github', family: 'http', authority: null, configured: true, ownerDid: card.identity.did,
      grantStatus: 'not-evaluated', usable: null, usableModels: [],
      configurationStatus: 'configured', authorizedScopes: [], credentialStatus: 'not-probed',
      fix: { control: 'Configure GitHub', href: '/auth/connectors/github', actingDid: card.identity.did },
    }] }} />);
    expect(screen.getByRole('article', { name: `Identity card for ${card.identity.did}` })).toBeDefined();
    expect(screen.getByText('Not evaluated')).toBeDefined();
    expect(screen.queryByText(/Uses another principal/)).toBeNull();
  });
  it.each([false, true])('renders MCP/HTTP authorization without claiming a credential probe (authorized: %s)', authorized => {
    render(<AgentIdentityCard card={{ ...card, connectors: [{
      provider: 'warp', family: 'http', authority: authorized ? 'org-held' : null,
      ownerDid: org, configured: authorized, configurationStatus: authorized ? 'configured' : 'not-disclosed',
      grantStatus: authorized ? 'granted' : 'denied', usable: authorized, usableModels: [],
      authorizedScopes: authorized ? ['warp:dispatch'] : [], credentialStatus: 'not-probed',
      ...(!authorized ? {
        reason: { code: 'service_not_allowed', message: 'Service access unavailable' },
        fix: { control: 'Agents → assignment and allowed services', href: '/auth/agents', actingDid: org },
      } : {}),
    }] }} />);
    expect(screen.getByText('Tool authorization:')).toBeDefined();
    expect(screen.getByText('Not probed — authorization metadata only')).toBeDefined();
    expect(screen.queryByText('Live check:')).toBeNull();
    if (authorized) {
      expect(screen.getByText('Usable')).toBeDefined();
      expect(screen.getByText('From config')).toBeDefined();
    } else {
      expect(screen.getByText('Not disclosed')).toBeDefined();
      expect(screen.getByRole('link', { name: /assignment and allowed services/ }).getAttribute('href')).toBe('/auth/agents');
      expect(screen.getByText(`Use acting identity: ${org}`)).toBeDefined();
    }
  });
  it('uses the returned personal principal and does not select an org implicitly', async () => {
    const mock = install({ principalDid: 'did:imajin:personal', cards: [{ ...card, name: null, identity: { ...card.identity, actAs: null } }] });
    render(<AgentIdentityPanel />);
    await screen.findByText('Principal: did:imajin:personal');
    expect(screen.getByRole('article', { name: 'Identity card for artifact-jin' })).toBeDefined();
    expect(mock.mock.calls[0][1].headers).toEqual({});
  });
  it.each([401, 403])('hides metadata and controls on HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    const { container } = render(<AgentIdentityPanel />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
  it.each([null, {}, { cards: null }, { cards: [], principalDid: 1 }])('fails closed for invalid response %j', async value => {
    install(value);
    render(<AgentIdentityPanel />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('article')).toBeNull();
  });
  it.each(['http', 'network'])('clears stale data on %s error and can retry', async failure => {
    const mock = install();
    render(<AgentIdentityPanel />);
    await screen.findByRole('article');
    if (failure === 'http') mock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    else mock.mockRejectedValueOnce(new Error('private failure'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh identity cards' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText('private failure')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh identity cards' }));
    await screen.findByRole('article');
  });
  it('removes old cards on org switch and ignores a late response from the previous context', async () => {
    const mock = install();
    render(<AgentIdentityPanel />);
    await screen.findByRole('article');
    let finish!: (value: Response) => void;
    mock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    fireEvent(globalThis, new Event('imajin:session-changed'));
    expect(screen.queryByRole('article')).toBeNull();
    acting.headers = { 'X-Acting-As': 'did:imajin:other-org' };
    mock.mockResolvedValueOnce(Response.json({ principalDid: 'did:imajin:other-org', cards: [] }));
    fireEvent(globalThis, new Event('imajin:acting-as-changed'));
    await screen.findByText('No agents bound to this principal.');
    finish(Response.json(body));
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
    expect(mock.mock.calls.at(-1)?.[1].headers).toEqual(acting.headers);
  });
  it('refreshes on window focus to reflect a grant repaired on another page', async () => {
    const mock = install();
    render(<AgentIdentityPanel />);
    await screen.findByRole('article');
    mock.mockResolvedValueOnce(Response.json({ ...body, cards: [{
      ...card, connectors: [{ ...card.connectors[0], usable: true, configured: true, grantStatus: 'not-required', reason: undefined, fix: undefined }],
    }] }));
    fireEvent(globalThis, new Event('focus'));
    await screen.findByText('Usable');
    expect(screen.queryByText('Organization key unavailable')).toBeNull();
  });
  it('explains an empty connector projection and links to existing configuration', () => {
    render(<AgentIdentityCard card={{ ...card, connectors: [] }} />);
    expect(screen.getByRole('link', { name: 'Configure connectors' }).getAttribute('href')).toBe('/auth/connectors');
  });
});
