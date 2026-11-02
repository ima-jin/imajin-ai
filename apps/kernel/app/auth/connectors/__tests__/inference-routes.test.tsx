// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { InferenceRoutes } from '../components/InferenceRoutes';
import type { InferenceRoute } from '@/src/lib/inference/route-discovery';

function route(kind: InferenceRoute['kind'] = 'own'): InferenceRoute {
  return {
    kind, billedPrincipal: { did: 'did:imajin:ryan', handle: 'ryan' },
    card: { provider: 'anthropic', id: 'card-personal', label: 'Personal account', loaded: true },
    selectedModels: ['claude-sonnet-5-5'], usable: true, selectors: {},
  };
}
function installFetch(routes: InferenceRoute[]) {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ routes }) });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Inference routes section', () => {
  it('renders personal billing, card identity, loaded state and selected model', async () => {
    const fetch = installFetch([route()]);
    render(<InferenceRoutes />);
    expect(await screen.findByText('Billed to: @ryan')).toBeDefined();
    for (const text of ['Own', 'Usable: yes', 'anthropic · Personal account', 'Selected model: claude-sonnet-5-5']) {
      expect(screen.getByText(text)).toBeDefined();
    }
    expect(screen.getByText(/Card: card-personal · Loaded: yes/)).toBeDefined();
    expect(fetch).toHaveBeenCalledWith('/infer/v1/models/usable?explain=1', expect.objectContaining({ cache: 'no-store' }));
  });
  it('uses the route billing identity in org context, never the personal session handle', async () => {
    const orgRoute = {
      ...route('C'), billedPrincipal: { did: 'did:imajin:artifact', handle: 'artifact' },
      card: { ...route().card, id: 'card-org', label: 'Artifact account' }, selectors: { actingAs: 'did:imajin:artifact' },
    };
    installFetch([orgRoute]);
    render(<InferenceRoutes />);
    expect(await screen.findByText('Billed to: @artifact')).toBeDefined();
    expect(screen.queryByText('Billed to: @ryan')).toBeNull();
    expect(screen.getByText('C · Member grant')).toBeDefined();
    expect(screen.getByText('did:imajin:artifact')).toBeDefined();
  });
  it.each(['A', 'B'] as const)('keeps route %s visually distinct', async kind => {
    installFetch([{ ...route(kind), selectors: { actingFor: 'did:imajin:delegating-member' } }]);
    render(<InferenceRoutes />);
    expect(await screen.findByText(kind === 'A' ? "A · Organization's agent" : "B · Human's agent")).toBeDefined();
    expect(screen.getByText('On behalf of: did:imajin:delegating-member')).toBeDefined();
  });
  it('renders an unusable reason, unloaded status and no-model state', async () => {
    installFetch([{
      ...route(), billedPrincipal: { did: 'did:imajin:nohandle', handle: null },
      card: { ...route().card, loaded: false }, selectedModels: [], usable: false,
      reason: { code: 'key_not_loaded', message: 'Anthropic key not loaded' },
    }]);
    render(<InferenceRoutes />);
    expect(await screen.findByText('Anthropic key not loaded')).toBeDefined();
    expect(screen.getByText('Usable: no')).toBeDefined();
    expect(screen.getByText('Selected model: None')).toBeDefined();
    expect(screen.getByText('Billed to: did:imajin:nohandle')).toBeDefined();
    expect(screen.getByText(/Loaded: no/)).toBeDefined();
  });
  it('shows an empty state', async () => {
    installFetch([]);
    render(<InferenceRoutes />);
    expect(await screen.findByText('No inference routes found for this identity.')).toBeDefined();
  });
  it.each(['http', 'network', 'shape'] as const)('shows a safe %s error without displaying response details', async failure => {
    const fetch = installFetch([]);
    if (failure === 'http') fetch.mockResolvedValue({ ok: false });
    if (failure === 'network') fetch.mockRejectedValue(new Error('private network error'));
    if (failure === 'shape') fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    render(<InferenceRoutes />);
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText('private network error')).toBeNull();
  });
  it('shows loading and cancels a pending request on unmount', () => {
    const fetch = installFetch([]);
    fetch.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<InferenceRoutes />);
    expect(screen.getByText('Loading inference routes…')).toBeDefined();
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
