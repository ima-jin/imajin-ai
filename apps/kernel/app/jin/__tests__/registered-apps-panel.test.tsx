// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RegisteredAppsPanel } from '../registered-apps-panel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const app = {
  id: 'app_fixture', appDid: 'did:imajin:fixture', name: 'BrokerAgent', kind: 'delegated app',
  status: 'active', created: { at: '2026-01-01T00:00:00Z', by: 'registrar' },
  firstConsent: { at: '2026-01-02T00:00:00Z', by: 'principal-a' }, consentingPrincipals: 2,
  lastSeen: '2026-10-21T00:00:00Z', ended: { at: null, by: null },
};
function install(apps: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ apps }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
describe('Registered apps engine bay', () => {
  it('renders kind, status, every provenance field, and live count without controls or mutation requests', async () => {
    const fetchMock = install([app]);
    render(<RegisteredAppsPanel />);
    const panel = await screen.findByRole('region', { name: 'Registered apps' });
    expect(panel.textContent).toContain('BrokerAgent');
    expect(panel.textContent).toContain('delegated app · active');
    expect(panel.textContent).toContain('registrar');
    expect(panel.textContent).toContain('principal-a');
    expect(panel.textContent).toContain('Consenting principals (live) · 2');
    expect(panel.querySelectorAll('time')).toHaveLength(3);
    expect(within(panel).queryAllByRole('button')).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith('/jin/api/registered-apps', expect.objectContaining({
      credentials: 'include', cache: 'no-store',
    }));
    expect(fetchMock.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true);
  });
  it('shows zero-consent seeds, DCR, dormant and revoked apps; preserves expired rows in a collapsed group', async () => {
    install([
      { ...app, kind: 'first-party seed', status: 'dormant', firstConsent: { at: null, by: null }, consentingPrincipals: 0 },
      { ...app, id: 'dcr', name: 'MCP', kind: 'MCP/DCR client' },
      { ...app, id: 'revoked', name: 'Retired', status: 'revoked', ended: { at: app.lastSeen, by: 'operator' } },
      { ...app, id: 'expired', name: 'Expired client', status: 'expired', ended: { at: app.lastSeen, by: 'expiry signer' } },
    ]);
    const { container } = render(<RegisteredAppsPanel />);
    await screen.findByText('first-party seed · dormant');
    expect(screen.getByText(/none recorded/)).toBeDefined();
    expect(screen.getByText('MCP/DCR client · active')).toBeDefined();
    expect(screen.getByText('operator')).toBeDefined();
    const group = container.querySelector('details')!;
    expect(group.open).toBe(false);
    expect(within(group).getByText('Expired client')).toBeDefined();
    fireEvent.click(within(group).getByText('expired (1)'));
    expect(group.open).toBe(true);
    expect(within(group).getByText('expiry signer')).toBeDefined();
  });
  it.each([401, 403])('hides all operator metadata on HTTP %s', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
    const { container } = render(<RegisteredAppsPanel />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
  it('clears metadata on identity switch and ignores a stale in-flight response', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = install([app]);
    render(<RegisteredAppsPanel />);
    await screen.findByText('BrokerAgent');
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    fireEvent(globalThis, new Event('imajin:session-changed'));
    expect(screen.queryByText('BrokerAgent')).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    fireEvent(globalThis, new Event('imajin:session-changed'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    finish(Response.json({ apps: [app] }));
    await waitFor(() => expect(screen.queryByText('BrokerAgent')).toBeNull());
  });
  it.each([
    null, {}, { apps: null }, { apps: [null] },
    ...[
      { kind: 'unknown' }, { status: 'pending' }, { name: 1 }, { appDid: null }, { id: null },
      { created: null }, { firstConsent: { at: 'invalid', by: null } }, { ended: { at: null, by: 1 } },
      { consentingPrincipals: -1 }, { consentingPrincipals: 1.5 }, { lastSeen: 'invalid' },
    ].map(change => ({ apps: [{ ...app, ...change }] })),
  ])('fails closed on malformed metadata: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    render(<RegisteredAppsPanel />);
    await screen.findByRole('alert');
    expect(screen.queryByText('BrokerAgent')).toBeNull();
  });
  it.each(['network', 'http'])('reports %s failures and handles empty inventory', async failure => {
    const fetchMock = vi.fn();
    if (failure === 'network') fetchMock.mockRejectedValue(new Error('offline'));
    else fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<RegisteredAppsPanel />);
    await screen.findByRole('alert');
    fetchMock.mockResolvedValue(Response.json({ apps: [] }));
    fireEvent(globalThis, new Event('imajin:session-changed'));
    await screen.findByText('No registered apps.');
  });
});
