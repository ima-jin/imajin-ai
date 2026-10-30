// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RegisteredAppsPanel } from '../registered-apps-panel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const app = {
  id: 'app_fixture', appDid: 'did:imajin:fixture', name: 'BrokerAgent', kind: 'delegated app',
  status: 'active', created: { at: '2026-01-01T00:00:00Z', by: 'registrar' },
  firstConsent: { at: '2026-01-02T00:00:00Z', by: 'principal-a' }, consentingPrincipals: 2, liveConsents: 3,
  lastSeen: '2026-10-21T00:00:00Z', ended: { at: null, by: null },
  revocationId: null,
};
function install(apps: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ apps }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
describe('Registered apps engine bay', () => {
  it('renders provenance and a Clear control without mutating before confirmation', async () => {
    const fetchMock = install([app]);
    render(<RegisteredAppsPanel />);
    const panel = await screen.findByRole('region', { name: 'Registered apps' });
    expect(panel.textContent).toContain('BrokerAgent');
    expect(panel.textContent).toContain('delegated app · active');
    expect(panel.textContent).toContain('registrar');
    expect(panel.textContent).toContain('principal-a');
    expect(panel.textContent).toContain('Consenting principals (live) · 2');
    expect(panel.querySelectorAll('time')).toHaveLength(3);
    expect(within(panel).getByRole('button', { name: 'Clear' })).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith('/jin/api/registered-apps', expect.objectContaining({
      credentials: 'include', cache: 'no-store',
    }));
    expect(fetchMock.mock.calls.every(([, init]) => !init.method || init.method === 'GET')).toBe(true);
  });
  it('keeps only active and dormant apps in the main list and collapses expired and revoked history', async () => {
    install([
      { ...app, kind: 'first-party seed', status: 'dormant', firstConsent: { at: null, by: null }, consentingPrincipals: 0 },
      { ...app, id: 'dcr', name: 'MCP', kind: 'MCP/DCR client' },
      { ...app, id: 'revoked', name: 'Retired', status: 'revoked', ended: { at: app.lastSeen, by: 'operator' } },
      { ...app, id: 'revoked-second', name: 'Retired seed', kind: 'first-party seed', status: 'revoked' },
      { ...app, id: 'expired', name: 'Expired client', status: 'expired', ended: { at: app.lastSeen, by: 'expiry signer' } },
    ]);
    const { container } = render(<RegisteredAppsPanel />);
    await screen.findByText('first-party seed · dormant');
    expect(screen.getByText(/none recorded/)).toBeDefined();
    expect(screen.getByText('MCP/DCR client · active')).toBeDefined();
    const mainList = container.querySelector('section > ul')!;
    expect(within(mainList).getAllByRole('listitem')).toHaveLength(2);
    expect(within(mainList).queryByText('Retired')).toBeNull();
    expect(within(mainList).queryByText('Retired seed')).toBeNull();
    expect(within(mainList).queryByText('Expired client')).toBeNull();
    const group = screen.getByText('expired (1)').closest('details')!;
    expect(group.open).toBe(false);
    expect(within(group).getByText('Expired client')).toBeDefined();
    fireEvent.click(within(group).getByText('expired (1)'));
    expect(group.open).toBe(true);
    expect(within(group).getByText('expiry signer')).toBeDefined();
    expect(within(group).queryByRole('button', { name: 'Clear' })).toBeNull();
    const revoked = screen.getByText('revoked (2)').closest('details')!;
    expect(revoked.open).toBe(false);
    expect(revoked.className).toBe(group.className);
    expect(revoked.querySelector('summary')!.className).toBe(group.querySelector('summary')!.className);
    fireEvent.click(within(revoked).getByText('revoked (2)'));
    expect(revoked.open).toBe(true);
    expect(within(revoked).getAllByRole('listitem')).toHaveLength(2);
    expect(within(revoked).getByText('Retired seed')).toBeDefined();
    const row = within(revoked).getByText('Retired').closest('li')!;
    expect(row.textContent).toContain('delegated app · revoked');
    expect(row.textContent).toContain('did:imajin:fixture');
    expect(row.textContent).toContain('Created · registrar · 2026-01-01T00:00:00Z · registrar');
    expect(row.textContent).toContain('First consent · by · 2026-01-02T00:00:00Z · principal-a');
    expect(row.textContent).toContain('Consenting principals (live) · 2');
    expect(row.textContent).toContain(`Last seen · ${app.lastSeen}`);
    expect(row.textContent).toContain(`revoked · ${app.lastSeen} · operator`);
    expect(within(revoked).queryByRole('button', { name: 'Clear' })).toBeNull();
    fireEvent.click(within(revoked).getByText('revoked (2)'));
    expect(revoked.open).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Clear' })).toHaveLength(2);
  });
  it.each([
    { apps: [] }, { apps: [app] }, { apps: [{ ...app, status: 'expired' }] },
  ])('omits the revoked section when none are revoked: %j', async ({ apps }) => {
    install(apps);
    render(<RegisteredAppsPanel />);
    const panel = await screen.findByRole('region', { name: 'Registered apps' });
    expect(within(panel).queryByText(/^revoked \(\d+\)$/)).toBeNull();
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
      { liveConsents: -1 }, { liveConsents: 1.5 }, { liveConsents: null }, { revocationId: 1 },
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
  it.each([0, 1, 3])('names the app and %s live consents in confirmation; cancel sends no POST', async liveConsents => {
    const fetchMock = install([{ ...app, liveConsents }]);
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    render(<RegisteredAppsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(confirm).toHaveBeenCalledWith(`Clear BrokerAgent? This will end ${liveConsents} live consent${liveConsents === 1 ? '' : 's'}. The app and its history will be kept.`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(['active', 'dormant'])('posts %s Clear to the existing route, retains the row and exposes its receipt', async status => {
    const fetchMock = install([{ ...app, status }]);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<RegisteredAppsPanel />);
    const button = await screen.findByRole('button', { name: 'Clear' });
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true, attestationId: 'att_revoked' }))
      .mockResolvedValue(Response.json({ apps: [{
        ...app, status: 'revoked', ended: { at: app.lastSeen, by: 'operator' }, revocationId: 'att_revoked',
      }] }));
    fireEvent.click(button);
    await screen.findByText('delegated app · revoked');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/registry/apps/app_fixture/revoke',
      expect.objectContaining({ method: 'POST', credentials: 'include' }));
    const group = screen.getByText('revoked (1)').closest('details')!;
    expect(group.open).toBe(false);
    fireEvent.click(within(group).getByText('revoked (1)'));
    expect(group.open).toBe(true);
    const row = within(group).getByText('BrokerAgent').closest('li')!;
    expect(row.textContent).toContain(`revoked · ${app.lastSeen} · operator`);
    expect(within(row).queryByRole('button', { name: 'Clear' })).toBeNull();
    const receipt = within(row).getByText('registry.app.revoked').closest('details')!;
    fireEvent.click(within(receipt).getByText('registry.app.revoked'));
    expect(receipt.open).toBe(true);
    expect(receipt.textContent).toContain('att_revoked');
    expect(within(receipt).getByRole('link', { name: 'View signed attestation' }).getAttribute('href'))
      .toBe('/auth/api/attestations?subject_did=did%3Aimajin%3Afixture&type=registry.app.revoked');
    expect(fetchMock.mock.calls.every(([, init]) => init.method !== 'DELETE')).toBe(true);
  });
  it('encodes app ids and suppresses repeated taps while a mutation is in flight', async () => {
    const fetchMock = install([{ ...app, id: 'app/slash' }]);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<RegisteredAppsPanel />);
    const button = await screen.findByRole('button', { name: 'Clear' });
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(button); fireEvent.click(button);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/admin/registry/apps/app%2Fslash/revoke');
  });
  it.each(['network', 'http'])('does not optimistically revoke on %s failure', async failure => {
    const fetchMock = install([app]);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<RegisteredAppsPanel />);
    const button = await screen.findByRole('button', { name: 'Clear' });
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('private failure'));
    else fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fireEvent.click(button);
    await screen.findByRole('alert');
    expect(screen.getByText('delegated app · active')).toBeDefined();
    expect(screen.queryByText(/private failure/)).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  it.each([401, 403])('removes Clear when permission expires during a POST (%s)', async status => {
    const fetchMock = install([app]);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<RegisteredAppsPanel />);
    const button = await screen.findByRole('button', { name: 'Clear' });
    fetchMock.mockResolvedValue(new Response(null, { status }));
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Registered apps' })).toBeNull());
  });
  it('aborts an in-flight Clear on identity switch and ignores its late result', async () => {
    const fetchMock = install([app]);
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    render(<RegisteredAppsPanel />);
    const button = await screen.findByRole('button', { name: 'Clear' });
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    fireEvent.click(button);
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    fireEvent(globalThis, new Event('imajin:session-changed'));
    expect(signal.aborted).toBe(true);
    finish(Response.json({ ok: true }));
    await waitFor(() => expect(screen.queryByText('BrokerAgent')).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
